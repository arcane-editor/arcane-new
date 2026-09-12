//! Unity-aware value rendering.
//!
//! The generic variables pane is correct but unhelpful for Unity code. A
//! `Vector3` shows as a struct you have to expand three times to read three
//! numbers; a `List<T>` shows `_items`, `_size` and `_version` instead of its
//! elements; and a destroyed `GameObject` shows as a perfectly ordinary live
//! object, which is the single most expensive lie a Unity debugger can tell.
//!
//! Everything here is *formatting*. It never invokes anything in the debuggee —
//! no property getters, no `ToString()`. That restraint is deliberate: an
//! invoke resumes the target thread, and resuming Unity's main thread from
//! inside a variables refresh is a good way to hang the editor. Every value
//! below is derived from fields the runtime already handed over.

use super::values::{summarize, Value};

/// Unity's small structs, rendered inline instead of as a tree to expand.
const VECTOR_LIKE: &[(&str, &[&str])] = &[
    ("UnityEngine.Vector2", &["x", "y"]),
    ("UnityEngine.Vector3", &["x", "y", "z"]),
    ("UnityEngine.Vector4", &["x", "y", "z", "w"]),
    ("UnityEngine.Quaternion", &["x", "y", "z", "w"]),
    ("UnityEngine.Color", &["r", "g", "b", "a"]),
    ("UnityEngine.Color32", &["r", "g", "b", "a"]),
    ("UnityEngine.Vector2Int", &["x", "y"]),
    ("UnityEngine.Vector3Int", &["x", "y", "z"]),
];

/// The field on `UnityEngine.Object` holding the pointer to the native object.
///
/// Zero means the native half is gone. C# still holds a live managed reference,
/// so `obj != null` is true while Unity considers the object destroyed — the
/// asymmetry behind every "why is my reference null" bug. Reporting it is the
/// whole reason this module walks the type hierarchy.
pub const CACHED_PTR: &str = "m_CachedPtr";

/// A one-line summary for a Unity struct, given its type and field values.
///
/// `None` means "not a type we render specially" and the caller should fall
/// back to the generic summary.
pub fn struct_summary(type_name: &str, fields: &[Value]) -> Option<String> {
    let arity = VECTOR_LIKE
        .iter()
        .find(|(name, _)| *name == type_name)
        .map(|(_, components)| components.len())?;
    if fields.len() < arity {
        // Layout is not what the name implies — a different `Vector3` from
        // another assembly, say. Fall back rather than mislabel it.
        return None;
    }
    let rendered: Vec<String> = fields[..arity].iter().map(summarize).collect();
    Some(format!("({})", rendered.join(", ")))
}

/// Whether a value read from `m_CachedPtr` means the object was destroyed.
pub fn is_destroyed(cached_ptr: &Value) -> bool {
    match cached_ptr {
        Value::Pointer(p) => *p == 0,
        Value::Int { value, .. } => *value == 0,
        _ => false,
    }
}

/// How a destroyed Unity object reads in the pane.
pub fn destroyed_summary(type_name: &str) -> String {
    format!("null ({} was destroyed)", short_name(type_name))
}

/// The last segment of a namespace-qualified name.
pub fn short_name(type_name: &str) -> &str {
    type_name.rsplit('.').next().unwrap_or(type_name)
}

/// Whether expanding this type should show elements rather than fields.
pub fn is_collection(type_name: &str) -> bool {
    let base = type_name.split('`').next().unwrap_or(type_name);
    matches!(
        base,
        "System.Collections.Generic.List"
            | "System.Collections.Generic.Queue"
            | "System.Collections.Generic.Stack"
            | "System.Collections.Generic.HashSet"
    )
}

/// A readable name for a compiler-generated field.
///
/// Iterator and async methods compile into a state machine whose fields are
/// named `<>1__state`, `<>4__this`, `<name>5__2`. Coroutines are iterators, so
/// this is what a Unity developer sees whenever they stop inside one — the
/// difference between a pane full of `<>` noise and a pane showing the
/// variables they wrote.
pub fn readable_field_name(raw: &str) -> String {
    if raw == "<>1__state" {
        return "state (machine)".to_string();
    }
    if raw == "<>2__current" {
        return "current".to_string();
    }
    if raw == "<>4__this" {
        return "this".to_string();
    }
    if raw.starts_with("<>u__") || raw.starts_with("<>t__") {
        return raw.to_string();
    }
    // `<name>5__2` — a hoisted local. The user wrote `name`.
    if let Some(rest) = raw.strip_prefix('<') {
        if let Some((inner, tail)) = rest.split_once('>') {
            if !inner.is_empty() && tail.starts_with(|c: char| c.is_ascii_digit()) {
                return inner.to_string();
            }
        }
    }
    raw.to_string()
}

