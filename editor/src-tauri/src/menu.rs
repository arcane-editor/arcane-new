// macOS native menu bar.
// Items emit Tauri events; the JS side listens and dispatches the
// matching command via the existing command registry.

use tauri::{
    menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, Wry,
};

#[cfg(target_os = "macos")]
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_handle = app.clone();
    let pkg_info = app_handle.package_info();
    let about = PredefinedMenuItem::about(
        &app_handle,
        Some("About UnityIDE"),
        Some(AboutMetadata {
            name: Some(pkg_info.name.clone()),
            version: Some(pkg_info.version.to_string()),
            ..Default::default()
        }),
    )?;

    // App menu
    let app_submenu = SubmenuBuilder::new(&app_handle, &pkg_info.name)
        .item(&about)
        .separator()
        .item(&PredefinedMenuItem::services(&app_handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(&app_handle, None)?)
        .item(&PredefinedMenuItem::hide_others(&app_handle, None)?)
        .item(&PredefinedMenuItem::show_all(&app_handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(&app_handle, None)?)
        .build()?;

    // File menu
    let new_file = MenuItemBuilder::with_id("file.new", "New File")
        .accelerator("CmdOrCtrl+N")
        .build(&app_handle)?;
    let new_window = MenuItemBuilder::with_id("file.newWindow", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(&app_handle)?;
    let open_folder = MenuItemBuilder::with_id("file.openFolder", "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(&app_handle)?;
    let open_recent = MenuItemBuilder::with_id("file.openRecent", "Open Recent…")
        .build(&app_handle)?;
    let save_file = MenuItemBuilder::with_id("file.save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(&app_handle)?;
    let close_tab = MenuItemBuilder::with_id("file.closeTab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(&app_handle)?;
    let close_all_tabs = MenuItemBuilder::with_id("tab.closeAll", "Close All Tabs")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(&app_handle)?;
    // CmdOrCtrl+Shift+T belongs to this command in the JS registry
    // (`tab.reopenClosed` in App.tsx). The native menu used to give the chord
    // to the theme picker, and on macOS the native menu wins — so the same
    // chord reopened a closed tab on Windows and opened the theme picker on
    // macOS. `keybinding-parity.test.ts` now fails on any such divergence.
    let reopen_closed_tab = MenuItemBuilder::with_id("tab.reopenClosed", "Reopen Closed Tab")
        .accelerator("CmdOrCtrl+Shift+T")
        .build(&app_handle)?;
    let file_submenu = SubmenuBuilder::new(&app_handle, "File")
        .item(&new_file)
        .item(&new_window)
        .separator()
        .item(&open_folder)
        .item(&open_recent)
        .separator()
        .item(&save_file)
        .separator()
        .item(&close_tab)
        .item(&close_all_tabs)
        .item(&reopen_closed_tab)
        .build()?;

    // Edit menu
    let edit_submenu = SubmenuBuilder::new(&app_handle, "Edit")
        .item(&PredefinedMenuItem::undo(&app_handle, None)?)
        .item(&PredefinedMenuItem::redo(&app_handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(&app_handle, None)?)
        .item(&PredefinedMenuItem::copy(&app_handle, None)?)
        .item(&PredefinedMenuItem::paste(&app_handle, None)?)
        .item(&PredefinedMenuItem::select_all(&app_handle, None)?)
        .build()?;

    // View menu
    let toggle_left = MenuItemBuilder::with_id("view.toggleSidebar", "Toggle Left Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(&app_handle)?;
    let toggle_right = MenuItemBuilder::with_id("view.toggleRightSidebar", "Toggle Right Sidebar")
        .accelerator("CmdOrCtrl+K")
        .build(&app_handle)?;
    // id/label/accelerator must track `terminal.toggle`, not
    // `view.toggleBottomPanel`: this branch moved `mod+j` to the command that
    // spawns the first terminal and left `view.toggleBottomPanel` unbound in
    // the JS command registry (App.tsx) so exactly one command owns the
    // chord. But the native menu's accelerator is registered with the OS
    // independently of that registry — `handle_menu_event` below just emits
    // this item's id and the frontend calls `executeCommand(id)` on it
    // directly, bypassing the keybinding lookup entirely. Leaving the id as
    // `view.toggleBottomPanel` would let macOS's menu keep answering Cmd+J
    // with the plain visibility flip, and — since `mod+`` ` was also removed
    // — `terminal.toggle` would have no keyboard chord at all on macOS.
    let toggle_terminal = MenuItemBuilder::with_id("terminal.toggle", "Toggle Terminal")
        .accelerator("CmdOrCtrl+J")
        .build(&app_handle)?;
    let cmd_palette = MenuItemBuilder::with_id("palette.commands", "Command Palette")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(&app_handle)?;
    let quick_open = MenuItemBuilder::with_id("palette.quickOpen", "Quick Open File…")
        .accelerator("CmdOrCtrl+P")
        .build(&app_handle)?;
    // No accelerator: CmdOrCtrl+Shift+T is Reopen Closed Tab (see the File
    // menu). The theme picker stays reachable from this menu and the command
    // palette, which is enough for something used once a month.
    let theme_picker = MenuItemBuilder::with_id("theme.openPicker", "Color Theme…")
        .build(&app_handle)?;
    // Window zoom. These MUST stay in step with `view.zoom*` in App.tsx —
    // `keybinding-parity.test.ts` normalises `=`/`-` against the registry's
    // `equal`/`minus` spelling so a divergence here fails the suite.
    //
    // muda parses the key half of an accelerator from a fixed token list
    // (accelerator.rs: "EQUAL" | "=", "MINUS" | "-", "DIGIT0" | "0"), and
    // there is no "PLUS" token — so zoom-in is spelled `=`, matching how
    // every other editor labels it. The shifted variant (Cmd+Shift+=, i.e.
    // what "Cmd +" actually is on a US layout) is deliberately NOT a menu
    // accelerator: macOS matches key equivalents exactly, so it falls through
    // to the webview and the command's `extraKeybindings` answers it there.
    let zoom_in = MenuItemBuilder::with_id("view.zoomIn", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(&app_handle)?;
    let zoom_out = MenuItemBuilder::with_id("view.zoomOut", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(&app_handle)?;
    let zoom_reset = MenuItemBuilder::with_id("view.zoomReset", "Reset Zoom")
        .accelerator("CmdOrCtrl+0")
        .build(&app_handle)?;
    let view_submenu = SubmenuBuilder::new(&app_handle, "View")
        .item(&cmd_palette)
        .item(&quick_open)
        .separator()
        .item(&toggle_left)
        .item(&toggle_right)
        .item(&toggle_terminal)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&theme_picker)
        .item(&PredefinedMenuItem::fullscreen(&app_handle, None)?)
        .build()?;

    // Go menu
    //
    // `[` and `]` are muda's own accelerator tokens (accelerator.rs accepts
    // "BRACKETLEFT" | "[" and "BRACKETRIGHT" | "]"). `keybinding-parity.test.ts`
    // folds them onto the registry's `bracketleft`/`bracketright` spelling, so
    // these two ids MUST stay in step with `nav.back` / `nav.forward` in
    // App.tsx or the suite fails.
    //
    // Registering them natively is what makes the chords beat Monaco's
    // `outdentLines`/`indentLines` on macOS, where the OS menu wins — the same
    // shadowing the JS side does deliberately via the Monaco bridge.
    let nav_back = MenuItemBuilder::with_id("nav.back", "Back")
        .accelerator("CmdOrCtrl+[")
        .build(&app_handle)?;
    let nav_forward = MenuItemBuilder::with_id("nav.forward", "Forward")
        .accelerator("CmdOrCtrl+]")
        .build(&app_handle)?;
    let goto_line = MenuItemBuilder::with_id("editor.gotoLine", "Go to Line…")
        .accelerator("CmdOrCtrl+G")
        .build(&app_handle)?;
    let find_usages = MenuItemBuilder::with_id("editor.findUsages", "Find Usages")
        .accelerator("Alt+F7")
        .build(&app_handle)?;
    let go_submenu = SubmenuBuilder::new(&app_handle, "Go")
        .item(&nav_back)
        .item(&nav_forward)
        .separator()
        .item(&goto_line)
        .item(&find_usages)
        .build()?;

    // Debug menu
    //
    // On macOS the native menu wins: `handle_menu_event` runs `executeCommand`
    // with the item's id directly, bypassing the keybinding lookup entirely.
    // So a chord registered only in `App.tsx` would be shadowed by whatever the
    // OS menu already claims, and a chord registered only here would run a
    // command the registry never gated. These ids and accelerators must stay in
    // step with the `debug.*` block in App.tsx — `keybinding-parity.test.ts`
    // parses both files and fails if one chord names two different commands.
    let debug_continue = MenuItemBuilder::with_id("debug.continue", "Continue")
        .accelerator("CmdOrCtrl+F5")
        .build(&app_handle)?;
    let debug_stop = MenuItemBuilder::with_id("debug.stop", "Stop Debugging")
        .accelerator("CmdOrCtrl+Shift+F5")
        .build(&app_handle)?;
    let debug_step_over = MenuItemBuilder::with_id("debug.stepOver", "Step Over")
        .accelerator("F10")
        .build(&app_handle)?;
    let debug_step_into = MenuItemBuilder::with_id("debug.stepInto", "Step Into")
        .accelerator("F8")
        .build(&app_handle)?;
    let debug_step_out = MenuItemBuilder::with_id("debug.stepOut", "Step Out")
        .accelerator("Shift+F8")
        .build(&app_handle)?;
    let debug_run_to_cursor = MenuItemBuilder::with_id("debug.runToCursor", "Run to Cursor")
        .accelerator("CmdOrCtrl+F10")
        .build(&app_handle)?;
    let debug_toggle_breakpoint =
        MenuItemBuilder::with_id("debug.toggleBreakpoint", "Toggle Breakpoint")
            .accelerator("F9")
            .build(&app_handle)?;
    let debug_submenu = SubmenuBuilder::new(&app_handle, "Debug")
        .item(&debug_continue)
        .item(&debug_stop)
        .separator()
        .item(&debug_step_over)
        .item(&debug_step_into)
        .item(&debug_step_out)
        .item(&debug_run_to_cursor)
        .separator()
        .item(&debug_toggle_breakpoint)
        .build()?;

    // Window menu
    //
    // Minimize is a custom item rather than `PredefinedMenuItem::minimize`,
    // and deliberately carries NO accelerator. The predefined item registers
    // Cmd+M with AppKit, and the native menu beats the webview, so while it
    // owned that chord `ai.cycleMode`'s mod+m could never fire on macOS.
    // Dropping the accelerator hands the chord to the frontend; the item still
    // minimizes when chosen from the menu, which now happens through
    // `getCurrentWindow().minimize()` and needs core:window:allow-minimize.
    let minimize = MenuItemBuilder::with_id("window.minimize", "Minimize")
        .build(&app_handle)?;
    let window_submenu = SubmenuBuilder::new(&app_handle, "Window")
        .item(&minimize)
        .item(&PredefinedMenuItem::maximize(&app_handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(&app_handle, None)?)
        .build()?;

    let menu = MenuBuilder::new(&app_handle)
        .item(&app_submenu)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&go_submenu)
        .item(&debug_submenu)
        .item(&window_submenu)
        .build()?;

    Ok(menu)
}

pub fn handle_menu_event(app: &AppHandle, event_id: &str) {
    let focused = app
        .webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false));
    match focused {
        Some((label, _)) => {
            let _ = app.emit_to(label.as_str(), "menu-action", event_id.to_string());
        }
        None => {
            let _ = app.emit("menu-action", event_id.to_string());
        }
    }
}
