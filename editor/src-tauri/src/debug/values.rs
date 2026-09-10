//! Decoding the values the runtime hands back.
//!
//! A value is a one-byte type tag followed by a payload whose width depends on
//! the tag. The tags are the CLI type codes (`MONO_TYPE_*`), plus a few the
//! debugger agent adds above `0xf0`.
//!
//! The one rule worth stating: **every integral type narrower than 8 bytes is
//! sent as a 4-byte int**, sign-extended. A `bool` is four bytes, a `byte` is
//! four bytes, a `short` is four bytes. Reading a `bool` as one byte
//! desynchronises everything after it in a struct, and a desynchronised parse
//! is what produces a bogus id — which kills the runtime.
//!
//! Captured from Mono 6.13.0 stopped at a real breakpoint:
//!
//! ```text
//! 08 00 00 00 03    I4     -> 3        (the local `before`)
//! 12 00 00 00 02    CLASS  -> object 2 (`this`)
//! ```
//!
//! Object, string and array values carry only an id. Their contents are fetched
//! on demand, which is what makes a variables tree lazy rather than a
//! breadth-first crawl of the whole heap.

use super::wire::{Reader, WireError};

// CLI type codes.
pub const TYPE_VOID: u8 = 0x01;
pub const TYPE_BOOLEAN: u8 = 0x02;
pub const TYPE_CHAR: u8 = 0x03;
pub const TYPE_I1: u8 = 0x04;
pub const TYPE_U1: u8 = 0x05;
pub const TYPE_I2: u8 = 0x06;
pub const TYPE_U2: u8 = 0x07;
pub const TYPE_I4: u8 = 0x08;
pub const TYPE_U4: u8 = 0x09;
pub const TYPE_I8: u8 = 0x0a;
pub const TYPE_U8: u8 = 0x0b;
pub const TYPE_R4: u8 = 0x0c;
pub const TYPE_R8: u8 = 0x0d;
pub const TYPE_STRING: u8 = 0x0e;
pub const TYPE_PTR: u8 = 0x0f;
pub const TYPE_VALUETYPE: u8 = 0x11;
pub const TYPE_CLASS: u8 = 0x12;
pub const TYPE_ARRAY: u8 = 0x14;
pub const TYPE_I: u8 = 0x18;
pub const TYPE_U: u8 = 0x19;
pub const TYPE_OBJECT: u8 = 0x1c;
pub const TYPE_SZARRAY: u8 = 0x1d;

/// Debugger-only tag for an explicit null.
///
/// The runtime defines a few more above 0xf0 (a type reference, a parent value
/// type, a fixed array). None has been seen on the wire here, so none is
/// modelled: `decode_value` reports them as `Unsupported` rather than guessing
/// a payload width, which is the safe direction.
pub const TYPE_ID_NULL: u8 = 0xf0;

/// A value read from a frame, a field or an array element.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Void,
    Bool(bool),
    Char(u16),
    Int { value: i64, tag: u8 },
    Float(f64),
    /// A `System.String`. The characters are fetched separately by id.
    Str(u32),
    /// A reference. `id == 0` is a null reference.
    Object { tag: u8, id: u32 },
    /// An explicit null, which the agent sends instead of a typed reference.
    Null,
    /// A struct, inlined field by field.
    Struct {
        type_id: u32,
        is_enum: bool,
        fields: Vec<Value>,
    },
    Pointer(i64),
    /// A tag this client does not model. Kept rather than guessed, because
    /// guessing a payload width desynchronises the rest of the body.
    Unsupported(u8),
}

impl Value {
    /// The object id a reference points at, if any.
    pub fn object_id(&self) -> Option<u32> {
        match self {
            Value::Object { id, .. } if *id != 0 => Some(*id),
            Value::Str(id) if *id != 0 => Some(*id),
            _ => None,
        }
    }
}

