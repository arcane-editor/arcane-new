//! Shared poison-recovery helper for `std::sync::Mutex`.
//!
//! Every window in this app shares one Rust process and, via Tauri-managed
//! state, several `std::sync::Mutex`-guarded caches/registries. Without
//! poison recovery, a single panicking writer (e.g. a bug tripped from one
//! project window) poisons the mutex — every *other* window's next `.lock()`
//! on that same state then returns `Err`, which today mostly gets turned
//! into a user-facing error string (or, in a couple of `if let Ok(...)`
//! call sites, a silent no-op) instead of the crash itself spreading. That's
//! a availability bug on its own: one window's bug now visibly degrades
//! every other window for the rest of the process's life, even though nothing
//! about the *data* is actually broken.
//!
//! `lock_recover` treats poisoning as non-fatal and hands back the guard
//! regardless, matching what `file_index::apply_delta` already did by hand
//! (see its comment) before this helper existed.
use std::sync::{Mutex, MutexGuard};

/// Locks `m`, recovering the guard even if the mutex is poisoned.
///
/// ## When this is safe
///
/// Safe for **plain-data state** — maps, caches, flags, `Option<T>` slots —
/// where a panic that happens *while the lock is held* can only ever leave
/// the guarded value in one of the states it could already validly be in
/// (e.g. a `HashMap::insert` either completes or doesn't; there's no
/// intermediate "half-inserted" state observable after unwind), never in a
/// state that violates an invariant the rest of the code relies on. Every
/// current caller in this crate guards exactly that shape of state
/// (`HashMap`s of PTY/session handles, `Option<Index>` caches, a cached
/// `Option<File>` trace handle).
///
/// **Not safe** for state whose invariants span multiple fields and are
/// only restored by code that runs *after* the point where a panic could
/// occur (e.g. a multi-step transaction that must either fully commit or
/// fully roll back) — recovering a guard into a partially-updated multi-field
/// struct there could hand out a value other code assumes is
/// internally consistent. None of the `std::sync::Mutex` state in this crate
/// currently has that shape; `tokio::sync::Mutex` users are untouched by this
/// helper (async lock holders don't poison on panic the same way, and are
/// out of scope here regardless).
pub fn lock_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn recovers_a_poisoned_mutex_and_the_data_is_still_accessible() {
        let m = Arc::new(Mutex::new(vec![1, 2, 3]));

        // Poison it: spawn a thread that panics while holding the lock.
        let poisoner = Arc::clone(&m);
        let handle = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("intentional poison for lock_recover test");
        });
        // The thread panicked — join returns Err, not a propagated panic.
        assert!(handle.join().is_err());

        // A plain `.lock()` would now return Err(PoisonError).
        assert!(m.lock().is_err(), "mutex should be poisoned after the panic");

        // `lock_recover` still hands back a usable guard over the untouched data.
        let guard = lock_recover(&m);
        assert_eq!(*guard, vec![1, 2, 3]);
        drop(guard);

        // And it's still writable afterwards.
        {
            let mut guard = lock_recover(&m);
            guard.push(4);
        }
        assert_eq!(*lock_recover(&m), vec![1, 2, 3, 4]);
    }
}
