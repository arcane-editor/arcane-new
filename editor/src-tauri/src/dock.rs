//! macOS dock right-click menu with a single "New Window" item.
//!
//! # Why a hand-rolled objc2 shim
//!
//! There is no first-party dock-menu API in the versions this app pins:
//! tauri 2.10 only exposes `App::set_dock_visibility`, and neither tao 0.34
//! nor muda 0.17 implement (or let us implement) `NSApplicationDelegate`'s
//! optional `- (NSMenu *)applicationDockMenu:(NSApplication *)sender` hook.
//! tao owns the one and only `NSApplication` delegate instance, so we cannot
//! swap in our own delegate. Instead, at startup we add the
//! `applicationDockMenu:` method to the *running delegate's class* via the
//! Objective-C runtime (`class_addMethod`) and return a static `NSMenu`.
//!
//! The menu item's target/action points at a small `DockMenuTarget` object
//! (an `NSObject` subclass defined with `define_class!`) whose `newWindow:`
//! action opens or focuses the welcome window.
//!
//! # Thread & lifetime model
//!
//! - `install_dock_menu` runs inside Tauri's `.setup()`, which executes on the
//!   main (AppKit) thread. tao has already created and installed the app
//!   delegate by then (it does so in `EventLoop::new`, before setup runs).
//! - `applicationDockMenu:` and menu actions are AppKit delegate callbacks and
//!   are therefore always delivered on the main thread.
//! - The menu, its item, and the target must outlive the whole app (AppKit
//!   holds only a weak/unretained reference to a menu item's target). We keep
//!   them in `OnceLock` statics; they intentionally live for the process
//!   lifetime.
//!
//! Nothing here may panic: it is startup / callback code crossing an FFI
//! boundary, so every failure path logs and returns.

