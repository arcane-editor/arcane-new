//! Reading what a reference points at: fields, string contents, array elements.
//!
//! Everything here is *lazy*. A frame hands back object ids, not object graphs,
//! and this module turns one id into one level of children when the user
//! actually expands it. Walking eagerly would mean a breadth-first crawl of the
//! managed heap on every stop — on a Unity scene that is thousands of round
//! trips before the pane paints.
//!
//! Field lists come from the type, values from the object. They are separate
//! calls because the field list is worth caching per type while the values are
//! only good until the next resume.

use super::conn::{Conn, ConnError};
use super::protocol;
use super::values::{self, Value};
use super::wire::{Reader, Writer};

/// `OBJECT_REF` commands.
const CMD_OBJECT_REF_GET_TYPE: u8 = 1;
const CMD_OBJECT_REF_GET_VALUES: u8 = 2;
// Mono soft debugger: command 3 is IS_COLLECTED, not SET_VALUES.
const CMD_OBJECT_REF_SET_VALUES: u8 = 6;

/// `STRING_REF` commands.
const CMD_STRING_REF_GET_VALUE: u8 = 1;

/// `ARRAY_REF` commands.
const CMD_ARRAY_REF_GET_LENGTH: u8 = 1;
const CMD_ARRAY_REF_GET_VALUES: u8 = 2;

/// CLI field attribute bits.
const FIELD_ATTRIBUTE_STATIC: u32 = 0x0010;
const FIELD_ATTRIBUTE_LITERAL: u32 = 0x0040;

/// One declared field of a type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub id: u32,
    pub name: String,
    pub type_id: u32,
    pub attributes: u32,
}

impl Field {
    pub fn is_static(&self) -> bool {
        self.attributes & FIELD_ATTRIBUTE_STATIC != 0
    }

    /// A `const`. Its value lives in metadata, not in any instance, so asking
    /// an object for it is meaningless.
    pub fn is_literal(&self) -> bool {
        self.attributes & FIELD_ATTRIBUTE_LITERAL != 0
    }

    /// True for fields worth showing when expanding an instance.
    pub fn is_instance_field(&self) -> bool {
        !self.is_static() && !self.is_literal()
    }

    /// Compiler-generated backing fields read as noise (`<Name>k__BackingField`)
    /// and duplicate the property they serve.
    pub fn display_name(&self) -> &str {
        self.name
            .strip_prefix('<')
            .and_then(|rest| rest.split_once(">k__BackingField"))
            .map(|(inner, _)| inner)
            .unwrap_or(&self.name)
    }
}

/// The runtime type of an object.
pub async fn object_type(conn: &Conn, object: u32) -> Result<u32, ConnError> {
    let mut w = Writer::new();
    w.id(object);
    let reply = conn
        .request(
            protocol::CMD_SET_OBJECT_REF,
            CMD_OBJECT_REF_GET_TYPE,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_OBJECT_REF,
            command: CMD_OBJECT_REF_GET_TYPE,
            error: reply.error,
        });
    }
    Ok(Reader::new(&reply.body).id()?)
}

/// What `TYPE_GET_INFO` reports about a type.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TypeInfo {
    pub namespace: String,
    pub name: String,
    pub full_name: String,
    /// The base type. `None` for `System.Object` and for interfaces.
    pub parent: Option<u32>,
}

impl TypeInfo {
    /// Namespace-qualified name, e.g. `UnityEngine.Vector3`.
    pub fn qualified(&self) -> String {
        if self.namespace.is_empty() {
            self.name.clone()
        } else {
            format!("{}.{}", self.namespace, self.name)
        }
    }
}

/// A type's identity and base type.
///
/// Layout captured from Mono 6.13.0 for `Player` (62 bytes):
///
/// ```text
/// ""  "Player"  "Player"   namespace, name, full name
/// 1   1   5   0            assembly, module, parent, element type
/// 0x02000002               metadata token — TypeDef #2, which is what pins
///                          the field order above
/// ```
pub async fn type_info(conn: &Conn, type_id: u32) -> Result<TypeInfo, ConnError> {
    let mut w = Writer::new();
    w.id(type_id);
    let reply = conn
        .request(
            protocol::CMD_SET_TYPE,
            protocol::CMD_TYPE_GET_INFO,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Ok(TypeInfo::default());
    }

    let mut r = Reader::new(&reply.body);
    let namespace = r.string()?;
    let name = r.string()?;
    let full_name = r.string()?;
    let _assembly = r.id()?;
    let _module = r.id()?;
    let parent = r.id()?;
    Ok(TypeInfo {
        namespace,
        name,
        full_name,
        // Zero means "no base type" — `System.Object` itself.
        parent: (parent != 0).then_some(parent),
    })
}

