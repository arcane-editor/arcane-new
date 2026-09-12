//! Writable locations, including value types copied out of their parent.
//! Always re-read the root before replacing a nested field: another edit may
//! have changed a sibling since the tree was expanded.
use super::{
    conn::Conn,
    objects, session,
    values::{self, Value},
    wire::Writer,
};

#[derive(Clone, Debug)]
pub enum Location {
    Local { thread: u32, frame: u32, slot: i32 },
    Field { object: u32, field: u32 },
    Element { array: u32, index: u32 },
    Nested { parent: Box<Location>, index: usize },
}
impl Location {
    pub fn read<'a>(
        &'a self,
        conn: &'a Conn,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(async move {
            let result = match self {
                Self::Local {
                    thread,
                    frame,
                    slot,
                } => session::frame_values(conn, *thread, *frame, &[*slot]).await,
                Self::Field { object, field } => {
                    objects::object_values(conn, *object, &[*field]).await
                }
                Self::Element { array, index } => {
                    objects::array_values(conn, *array, *index, 1).await
                }
                Self::Nested { parent, index } => {
                    return match parent.read(conn).await? {
                        Value::Struct { fields, .. } => fields
                            .get(*index)
                            .cloned()
                            .ok_or("Field no longer exists".into()),
                        _ => Err("Parent is no longer a value type".into()),
                    }
                }
            };
            result
                .map_err(|e| e.to_string())?
                .into_iter()
                .next()
                .ok_or("Runtime returned no value".into())
        })
    }
    pub fn write<'a>(
        &'a self,
        conn: &'a Conn,
        value: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            if let Self::Nested { parent, index } = self {
                let mut root = parent.read(conn).await?;
                let Value::Struct { fields, .. } = &mut root else {
                    return Err("Parent is no longer a value type".into());
                };
                *fields.get_mut(*index).ok_or("Field no longer exists")? = value;
                return parent.write(conn, root).await;
            }
            let encoded = encode(&value)?;
            match self {
                Self::Local {
                    thread,
                    frame,
                    slot,
                } => session::set_frame_value(conn, *thread, *frame, *slot, encoded).await,
                Self::Field { object, field } => {
                    objects::set_object_value(conn, *object, *field, encoded).await
                }
                Self::Element { array, index } => {
                    objects::set_array_value(conn, *array, *index, encoded).await
                }
                Self::Nested { .. } => unreachable!(),
            }
            .map_err(|e| e.to_string())
        })
    }
}

pub fn replacement(old: &Value, text: &str) -> Result<Value, String> {
    let text = text.trim();
    let invalid = || {
        "Enter a value of the same C# type (integer, number, true/false, character or null)"
            .to_string()
    };
    Ok(match old {
        Value::Int { tag, .. } => {
            let n = text.parse::<i64>().map_err(|_| invalid())?;
            let valid = match *tag {
                values::TYPE_I1 => i8::try_from(n).is_ok(),
                values::TYPE_U1 => u8::try_from(n).is_ok(),
                values::TYPE_I2 => i16::try_from(n).is_ok(),
                values::TYPE_U2 => u16::try_from(n).is_ok(),
                values::TYPE_I4 => i32::try_from(n).is_ok(),
                values::TYPE_U4 => u32::try_from(n).is_ok(),
                values::TYPE_I8 => true,
                values::TYPE_U8 => n >= 0,
                _ => false,
            };
            if !valid {
                return Err("Value is outside the destination type's range".into());
            }
            Value::Int {
                value: n,
                tag: *tag,
            }
        }
        Value::Bool(_) => Value::Bool(text.parse().map_err(|_| invalid())?),
        Value::Single(_) => {
            let n: f32 = text
                .trim_end_matches(['f', 'F'])
                .parse()
                .map_err(|_| invalid())?;
            if !n.is_finite() {
                return Err(invalid());
            }
            Value::Single(n)
        }
        Value::Float(_) => {
            let n: f64 = text
                .trim_end_matches(['f', 'F', 'd', 'D'])
                .parse()
                .map_err(|_| invalid())?;
            if !n.is_finite() {
                return Err(invalid());
            }
            Value::Float(n)
        }
        Value::Char(_) => {
            let s = text
                .strip_prefix('\'')
                .and_then(|s| s.strip_suffix('\''))
                .ok_or_else(invalid)?;
            let chars: Vec<u16> = s.encode_utf16().collect();
            if chars.len() != 1 {
                return Err(invalid());
            }
            Value::Char(chars[0])
        }
        Value::Struct {
            is_enum: true,
            fields,
            type_id,
        } if fields.len() == 1 => Value::Struct {
            type_id: *type_id,
            is_enum: true,
            fields: vec![replacement(&fields[0], text)?],
        },
        Value::Str(_) | Value::Object { .. } | Value::Null if text == "null" => Value::Null,
        _ => return Err(invalid()),
    })
}

pub fn encode(value: &Value) -> Result<Vec<u8>, String> {
    let mut w = Writer::new();
    match value {
        Value::Bool(b) => {
            w.byte(values::TYPE_BOOLEAN).int(i32::from(*b));
        }
        Value::Char(c) => {
            w.byte(values::TYPE_CHAR).int(*c as i32);
        }
        Value::Int { value, tag } => {
            w.byte(*tag);
            if matches!(*tag, values::TYPE_I8 | values::TYPE_U8) {
                w.long(*value);
            } else {
                w.int(*value as i32);
            }
        }
        Value::Single(f) => {
            w.byte(values::TYPE_R4).int(f.to_bits() as i32);
        }
        Value::Float(f) => {
            w.byte(values::TYPE_R8).long(f.to_bits() as i64);
        }
        Value::Null => {
            w.byte(values::TYPE_ID_NULL);
        }
        Value::Str(id) => {
            w.byte(values::TYPE_STRING).id(*id);
        }
        Value::Object { tag, id } => {
            w.byte(*tag).id(*id);
        }
        Value::Struct {
            type_id,
            is_enum,
            fields,
        } => {
            w.byte(values::TYPE_VALUETYPE)
                .byte(u8::from(*is_enum))
                .id(*type_id)
                .int(fields.len() as i32);
            for field in fields {
                w.raw(&encode(field)?);
            }
        }
        _ => return Err("This runtime value cannot be written safely".into()),
    }
    Ok(w.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_narrow_integer_writes() {
        let old = Value::Int {
            value: 0,
            tag: values::TYPE_U1,
        };
        assert!(replacement(&old, "256").is_err());
        assert!(replacement(&old, "-1").is_err());
        assert_eq!(
            replacement(&old, "255").unwrap(),
            Value::Int {
                value: 255,
                tag: values::TYPE_U1
            }
        );
    }
    #[test]
    fn refuses_synthetic_object_ids() {
        assert!(replacement(
            &Value::Object {
                tag: values::TYPE_CLASS,
                id: 12
            },
            "42"
        )
        .is_err());
    }
}