/// Decode one value from `r`.
pub fn decode_value(r: &mut Reader<'_>) -> Result<Value, WireError> {
    let tag = r.byte()?;
    Ok(match tag {
        TYPE_VOID => Value::Void,
        // Four bytes, not one. See the module note.
        TYPE_BOOLEAN => Value::Bool(r.int()? != 0),
        TYPE_CHAR => Value::Char(r.int()? as u16),
        TYPE_I1 | TYPE_U1 | TYPE_I2 | TYPE_U2 | TYPE_I4 | TYPE_U4 => Value::Int {
            value: r.int()? as i64,
            tag,
        },
        TYPE_I8 | TYPE_U8 => Value::Int {
            value: r.long()?,
            tag,
        },
        TYPE_R4 => Value::Float(f32::from_bits(r.int()? as u32) as f64),
        TYPE_R8 => Value::Float(f64::from_bits(r.long()? as u64)),
        TYPE_STRING => Value::Str(r.id()?),
        TYPE_CLASS | TYPE_OBJECT | TYPE_SZARRAY | TYPE_ARRAY => {
            Value::Object { tag, id: r.id()? }
        }
        TYPE_PTR | TYPE_I | TYPE_U => Value::Pointer(r.long()?),
        TYPE_VALUETYPE => {
            let is_enum = r.byte()? != 0;
            let type_id = r.id()?;
            let count = r.int()?.max(0);
            let mut fields = Vec::with_capacity(count as usize);
            for _ in 0..count {
                fields.push(decode_value(r)?);
            }
            Value::Struct {
                type_id,
                is_enum,
                fields,
            }
        }
        // No payload. Captured from Mono 6.13.0 at protocol 2.58: a frame
        // holding a null string and an int came back as `f0 08 00 00 00 03` —
        // the null is the single byte `f0`.
        //
        // This is version-dependent: 2.59 and later append the static type the
        // null stands in for. `conn.rs` pins the negotiated version, so if that
        // pin ever moves, this must be re-read off the wire rather than
        // assumed. Consuming five bytes here (the shape guessed before the
        // capture) swallowed the value after it and truncated the reply.
        TYPE_ID_NULL => Value::Null,
        // Deliberately not guessed. An unmodelled tag whose payload width we
        // invent puts the rest of the body out of step, and a body out of step
        // is where bogus ids come from.
        _ => Value::Unsupported(tag),
    })
}

/// The C# name for a primitive tag.
///
/// Sent as the DAP variable's `type`, which the frontend renderer keys off — a
/// `UnityEngine.Color` only gets its swatch because the type says so. Returns
/// `None` for tags whose real type has to come from the runtime.
pub fn type_label(value: &Value) -> Option<&'static str> {
    Some(match value {
        Value::Bool(_) => "bool",
        Value::Char(_) => "char",
        Value::Float(_) => "double",
        Value::Str(_) => "string",
        Value::Void => "void",
        Value::Int { tag, .. } => match *tag {
            TYPE_I1 => "sbyte",
            TYPE_U1 => "byte",
            TYPE_I2 => "short",
            TYPE_U2 => "ushort",
            TYPE_I4 => "int",
            TYPE_U4 => "uint",
            TYPE_I8 => "long",
            TYPE_U8 => "ulong",
            _ => return None,
        },
        _ => return None,
    })
}