/// A type's namespace-qualified name.
pub async fn type_name(conn: &Conn, type_id: u32) -> Result<String, ConnError> {
    Ok(type_info(conn, type_id).await?.qualified())
}

/// Every instance field a type has, including those it inherits.
///
/// `TYPE_GET_FIELDS` reports only what a type *declares*, so a `MonoBehaviour`
/// asked for its fields answers with the script's own and nothing else. That
/// matters beyond completeness: `m_CachedPtr`, the field that reveals whether a
/// Unity object has been destroyed, is declared on `UnityEngine.Object` — many
/// levels up from anything a user writes.
///
/// Base fields come first, so a derived field shadowing an inherited one is the
/// later entry and wins when callers de-duplicate by name.
pub async fn all_instance_fields(conn: &Conn, type_id: u32) -> Result<Vec<Field>, ConnError> {
    // Bounded so a cyclic or malformed hierarchy cannot spin forever.
    const MAX_DEPTH: usize = 32;

    let mut chain = Vec::new();
    let mut current = Some(type_id);
    for _ in 0..MAX_DEPTH {
        let Some(id) = current else { break };
        chain.push(id);
        current = type_info(conn, id).await?.parent;
    }

    let mut fields = Vec::new();
    for id in chain.into_iter().rev() {
        for field in type_fields(conn, id).await? {
            if field.is_instance_field() {
                fields.push(field);
            }
        }
    }
    Ok(fields)
}

/// A type's declared fields.
pub async fn type_fields(conn: &Conn, type_id: u32) -> Result<Vec<Field>, ConnError> {
    let mut w = Writer::new();
    w.id(type_id);
    let reply = conn
        .request(
            protocol::CMD_SET_TYPE,
            protocol::CMD_TYPE_GET_FIELDS,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Ok(Vec::new());
    }
    let mut r = Reader::new(&reply.body);
    let count = r.int()?.max(0);
    let mut fields = Vec::with_capacity(count as usize);
    for _ in 0..count {
        fields.push(Field {
            id: r.id()?,
            name: r.string()?,
            type_id: r.id()?,
            attributes: r.int()? as u32,
        });
    }
    Ok(fields)
}

/// Read named fields out of one object.
pub async fn object_values(
    conn: &Conn,
    object: u32,
    fields: &[u32],
) -> Result<Vec<Value>, ConnError> {
    // Never hand the agent an id it did not issue: a zero reference is a null,
    // and dereferencing one takes the whole runtime down.
    if object == 0 || fields.is_empty() {
        return Ok(Vec::new());
    }
    let mut w = Writer::new();
    w.id(object).int(fields.len() as i32);
    for field in fields {
        w.id(*field);
    }
    let reply = conn
        .request(
            protocol::CMD_SET_OBJECT_REF,
            CMD_OBJECT_REF_GET_VALUES,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_OBJECT_REF,
            command: CMD_OBJECT_REF_GET_VALUES,
            error: reply.error,
        });
    }
    let mut r = Reader::new(&reply.body);
    let mut out = Vec::with_capacity(fields.len());
    for _ in fields {
        out.push(values::decode_value(&mut r)?);
    }
    Ok(out)
}

/// Write one field of an object.
pub async fn set_object_value(
    conn: &Conn,
    object: u32,
    field: u32,
    encoded: Vec<u8>,
) -> Result<(), ConnError> {
    let mut w = Writer::new();
    w.id(object).int(1).id(field).raw(&encoded);
    let reply = conn
        .request(
            protocol::CMD_SET_OBJECT_REF,
            CMD_OBJECT_REF_SET_VALUES,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_OBJECT_REF,
            command: CMD_OBJECT_REF_SET_VALUES,
            error: reply.error,
        });
    }
    Ok(())
}