use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, NSObjectProtocol, Sel};
use objc2::{define_class, msg_send, sel, AnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::NSString;

use tauri::AppHandle;

/// The `AppHandle` used by the `newWindow:` action. Set once in
/// `install_dock_menu`. `AppHandle` is `Send + Sync`, so a plain static is
/// fine; the action itself always runs on the main thread anyway.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Keeps the target object alive for the process lifetime. `NSMenuItem` holds
/// its target weakly/unretained, so if we dropped this the action would fire
/// against a dead pointer.
static DOCK_TARGET: OnceLock<Retained<DockMenuTarget>> = OnceLock::new();

/// Keeps the dock `NSMenu` alive for the process lifetime and hands its raw
/// pointer back from `applicationDockMenu:`.
static DOCK_MENU: OnceLock<MenuHolder> = OnceLock::new();

/// Wrapper so a main-thread-only `Retained<NSMenu>` can live in a static.
///
/// `NSMenu` is `MainThreadOnly`, hence not `Send`/`Sync`. This wrapper asserts
/// those traits manually; it is sound because the menu is only ever created
/// (in `install_dock_menu`) and read (in the `applicationDockMenu:` imp) on the
/// main thread — both are main-thread AppKit contexts — and is never mutated
/// after construction.
struct MenuHolder(Retained<NSMenu>);

// SAFETY: see `MenuHolder`'s doc comment — the wrapped `NSMenu` is confined to
// the main thread in practice; these impls only exist to let it sit in a
// `static`, which is never accessed from another thread.
unsafe impl Send for MenuHolder {}
unsafe impl Sync for MenuHolder {}

define_class!(
    // SAFETY:
    // - The superclass `NSObject` has no subclassing requirements.
    // - `DockMenuTarget` does not implement `Drop`.
    // We intentionally do NOT set `#[thread_kind = MainThreadOnly]`: the object
    // holds no ivars and touches only `Send + Sync` state (the `AppHandle`
    // static + Tauri APIs), so leaving it thread-agnostic makes
    // `Retained<DockMenuTarget>` `Send + Sync` and thus storable in a static.
    // Its one method is still only ever invoked on the main thread by AppKit.
    #[unsafe(super(objc2::runtime::NSObject))]
    #[name = "UnityIDEDockMenuTarget"]
    struct DockMenuTarget;

    impl DockMenuTarget {
        /// Action fired by the "New Window" dock menu item. AppKit sends this
        /// on the main thread. Never panics: it just reads the `AppHandle`
        /// static and delegates to `open_or_focus_welcome`.
        #[unsafe(method(newWindow:))]
        fn new_window(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP_HANDLE.get() {
                crate::open_or_focus_welcome(app);
            } else {
                eprintln!("[dock] newWindow: fired before AppHandle was set");
            }
        }
    }

    // The base NSObject protocol; harmless marker so AppKit's introspection
    // (`respondsToSelector:`, etc.) is well-typed. NSObject supplies the impls.
    unsafe impl NSObjectProtocol for DockMenuTarget {}
);

impl DockMenuTarget {
    /// Allocate + init a target. No ivars, so `NSObject`'s designated
    /// initializer is sufficient.
    fn new() -> Retained<Self> {
        // `set_ivars(())` installs the (empty) ivars and yields a
        // `PartialInit<Self>`, which must be finished by chaining to the
        // superclass initializer.
        // SAFETY: `Self::alloc()` yields a fresh, uninitialized instance of
        // this class; `super(...) init` is `NSObject`'s designated
        // initializer, and there are no ivars requiring further setup. The
        // result is a valid, owned `Retained<Self>`.
        unsafe { msg_send![super(Self::alloc().set_ivars(())), init] }
    }
}

/// The `applicationDockMenu:` implementation we splice onto tao's app-delegate
/// class. Objective-C type encoding: `@@:@` (returns `id`; args are `self`,
/// `_cmd`, and the `NSApplication *sender`).
///
/// Declared `extern "C"` (not `-unwind`): should the body ever panic, the
/// process aborts at this boundary rather than unwinding into Objective-C
/// (which would be UB). The body cannot actually panic — it only reads a
/// `OnceLock` and returns a pointer.
extern "C" fn application_dock_menu(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> *mut NSMenu {
    match DOCK_MENU.get() {
        // +0 borrow: AppKit retains the returned menu while it displays it; we
        // keep our owning reference in the static, so this pointer stays valid.
        Some(holder) => Retained::as_ptr(&holder.0) as *mut NSMenu,
        None => std::ptr::null_mut(),
    }
}

/// Install the dock right-click menu. Call once, from Tauri's `.setup()` on the
/// main thread. Every failure path logs and returns; it never panics.
pub fn install_dock_menu(app: &AppHandle) {
    // Make the AppHandle available to the `newWindow:` action.
    let _ = APP_HANDLE.set(app.clone());

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[dock] install_dock_menu must run on the main thread; skipping");
        return;
    };

    // Build (once) the target object and the menu, keeping both alive forever.
    let target = DOCK_TARGET.get_or_init(DockMenuTarget::new);
    DOCK_MENU.get_or_init(|| {
        let menu = NSMenu::new(mtm);
        let item = NSMenuItem::new(mtm);
        item.setTitle(&NSString::from_str("New Window"));
        // SAFETY: `newWindow:` is implemented on `DockMenuTarget`, and the
        // target is stored in `DOCK_TARGET` for the process lifetime, so the
        // unretained target reference AppKit stores can never dangle. The
        // selector and target types are correct for a menu action.
        let target_ref: &AnyObject = target.as_ref();
        unsafe {
            item.setTarget(Some(target_ref));
            item.setAction(Some(sel!(newWindow:)));
        }
        menu.addItem(&item);
        MenuHolder(menu)
    });

    // Locate the running NSApplication delegate and its runtime class.
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = ns_app.delegate() else {
        eprintln!("[dock] no NSApplication delegate present; dock menu not installed");
        return;
    };
    let delegate_obj: &AnyObject = delegate.as_ref();
    let delegate_class: &AnyClass = delegate_obj.class();

    // RUNTIME GUARD: never override an existing `applicationDockMenu:`.
    // `instance_method` (class_getInstanceMethod) walks self + superclasses, so
    // this bails if any class in the chain already implements the selector.
    if delegate_class
        .instance_method(sel!(applicationDockMenu:))
        .is_some()
    {
        eprintln!(
            "[dock] delegate class '{}' already implements applicationDockMenu:; not overriding",
            delegate_class.name().to_string_lossy()
        );
        return;
    }

    // Type-erase our imp into the runtime's `Imp` (unsafe extern "C-unwind"
    // fn()); `class_addMethod` supplies the real `self`/`_cmd`/`sender` args
    // at call time per the `@@:@` encoding.
    // SAFETY: all function pointers are the same size; the erased pointer is
    // only ever invoked by the runtime with the exact signature declared on
    // `application_dock_menu` (matching the `@@:@` type encoding below).
    let imp: Imp = unsafe {
        std::mem::transmute::<
            extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu,
            Imp,
        >(application_dock_menu)
    };

    // `@@:@` = return id, self id, SEL, arg id. NUL-terminated for C.
    let types = b"@@:@\0";

    // SAFETY: `delegate_class` is a live, registered class (the app delegate is
    // alive for the app's lifetime). We verified above it does not already
    // implement this selector, so `class_addMethod` will add — never silently
    // clobber — the method. `imp` has the ABI/signature matching `types`, and
    // `types` is a valid NUL-terminated encoding string. Casting away `const`
    // is required by the C API, which mutates the class's method table.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            delegate_class as *const AnyClass as *mut AnyClass,
            sel!(applicationDockMenu:),
            imp,
            types.as_ptr().cast(),
        )
    };

    if !added.as_bool() {
        eprintln!("[dock] class_addMethod(applicationDockMenu:) failed; dock menu not installed");
    }
}