/// Render a value the way a variables pane shows it, without fetching anything
/// further from the runtime.
pub fn summarize(value: &Value) -> String {
    match value {
        Value::Void => "void".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Char(c) => match char::from_u32(*c as u32) {
            Some(ch) => format!("'{}'", ch),
            None => format!("'\\u{:04x}'", c),
        },
        Value::Int { value, .. } => value.to_string(),
        // A whole-numbered float keeps its point, so a `float` field is never
        // mistaken for an `int` in the pane.
        Value::Float(f) if f.is_finite() && f.fract() == 0.0 => format!("{:.1}", f),
        Value::Float(f) => f.to_string(),
        Value::Null => "null".to_string(),
        Value::Str(0) => "null".to_string(),
        Value::Str(_) => "\"…\"".to_string(),
        Value::Object { id: 0, .. } => "null".to_string(),
        Value::Object { .. } | Value::Struct { .. } => "{…}".to_string(),
        Value::Pointer(p) => format!("0x{:x}", p),
        Value::Unsupported(tag) => format!("<unsupported type 0x{:02x}>", tag),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::wire::Writer;

    /// Captured from Mono 6.13.0 at a real breakpoint: the local `before`.
    #[test]
    fn decodes_the_captured_int_local() {
        let bytes = [0x08, 0x00, 0x00, 0x00, 0x03];
        let mut r = Reader::new(&bytes);
        assert_eq!(
            decode_value(&mut r).unwrap(),
            Value::Int {
                value: 3,
                tag: TYPE_I4
            }
        );
        assert!(r.is_empty());
    }

    /// Captured from the same stop: `this`.
    #[test]
    fn decodes_the_captured_this_reference() {
        let bytes = [0x12, 0x00, 0x00, 0x00, 0x02];
        let mut r = Reader::new(&bytes);
        assert_eq!(
            decode_value(&mut r).unwrap(),
            Value::Object {
                tag: TYPE_CLASS,
                id: 2
            }
        );
    }

    /// The rule that keeps struct decoding in sync: narrow integers still
    /// occupy four bytes on the wire.
    #[test]
    fn a_bool_occupies_four_bytes_not_one() {
        let mut w = Writer::new();
        w.byte(TYPE_BOOLEAN).int(1);
        w.byte(TYPE_I4).int(77);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert_eq!(decode_value(&mut r).unwrap(), Value::Bool(true));
        assert_eq!(
            decode_value(&mut r).unwrap(),
            Value::Int {
                value: 77,
                tag: TYPE_I4
            },
            "the value after a bool must still line up"
        );
    }

    #[test]
    fn decodes_every_narrow_integer_as_a_four_byte_int() {
        for tag in [TYPE_I1, TYPE_U1, TYPE_I2, TYPE_U2, TYPE_U4] {
            let mut w = Writer::new();
            w.byte(tag).int(-5);
            let bytes = w.into_bytes();
            let mut r = Reader::new(&bytes);
            assert_eq!(
                decode_value(&mut r).unwrap(),
                Value::Int { value: -5, tag },
                "tag {:#x}",
                tag
            );
            assert!(r.is_empty(), "tag {:#x} consumed the wrong width", tag);
        }
    }

    #[test]
    fn decodes_eight_byte_integers() {
        let mut w = Writer::new();
        w.byte(TYPE_I8).long(-9_000_000_000);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert_eq!(
            decode_value(&mut r).unwrap(),
            Value::Int {
                value: -9_000_000_000,
                tag: TYPE_I8
            }
        );
    }

    /// Floats travel as their bit pattern in an int or a long.
    #[test]
    fn decodes_floats_from_their_bit_patterns() {
        let mut w = Writer::new();
        w.byte(TYPE_R4).int(1.5f32.to_bits() as i32);
        w.byte(TYPE_R8).long(2.25f64.to_bits() as i64);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert_eq!(decode_value(&mut r).unwrap(), Value::Float(1.5));
        assert_eq!(decode_value(&mut r).unwrap(), Value::Float(2.25));
    }

    #[test]
    fn decodes_a_char_as_a_utf16_unit() {
        let mut w = Writer::new();
        w.byte(TYPE_CHAR).int('Z' as i32);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert_eq!(decode_value(&mut r).unwrap(), Value::Char(90));
    }

    #[test]
    fn decodes_a_string_reference() {
        let mut w = Writer::new();
        w.byte(TYPE_STRING).id(31);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert_eq!(decode_value(&mut r).unwrap(), Value::Str(31));
    }

    #[test]
    fn a_zero_reference_is_null_not_an_object() {
        let mut w = Writer::new();
        w.byte(TYPE_CLASS).id(0);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        let value = decode_value(&mut r).unwrap();
        assert_eq!(value.object_id(), None);
        assert_eq!(summarize(&value), "null");
    }

    /// Captured verbatim from a real frame holding a null string and an int:
    /// `f0 08 00 00 00 03`. The null is one byte with no payload — reading a
    /// payload here swallows the value that follows it.
    #[test]
    fn the_null_tag_has_no_payload() {
        let bytes = [0xf0, 0x08, 0x00, 0x00, 0x00, 0x03];
        let mut r = Reader::new(&bytes);
        assert_eq!(decode_value(&mut r).unwrap(), Value::Null);
        assert_eq!(
            decode_value(&mut r).unwrap(),
            Value::Int {
                value: 3,
                tag: TYPE_I4
            },
            "the value after a null must still line up"
        );
        assert!(r.is_empty());
    }

    /// A `Vector3` is three floats inlined into the frame — the shape every
    /// Unity value renderer builds on.
    #[test]
    fn decodes_a_struct_field_by_field() {
        let mut w = Writer::new();
        w.byte(TYPE_VALUETYPE).byte(0).id(19).int(3);
        w.byte(TYPE_R4).int(1.0f32.to_bits() as i32);
        w.byte(TYPE_R4).int(2.0f32.to_bits() as i32);
        w.byte(TYPE_R4).int(3.0f32.to_bits() as i32);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert_eq!(
            decode_value(&mut r).unwrap(),
            Value::Struct {
                type_id: 19,
                is_enum: false,
                fields: vec![Value::Float(1.0), Value::Float(2.0), Value::Float(3.0)],
            }
        );
        assert!(r.is_empty());
    }

    #[test]
    fn decodes_a_nested_struct() {
        let mut w = Writer::new();
        w.byte(TYPE_VALUETYPE).byte(0).id(20).int(1);
        w.byte(TYPE_VALUETYPE).byte(0).id(19).int(1);
        w.byte(TYPE_I4).int(9);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        let value = decode_value(&mut r).unwrap();
        let Value::Struct { fields, .. } = &value else {
            panic!("expected a struct, got {:?}", value)
        };
        assert!(matches!(fields[0], Value::Struct { type_id: 19, .. }));
    }

    #[test]
    fn an_enum_struct_is_flagged() {
        let mut w = Writer::new();
        w.byte(TYPE_VALUETYPE).byte(1).id(21).int(1);
        w.byte(TYPE_I4).int(2);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert!(matches!(
            decode_value(&mut r).unwrap(),
            Value::Struct { is_enum: true, .. }
        ));
    }

    #[test]
    fn arrays_are_references() {
        for tag in [TYPE_SZARRAY, TYPE_ARRAY, TYPE_OBJECT] {
            let mut w = Writer::new();
            w.byte(tag).id(44);
            let bytes = w.into_bytes();
            let mut r = Reader::new(&bytes);
            assert_eq!(
                decode_value(&mut r).unwrap(),
                Value::Object { tag, id: 44 },
                "tag {:#x}",
                tag
            );
        }
    }

    #[test]
    fn void_carries_no_payload() {
        let bytes = [TYPE_VOID];
        let mut r = Reader::new(&bytes);
        assert_eq!(decode_value(&mut r).unwrap(), Value::Void);
        assert!(r.is_empty());
    }

    /// An unmodelled tag is reported, not guessed at. Guessing a payload width
    /// puts every later field out of step.
    #[test]
    fn an_unknown_tag_is_reported_rather_than_guessed() {
        let bytes = [0x7f];
        let mut r = Reader::new(&bytes);
        assert_eq!(decode_value(&mut r).unwrap(), Value::Unsupported(0x7f));
    }

    #[test]
    fn a_truncated_value_is_an_error() {
        let bytes = [TYPE_I4, 0x00];
        let mut r = Reader::new(&bytes);
        assert!(decode_value(&mut r).is_err());
    }

    #[test]
    fn summaries_read_the_way_a_variables_pane_shows_them() {
        assert_eq!(
            summarize(&Value::Int {
                value: 42,
                tag: TYPE_I4
            }),
            "42"
        );
        assert_eq!(summarize(&Value::Bool(true)), "true");
        assert_eq!(summarize(&Value::Float(1.5)), "1.5");
        assert_eq!(summarize(&Value::Null), "null");
        assert_eq!(summarize(&Value::Char(90)), "'Z'");
        assert_eq!(summarize(&Value::Void), "void");
    }

    /// Floats that happen to be whole numbers still read as floats, so a
    /// `float` field is never mistaken for an `int` in the pane.
    #[test]
    fn whole_floats_keep_a_decimal_point() {
        assert_eq!(summarize(&Value::Float(3.0)), "3.0");
    }

    #[test]
    fn primitive_tags_carry_their_c_sharp_names() {
        assert_eq!(
            type_label(&Value::Int {
                value: 1,
                tag: TYPE_I4
            }),
            Some("int")
        );
        assert_eq!(
            type_label(&Value::Int {
                value: 1,
                tag: TYPE_U1
            }),
            Some("byte")
        );
        assert_eq!(type_label(&Value::Bool(true)), Some("bool"));
        assert_eq!(type_label(&Value::Str(3)), Some("string"));
    }

    /// A reference's real type has to come from the runtime, so claiming one
    /// here would be a guess the pane would display as fact.
    #[test]
    fn reference_types_have_no_label_of_their_own() {
        assert_eq!(type_label(&Value::Object { tag: TYPE_CLASS, id: 2 }), None);
        assert_eq!(
            type_label(&Value::Struct {
                type_id: 19,
                is_enum: false,
                fields: vec![]
            }),
            None
        );
    }
}