/// The characters of a `System.String`.
pub async fn string_value(conn: &Conn, object: u32) -> Result<String, ConnError> {
    if object == 0 {
        return Ok(String::new());
    }
    let mut w = Writer::new();
    w.id(object);
    let reply = conn
        .request(
            protocol::CMD_SET_STRING_REF,
            CMD_STRING_REF_GET_VALUE,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Ok(String::new());
    }

    // Protocol 2.41 and later prefix the payload with a flag byte, and this
    // client negotiates 2.58. Captured for the string "Ada":
    //
    //   00 | 00 00 00 03 41 64 61
    //   ^ flag  ^ ordinary length-prefixed UTF-8
    //
    // Reading the body as a bare string swallows the flag as the top byte of
    // the length, which makes every string read back empty — a debugger that
    // shows every `string` as "" while insisting it is not null.
    let mut r = Reader::new(&reply.body);
    let raw_utf16 = r.byte()? != 0;
    if !raw_utf16 {
        return Ok(r.string()?);
    }

    // The runtime falls back to raw UTF-16 only when the contents cannot be
    // represented as UTF-8 — an unpaired surrogate. Rare enough that it has not
    // been observed on the wire here, so it is decoded leniently rather than
    // trusted: a wrong guess costs one mis-rendered string, and the reply body
    // is discarded either way.
    let count = r.int()?.max(0) as usize;
    let mut units = Vec::with_capacity(count);
    for _ in 0..count {
        let low = r.byte()? as u16;
        let high = r.byte()? as u16;
        units.push((high << 8) | low);
    }
    Ok(String::from_utf16_lossy(&units))
}

/// Element count of a single-dimensional array.
pub async fn array_length(conn: &Conn, array: u32) -> Result<u32, ConnError> {
    if array == 0 {
        return Ok(0);
    }
    let mut w = Writer::new();
    w.id(array);
    let reply = conn
        .request(
            protocol::CMD_SET_ARRAY_REF,
            CMD_ARRAY_REF_GET_LENGTH,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Ok(0);
    }
    let mut r = Reader::new(&reply.body);
    // rank, then a length and lower bound per dimension. Only the first
    // dimension is modelled; multidimensional arrays are rare in Unity code.
    if r.int()? < 1 {
        return Ok(0);
    }
    Ok(r.int()?.max(0) as u32)
}