/// True for state-machine bookkeeping a user never wants to see.
pub fn is_machine_noise(raw: &str) -> bool {
    raw.starts_with("<>u__") || raw.starts_with("<>t__") || raw == "<>l__initialThreadId"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::values::TYPE_R4;

    fn f(value: f64) -> Value {
        Value::Single(value as f32)
    }

    #[test]
    fn a_vector3_reads_as_three_numbers_not_a_tree() {
        assert_eq!(
            struct_summary("UnityEngine.Vector3", &[f(1.0), f(2.5), f(-3.0)]),
            Some("(1.0, 2.5, -3.0)".to_string())
        );
    }

    #[test]
    fn every_vector_like_type_renders_with_its_own_arity() {
        assert_eq!(
            struct_summary("UnityEngine.Vector2", &[f(1.0), f(2.0)]),
            Some("(1.0, 2.0)".to_string())
        );
        assert_eq!(
            struct_summary("UnityEngine.Quaternion", &[f(0.0), f(0.0), f(0.0), f(1.0)]),
            Some("(0.0, 0.0, 0.0, 1.0)".to_string())
        );
    }

    /// A `Vector3` carries a fourth field in some Unity versions (and other
    /// assemblies define their own). Rendering the first three is right;
    /// rendering four would be wrong.
    #[test]
    fn extra_trailing_fields_are_ignored_rather_than_shown() {
        assert_eq!(
            struct_summary("UnityEngine.Vector3", &[f(1.0), f(2.0), f(3.0), f(9.0)]),
            Some("(1.0, 2.0, 3.0)".to_string())
        );
    }

    /// If the layout does not match the name, the name is not trustworthy.
    #[test]
    fn a_type_whose_layout_is_wrong_falls_back_to_the_generic_summary() {
        assert_eq!(struct_summary("UnityEngine.Vector3", &[f(1.0)]), None);
    }

    #[test]
    fn an_unknown_struct_is_not_rendered_specially() {
        assert_eq!(struct_summary("MyGame.Inventory", &[f(1.0), f(2.0)]), None);
    }

    /// The asymmetry at the heart of Unity's null: the managed reference is
    /// alive, the native object is gone, and `!= null` is true anyway.
    #[test]
    fn a_zero_cached_pointer_means_the_object_was_destroyed() {
        assert!(is_destroyed(&Value::Pointer(0)));
        assert!(is_destroyed(&Value::Int {
            value: 0,
            tag: TYPE_R4
        }));
    }

    #[test]
    fn a_live_object_has_a_non_zero_cached_pointer() {
        assert!(!is_destroyed(&Value::Pointer(0x7f_ff_00_00)));
        assert!(!is_destroyed(&Value::Int {
            value: 12345,
            tag: TYPE_R4
        }));
    }

    #[test]
    fn a_missing_cached_pointer_is_not_taken_as_destroyed() {
        // Guessing "destroyed" from an unreadable field would be the same lie
        // in the other direction.
        assert!(!is_destroyed(&Value::Null));
        assert!(!is_destroyed(&Value::Unsupported(0x7f)));
    }

    #[test]
    fn a_destroyed_object_says_so_using_its_short_type_name() {
        assert_eq!(
            destroyed_summary("UnityEngine.GameObject"),
            "null (GameObject was destroyed)"
        );
    }

    #[test]
    fn short_name_survives_a_type_with_no_namespace() {
        assert_eq!(short_name("Player"), "Player");
        assert_eq!(short_name("UnityEngine.Transform"), "Transform");
    }

    #[test]
    fn generic_collections_are_recognised_through_their_arity_suffix() {
        assert!(is_collection("System.Collections.Generic.List`1"));
        assert!(is_collection("System.Collections.Generic.HashSet`1"));
        assert!(!is_collection("System.Collections.Generic.Dictionary`2"));
        assert!(!is_collection("MyGame.Inventory"));
    }

    /// A coroutine is an iterator, so stopping inside one shows the compiler's
    /// state machine rather than the code the user wrote.
    #[test]
    fn hoisted_locals_read_under_the_name_the_user_wrote() {
        assert_eq!(readable_field_name("<elapsed>5__2"), "elapsed");
        assert_eq!(readable_field_name("<target>5__14"), "target");
    }

    #[test]
    fn the_state_machines_own_fields_get_readable_names() {
        assert_eq!(readable_field_name("<>1__state"), "state (machine)");
        assert_eq!(readable_field_name("<>2__current"), "current");
        assert_eq!(readable_field_name("<>4__this"), "this");
    }

    #[test]
    fn an_ordinary_field_name_is_left_alone() {
        assert_eq!(readable_field_name("health"), "health");
        assert_eq!(readable_field_name("_items"), "_items");
    }

    /// `<>u__1` is an awaiter slot — machinery, not a variable.
    #[test]
    fn awaiter_slots_are_recognised_as_noise() {
        assert!(is_machine_noise("<>u__1"));
        assert!(is_machine_noise("<>l__initialThreadId"));
        assert!(!is_machine_noise("<elapsed>5__2"));
        assert!(!is_machine_noise("health"));
    }

    /// A name that merely looks generated must not be mangled.
    #[test]
    fn an_angle_bracket_name_without_a_numeric_tail_is_untouched() {
        assert_eq!(readable_field_name("<weird>"), "<weird>");
        assert_eq!(readable_field_name("<>"), "<>");
    }
}
