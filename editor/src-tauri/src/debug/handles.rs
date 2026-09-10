//! The `variablesReference` table.
//!
//! DAP addresses every expandable value by an integer the adapter invents, and
//! fixes two rules about them:
//!
//! * **Zero means "no children".** A handle generator that can return 0 makes
//!   an expandable object look like a leaf.
//! * **References die on resume.** Object ids are only meaningful while the VM
//!   is suspended; once it runs, the same id may name different memory.
//!
//! The second rule is why `invalidate` never rewinds the counter. If it did,
//! a reference the UI is still holding — a tree node the user left expanded —
//! would resolve to a *different* object after the next stop, and the pane
//! would confidently show one object's fields under another one's name.

use std::collections::HashMap;

use super::values::Value;

/// What an expandable row expands into.
#[derive(Debug, Clone, PartialEq)]
pub enum Handle {
    /// The locals and `this` of one stack frame.
    FrameLocals {
        thread: u32,
        frame_id: u32,
        method: u32,
        il_offset: u32,
    },
    /// A reference type's fields.
    Object { id: u32 },
    /// A struct that was inlined into its parent, so it has no object id.
    Struct { type_id: u32, fields: Vec<Value> },
    /// A window onto an array. Large arrays are paged rather than sent whole.
    ArraySlice { array: u32, start: u32, count: u32 },
}

#[derive(Debug, Default)]
pub struct Handles {
    next: i64,
    map: HashMap<i64, Handle>,
}

impl Handles {
    pub fn new() -> Handles {
        Handles {
            // DAP reserves 0 for "not expandable".
            next: 1,
            map: HashMap::new(),
        }
    }

    pub fn alloc(&mut self, handle: Handle) -> i64 {
        let reference = self.next;
        self.next += 1;
        self.map.insert(reference, handle);
        reference
    }

    pub fn get(&self, reference: i64) -> Option<&Handle> {
        self.map.get(&reference)
    }

    /// Drop every handle, as a resume requires.
    ///
    /// The counter deliberately keeps climbing, so a reference the UI is still
    /// holding resolves to nothing rather than to somebody else's object.
    pub fn invalidate(&mut self) {
        self.map.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(id: u32) -> Handle {
        Handle::Object { id }
    }

    #[test]
    fn a_handle_is_never_zero() {
        let mut handles = Handles::new();
        assert_ne!(
            handles.alloc(object(1)),
            0,
            "zero means `no children` in DAP"
        );
    }

    #[test]
    fn handles_resolve_to_what_was_stored() {
        let mut handles = Handles::new();
        let a = handles.alloc(object(7));
        let b = handles.alloc(object(8));
        assert_eq!(handles.get(a), Some(&object(7)));
        assert_eq!(handles.get(b), Some(&object(8)));
    }

    #[test]
    fn every_handle_is_distinct() {
        let mut handles = Handles::new();
        let first = handles.alloc(object(1));
        let second = handles.alloc(object(1));
        assert_ne!(first, second);
    }

    #[test]
    fn resuming_invalidates_every_handle() {
        let mut handles = Handles::new();
        let reference = handles.alloc(object(7));
        handles.invalidate();
        assert_eq!(handles.get(reference), None);
        assert!(handles.is_empty());
    }

    /// The property that stops one object's fields appearing under another's
    /// name: a reference the UI kept across a resume must resolve to nothing,
    /// never to whatever was allocated next.
    #[test]
    fn a_stale_reference_never_resolves_to_a_later_object() {
        let mut handles = Handles::new();
        let stale = handles.alloc(object(7));
        handles.invalidate();
        let fresh = handles.alloc(object(99));

        assert_ne!(stale, fresh, "the counter must not rewind");
        assert_eq!(handles.get(stale), None);
        assert_eq!(handles.get(fresh), Some(&object(99)));
    }

    #[test]
    fn frame_locals_carry_the_offset_that_decides_which_locals_are_live() {
        let mut handles = Handles::new();
        let reference = handles.alloc(Handle::FrameLocals {
            thread: 1,
            frame_id: 2,
            method: 3,
            il_offset: 8,
        });
        assert_eq!(
            handles.get(reference),
            Some(&Handle::FrameLocals {
                thread: 1,
                frame_id: 2,
                method: 3,
                il_offset: 8
            })
        );
    }
}