/// A slice of an array's elements.
pub async fn array_values(
    conn: &Conn,
    array: u32,
    index: u32,
    length: u32,
) -> Result<Vec<Value>, ConnError> {
    if array == 0 || length == 0 {
        return Ok(Vec::new());
    }
    let mut w = Writer::new();
    w.id(array).int(index as i32).int(length as i32);
    let reply = conn
        .request(
            protocol::CMD_SET_ARRAY_REF,
            CMD_ARRAY_REF_GET_VALUES,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_ARRAY_REF,
            command: CMD_ARRAY_REF_GET_VALUES,
            error: reply.error,
        });
    }
    let mut r = Reader::new(&reply.body);
    let mut out = Vec::with_capacity(length as usize);
    for _ in 0..length {
        out.push(values::decode_value(&mut r)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::fake_agent::FakeAgent;
    use crate::debug::values::{TYPE_I4, TYPE_STRING};
    use tokio::sync::mpsc;

    async fn connect(agent: &FakeAgent) -> Conn {
        Conn::connect(agent.addr).await.expect("connect")
    }

    fn recorder() -> (
        mpsc::UnboundedSender<(u8, u8, Vec<u8>)>,
        mpsc::UnboundedReceiver<(u8, u8, Vec<u8>)>,
    ) {
        mpsc::unbounded_channel()
    }

    fn player_fields_body() -> Vec<u8> {
        let mut w = Writer::new();
        w.int(2);
        w.id(11).string("Name").id(30).int(0);
        w.id(12).string("Score").id(3).int(0);
        w.into_bytes()
    }

    #[tokio::test]
    async fn decodes_a_types_field_list() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_FIELDS) {
                Some((0, player_fields_body()))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;

        assert_eq!(
            type_fields(&conn, 2).await.unwrap(),
            vec![
                Field {
                    id: 11,
                    name: "Name".into(),
                    type_id: 30,
                    attributes: 0
                },
                Field {
                    id: 12,
                    name: "Score".into(),
                    type_id: 3,
                    attributes: 0
                },
            ]
        );
    }

    #[test]
    fn static_and_const_fields_are_not_instance_state() {
        let statik = Field {
            id: 1,
            name: "Instance".into(),
            type_id: 2,
            attributes: FIELD_ATTRIBUTE_STATIC,
        };
        let konst = Field {
            id: 2,
            name: "Max".into(),
            type_id: 3,
            attributes: FIELD_ATTRIBUTE_LITERAL,
        };
        let plain = Field {
            id: 3,
            name: "Score".into(),
            type_id: 3,
            attributes: 0,
        };
        assert!(!statik.is_instance_field());
        assert!(!konst.is_instance_field());
        assert!(plain.is_instance_field());
    }

    /// An auto-property's backing field is spelled `<Score>k__BackingField`,
    /// which is noise beside the property it serves.
    #[test]
    fn backing_fields_display_under_their_property_name() {
        let backing = Field {
            id: 1,
            name: "<Score>k__BackingField".into(),
            type_id: 3,
            attributes: 0,
        };
        assert_eq!(backing.display_name(), "Score");
    }

    #[test]
    fn an_ordinary_field_keeps_its_name() {
        let field = Field {
            id: 1,
            name: "Score".into(),
            type_id: 3,
            attributes: 0,
        };
        assert_eq!(field.display_name(), "Score");
    }

    #[tokio::test]
    async fn object_values_asks_for_the_fields_it_was_given() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            let mut w = Writer::new();
            w.byte(TYPE_STRING).id(31);
            w.byte(TYPE_I4).int(3);
            Some((0, w.into_bytes()))
        });
        let conn = connect(&agent).await;

        let read = object_values(&conn, 2, &[11, 12]).await.unwrap();
        assert_eq!(
            read,
            vec![
                Value::Str(31),
                Value::Int {
                    value: 3,
                    tag: TYPE_I4
                }
            ]
        );

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (protocol::CMD_SET_OBJECT_REF, CMD_OBJECT_REF_GET_VALUES)
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.id().unwrap(), 2, "the object");
        assert_eq!(r.int().unwrap(), 2, "two fields");
        assert_eq!(r.id().unwrap(), 11);
        assert_eq!(r.id().unwrap(), 12);
    }

    /// Captured verbatim from Mono 6.13.0 reading `Player.Name`:
    /// `00 00 00 00 03 41 64 61` — a flag byte, then the UTF-8 string.
    #[tokio::test]
    async fn string_value_skips_the_encoding_flag_byte() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_STRING_REF, CMD_STRING_REF_GET_VALUE) {
                Some((0, vec![0x00, 0x00, 0x00, 0x00, 0x03, 0x41, 0x64, 0x61]))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(string_value(&conn, 31).await.unwrap(), "Ada");
    }

    #[tokio::test]
    async fn string_value_handles_the_raw_utf16_fallback() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_STRING_REF, CMD_STRING_REF_GET_VALUE) {
                let mut w = Writer::new();
                w.byte(1).int(2);
                for unit in "hi".encode_utf16() {
                    w.byte((unit & 0xff) as u8).byte((unit >> 8) as u8);
                }
                Some((0, w.into_bytes()))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(string_value(&conn, 31).await.unwrap(), "hi");
    }

    /// A null string reference must not be dereferenced — the agent kills the
    /// process when handed an id it did not issue.
    #[tokio::test]
    async fn a_null_string_reference_reads_as_empty_without_a_request() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, Vec::new()))
        });
        let conn = connect(&agent).await;

        assert_eq!(string_value(&conn, 0).await.unwrap(), "");
        assert!(
            seen.try_recv().is_err(),
            "a zero id must never reach the agent"
        );
    }

    #[tokio::test]
    async fn array_length_reads_the_first_dimension() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_ARRAY_REF, CMD_ARRAY_REF_GET_LENGTH) {
                let mut w = Writer::new();
                w.int(1).int(4).int(0); // rank, length, lower bound
                Some((0, w.into_bytes()))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(array_length(&conn, 40).await.unwrap(), 4);
    }

    #[tokio::test]
    async fn array_values_reads_a_slice() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            let mut w = Writer::new();
            w.byte(TYPE_I4).int(7);
            w.byte(TYPE_I4).int(8);
            Some((0, w.into_bytes()))
        });
        let conn = connect(&agent).await;

        let read = array_values(&conn, 40, 1, 2).await.unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(
            read[0],
            Value::Int {
                value: 7,
                tag: TYPE_I4
            }
        );

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (protocol::CMD_SET_ARRAY_REF, CMD_ARRAY_REF_GET_VALUES)
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.id().unwrap(), 40);
        assert_eq!(r.int().unwrap(), 1, "start index");
        assert_eq!(r.int().unwrap(), 2, "how many");
    }

    /// Build a `TYPE_GET_INFO` reply in the layout captured from Mono 6.13.0.
    fn type_info_body(namespace: &str, name: &str, parent: u32) -> Vec<u8> {
        let mut w = Writer::new();
        w.string(namespace)
            .string(name)
            .string(name)
            .id(1) // assembly
            .id(1) // module
            .id(parent)
            .id(0) // element type
            .int(0x0200_0002) // metadata token
            .int(0x1000)
            .byte(1);
        w.into_bytes()
    }

    #[tokio::test]
    async fn type_name_joins_the_namespace() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_INFO) {
                Some((0, type_info_body("UnityEngine", "Vector3", 5)))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(type_name(&conn, 19).await.unwrap(), "UnityEngine.Vector3");
    }

    #[tokio::test]
    async fn a_type_in_the_global_namespace_has_no_leading_dot() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_INFO) {
                Some((0, type_info_body("", "Player", 5)))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(type_name(&conn, 2).await.unwrap(), "Player");
    }

    #[tokio::test]
    async fn a_root_type_reports_no_parent() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_INFO) {
                Some((0, type_info_body("System", "Object", 0)))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(type_info(&conn, 5).await.unwrap().parent, None);
    }

    /// `m_CachedPtr` — the field that says whether a Unity object has been
    /// destroyed — is declared on `UnityEngine.Object`, several levels above
    /// any user script. Asking a `MonoBehaviour` for its own fields never
    /// finds it.
    #[tokio::test]
    async fn inherited_fields_are_collected_from_the_whole_hierarchy() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, body| {
            let id = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
            match (cs, cmd) {
                (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_INFO) => match id {
                    // Enemy : MonoBehaviour : UnityEngine.Object : System.Object
                    10 => Some((0, type_info_body("", "Enemy", 11))),
                    11 => Some((0, type_info_body("UnityEngine", "MonoBehaviour", 12))),
                    12 => Some((0, type_info_body("UnityEngine", "Object", 5))),
                    _ => Some((0, type_info_body("System", "Object", 0))),
                },
                (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_FIELDS) => {
                    let mut w = Writer::new();
                    match id {
                        10 => {
                            w.int(1);
                            w.id(101).string("health").id(3).int(0);
                        }
                        12 => {
                            w.int(1);
                            w.id(103).string("m_CachedPtr").id(4).int(0);
                        }
                        _ => {
                            w.int(0);
                        }
                    }
                    Some((0, w.into_bytes()))
                }
                _ => Some((0, Vec::new())),
            }
        });
        let conn = connect(&agent).await;

        let fields = all_instance_fields(&conn, 10).await.unwrap();
        let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["m_CachedPtr", "health"],
            "base fields first, so a shadowing derived field wins on de-dup"
        );
    }

    /// A malformed or cyclic hierarchy must not spin forever.
    #[tokio::test]
    async fn a_cyclic_hierarchy_terminates() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, body| {
            let id = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
            match (cs, cmd) {
                (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_INFO) => {
                    // Every type claims the other as its base.
                    Some((0, type_info_body("", "Loop", if id == 1 { 2 } else { 1 })))
                }
                (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_FIELDS) => {
                    let mut w = Writer::new();
                    w.int(0);
                    Some((0, w.into_bytes()))
                }
                _ => Some((0, Vec::new())),
            }
        });
        let conn = connect(&agent).await;
        assert!(all_instance_fields(&conn, 1).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn object_type_reads_the_runtime_type() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_OBJECT_REF, CMD_OBJECT_REF_GET_TYPE) {
                let mut w = Writer::new();
                w.id(2);
                Some((0, w.into_bytes()))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(object_type(&conn, 7).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn set_object_value_addresses_one_field() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, Vec::new()))
        });
        let conn = connect(&agent).await;

        let mut encoded = Writer::new();
        encoded.byte(TYPE_I4).int(42);
        set_object_value(&conn, 2, 12, encoded.into_bytes())
            .await
            .unwrap();

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (protocol::CMD_SET_OBJECT_REF, CMD_OBJECT_REF_SET_VALUES)
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.id().unwrap(), 2);
        assert_eq!(r.int().unwrap(), 1, "one field");
        assert_eq!(r.id().unwrap(), 12);
        assert_eq!(r.byte().unwrap(), TYPE_I4);
        assert_eq!(r.int().unwrap(), 42);
    }
}

/// ARRAY_REF.SET_VALUES uses the same element encoding as GET_VALUES.
pub async fn set_array_value(
    conn: &Conn,
    array: u32,
    index: u32,
    encoded: Vec<u8>,
) -> Result<(), ConnError> {
    let mut w = Writer::new();
    w.id(array).int(index as i32).int(1).raw(&encoded);
    let reply = conn
        .request(protocol::CMD_SET_ARRAY_REF, 3, w.into_bytes())
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_ARRAY_REF,
            command: 3,
            error: reply.error,
        });
    }
    Ok(())
}
