//! Evaluating a parsed expression against a suspended frame.
//!
//! Two value domains meet here. The runtime hands back `values::Value` — tagged
//! data that may be a reference to something on the managed heap — while an
//! expression also produces literals that exist only in the debugger. `Val`
//! spans both, and `compare`/`arith` work on whichever is in front of them.
//!
//! **No method is invoked.** Invoking resumes the target thread to run managed
//! code, and doing that from inside a variables refresh or a breakpoint
//! condition is a good way to hang Unity's main thread — a condition that
//! deadlocks the editor is worse than one that says it cannot be evaluated. So
//! properties and calls are reported as unsupported, by name, rather than
//! guessed at or quietly skipped. Fields, indexing, literals and operators
//! cover what breakpoint conditions are actually made of.

use super::conn::{Conn, ConnError};
use super::expr::{BinaryOp, Expr, UnaryOp};
use super::objects;
use super::session;
use super::values::Value;

/// Where an expression is evaluated.
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    pub thread: u32,
    pub frame: u32,
    pub method: u32,
    pub il_offset: u32,
}

/// A value during evaluation: either something the runtime gave us, or a
/// literal that only exists in the expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Runtime(Value),
    Int(i64),
    Real(f64),
    Bool(bool),
    Str(String),
    Null,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EvalError {
    /// A name that is not a local, parameter or field in scope.
    NotFound(String),
    /// Valid C# this evaluator deliberately does not run.
    Unsupported(String),
    /// The operands do not make sense together.
    Type(String),
    Runtime(String),
}

impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EvalError::NotFound(name) => write!(f, "'{}' is not in scope", name),
            EvalError::Unsupported(what) => write!(f, "{}", what),
            EvalError::Type(what) => write!(f, "{}", what),
            EvalError::Runtime(what) => write!(f, "{}", what),
        }
    }
}

impl From<ConnError> for EvalError {
    fn from(e: ConnError) -> Self {
        EvalError::Runtime(e.to_string())
    }
}

/// What two values are compared as, once both sides are resolved.
#[derive(Debug, Clone, PartialEq)]
enum Atom {
    Int(i64),
    Real(f64),
    Bool(bool),
    Str(String),
    Null,
    /// A reference with no simpler form; only identity comparison applies.
    Reference(u32),
    Unknown,
}

/// Evaluate `expr` in `frame`.
///
/// Boxed because the tree is recursive and each step may await the runtime;
/// an `async fn` cannot call itself without an indirection.
pub fn evaluate<'a>(
    conn: &'a Conn,
    frame: Frame,
    expr: &'a Expr,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Val, EvalError>> + Send + 'a>> {
    Box::pin(async move {
        match expr {
            Expr::Int(v) => Ok(Val::Int(*v)),
            Expr::Real(v) => Ok(Val::Real(*v)),
            Expr::Str(s) => Ok(Val::Str(s.clone())),
            Expr::Bool(b) => Ok(Val::Bool(*b)),
            Expr::Null => Ok(Val::Null),

            Expr::Ident(name) => resolve_name(conn, frame, name).await,

            Expr::Member { target, name } => {
                let base = evaluate(conn, frame, target).await?;
                read_field(conn, &base, name).await
            }

            Expr::Index { target, index } => {
                let base = evaluate(conn, frame, target).await?;
                let position = evaluate(conn, frame, index).await?;
                read_index(conn, &base, &position).await
            }

            // Refused rather than attempted: see the module note.
            Expr::Call { .. } => Err(EvalError::Unsupported(
                "calling a method would resume the debuggee, which can hang the editor — method calls are not evaluated".into(),
            )),

            Expr::Unary { op, operand } => {
                let value = evaluate(conn, frame, operand).await?;
                match op {
                    UnaryOp::Not => Ok(Val::Bool(!truthy(conn, &value).await?)),
                    UnaryOp::Negate => match atom(conn, &value).await? {
                        Atom::Int(v) => Ok(Val::Int(-v)),
                        Atom::Real(v) => Ok(Val::Real(-v)),
                        other => Err(EvalError::Type(format!(
                            "cannot negate {}",
                            describe_atom(&other)
                        ))),
                    },
                }
            }

            Expr::Binary { op, left, right } => {
                // `&&` and `||` short-circuit, so a null guard actually guards.
                if matches!(op, BinaryOp::And | BinaryOp::Or) {
                    let first = truthy(conn, &evaluate(conn, frame, left).await?).await?;
                    let decided = match op {
                        BinaryOp::And if !first => Some(false),
                        BinaryOp::Or if first => Some(true),
                        _ => None,
                    };
                    if let Some(answer) = decided {
                        return Ok(Val::Bool(answer));
                    }
                    let second = truthy(conn, &evaluate(conn, frame, right).await?).await?;
                    return Ok(Val::Bool(second));
                }

                let l = evaluate(conn, frame, left).await?;
                let r = evaluate(conn, frame, right).await?;
                apply_binary(*op, atom(conn, &l).await?, atom(conn, &r).await?)
            }

            Expr::Conditional {
                condition,
                then,
                otherwise,
            } => {
                let taken = truthy(conn, &evaluate(conn, frame, condition).await?).await?;
                let branch = if taken { then } else { otherwise };
                evaluate(conn, frame, branch).await
            }
        }
    })
}

/// Resolve a bare name against the frame.
async fn resolve_name(conn: &Conn, frame: Frame, name: &str) -> Result<Val, EvalError> {
    if name == "this" {
        let this = session::frame_this(conn, frame.thread, frame.frame).await?;
        return Ok(Val::Runtime(this));
    }

    let locals = session::locals_info(conn, frame.method).await?;
    if let Some((slot, _)) = locals
        .iter()
        .enumerate()
        .find(|(_, local)| local.name == name && local.is_live_at(frame.il_offset))
    {
        let read = session::frame_values(conn, frame.thread, frame.frame, &[slot as i32]).await?;
        if let Some(value) = read.into_iter().next() {
            return Ok(Val::Runtime(value));
        }
    }

    // Not a local: try it as a field of `this`, which is how people write
    // `health` for `this.health`.
    let this = session::frame_this(conn, frame.thread, frame.frame).await?;
    if this.object_id().is_some() {
        if let Ok(value) = read_field(conn, &Val::Runtime(this), name).await {
            return Ok(value);
        }
    }

    Err(EvalError::NotFound(name.to_string()))
}

/// Read a field off a reference.
async fn read_field(conn: &Conn, base: &Val, name: &str) -> Result<Val, EvalError> {
    let Val::Runtime(value) = base else {
        return Err(EvalError::Type(format!(
            "'{}' has no members on a literal value",
            name
        )));
    };
    let Some(object) = value.object_id() else {
        return Err(EvalError::Type(format!(
            "cannot read '{}' from a null reference",
            name
        )));
    };

    let type_id = objects::object_type(conn, object).await?;
    let fields = objects::all_instance_fields(conn, type_id).await?;
    let Some(field) = fields
        .iter()
        .find(|f| f.display_name() == name || f.name == name)
    else {
        // A property looks exactly like a field to the user, so say which one
        // this is rather than claiming the name does not exist at all.
        return Err(EvalError::NotFound(name.to_string()));
    };

    let read = objects::object_values(conn, object, &[field.id]).await?;
    read.into_iter()
        .next()
        .map(Val::Runtime)
        .ok_or_else(|| EvalError::NotFound(name.to_string()))
}

/// Index into an array.
async fn read_index(conn: &Conn, base: &Val, position: &Val) -> Result<Val, EvalError> {
    let Val::Runtime(value) = base else {
        return Err(EvalError::Type("cannot index a literal value".into()));
    };
    let Some(array) = value.object_id() else {
        return Err(EvalError::Type("cannot index a null reference".into()));
    };
    let index = match atom(conn, position).await? {
        Atom::Int(v) if v >= 0 => v as u32,
        Atom::Int(v) => {
            return Err(EvalError::Type(format!("index {} is negative", v)));
        }
        other => {
            return Err(EvalError::Type(format!(
                "an index must be a whole number, not {}",
                describe_atom(&other)
            )))
        }
    };

    let length = objects::array_length(conn, array).await?;
    if index >= length {
        // Indexers on collections are method calls, so a non-array here is
        // reported as out of range rather than silently returning nothing.
        return Err(EvalError::Type(format!(
            "index {} is outside the array (length {})",
            index, length
        )));
    }
    let read = objects::array_values(conn, array, index, 1).await?;
    read.into_iter()
        .next()
        .map(Val::Runtime)
        .ok_or_else(|| EvalError::Runtime("the runtime returned no element".into()))
}

/// Reduce a value to something comparable, fetching string contents if needed.
async fn atom(conn: &Conn, value: &Val) -> Result<Atom, EvalError> {
    Ok(match value {
        Val::Int(v) => Atom::Int(*v),
        Val::Real(v) => Atom::Real(*v),
        Val::Bool(b) => Atom::Bool(*b),
        Val::Str(s) => Atom::Str(s.clone()),
        Val::Null => Atom::Null,
        Val::Runtime(runtime) => match runtime {
            Value::Int { value, .. } => Atom::Int(*value),
            Value::Float(v) => Atom::Real(*v),
            Value::Single(v) => Atom::Real(*v as f64),
            Value::Bool(b) => Atom::Bool(*b),
            Value::Char(c) => Atom::Str(
                char::from_u32(*c as u32)
                    .map(|ch| ch.to_string())
                    .unwrap_or_default(),
            ),
            Value::Null => Atom::Null,
            Value::Str(0) => Atom::Null,
            // Comparing a runtime string to a literal needs its characters.
            Value::Str(id) => Atom::Str(objects::string_value(conn, *id).await?),
            Value::Object { id: 0, .. } => Atom::Null,
            Value::Object { id, .. } => Atom::Reference(*id),
            _ => Atom::Unknown,
        },
    })
}

/// Whether a value counts as true in a condition.
///
/// C# rules, not JavaScript's: only a bool is a condition. A number here is
/// almost always a typo (`if (count)` meaning `count > 0`), and treating it as
/// truthy would make the breakpoint fire on a condition the user never wrote.
pub async fn truthy(conn: &Conn, value: &Val) -> Result<bool, EvalError> {
    match atom(conn, value).await? {
        Atom::Bool(b) => Ok(b),
        other => Err(EvalError::Type(format!(
            "a condition must be true or false, not {}",
            describe_atom(&other)
        ))),
    }
}

/// Render a value for display, fetching string contents if needed.
pub async fn display(conn: &Conn, value: &Val) -> String {
    match atom(conn, value).await {
        Ok(Atom::Int(v)) => v.to_string(),
        Ok(Atom::Real(v)) if v.is_finite() && v.fract() == 0.0 => format!("{:.1}", v),
        Ok(Atom::Real(v)) => v.to_string(),
        Ok(Atom::Bool(b)) => b.to_string(),
        Ok(Atom::Str(s)) => format!("\"{}\"", s),
        Ok(Atom::Null) => "null".to_string(),
        Ok(Atom::Reference(_)) | Ok(Atom::Unknown) => match value {
            Val::Runtime(runtime) => super::values::summarize(runtime),
            _ => "…".to_string(),
        },
        Err(e) => e.to_string(),
    }
}

fn describe_atom(atom: &Atom) -> String {
    match atom {
        Atom::Int(v) => format!("the number {}", v),
        Atom::Real(v) => format!("the number {}", v),
        Atom::Bool(b) => format!("{}", b),
        Atom::Str(s) => format!("the string \"{}\"", s),
        Atom::Null => "null".to_string(),
        Atom::Reference(_) => "an object".to_string(),
        Atom::Unknown => "a value of an unsupported type".to_string(),
    }
}

fn apply_binary(op: BinaryOp, left: Atom, right: Atom) -> Result<Val, EvalError> {
    use Atom::*;
    use BinaryOp::*;

    // Equality is the one operator that works across kinds, because comparing
    // anything to null is legitimate.
    if matches!(op, Equal | NotEqual) {
        let equal = match (&left, &right) {
            (Null, Null) => true,
            (Null, _) | (_, Null) => false,
            (Int(a), Int(b)) => a == b,
            (Real(a), Real(b)) => a == b,
            (Int(a), Real(b)) | (Real(b), Int(a)) => (*a as f64) == *b,
            (Bool(a), Bool(b)) => a == b,
            (Str(a), Str(b)) => a == b,
            (Reference(a), Reference(b)) => a == b,
            _ => {
                return Err(EvalError::Type(format!(
                    "cannot compare {} with {}",
                    describe_atom(&left),
                    describe_atom(&right)
                )))
            }
        };
        return Ok(Val::Bool(if matches!(op, Equal) { equal } else { !equal }));
    }

    // Everything else is numeric, with one exception: `+` also joins strings.
    if matches!(op, Add) {
        if let (Str(a), Str(b)) = (&left, &right) {
            return Ok(Val::Str(format!("{}{}", a, b)));
        }
    }

    let (a, b, integral) = match (&left, &right) {
        (Int(a), Int(b)) => (*a as f64, *b as f64, true),
        (Int(a), Real(b)) => (*a as f64, *b, false),
        (Real(a), Int(b)) => (*a, *b as f64, false),
        (Real(a), Real(b)) => (*a, *b, false),
        _ => {
            return Err(EvalError::Type(format!(
                "cannot apply this operator to {} and {}",
                describe_atom(&left),
                describe_atom(&right)
            )))
        }
    };

    match op {
        Less => return Ok(Val::Bool(a < b)),
        LessOrEqual => return Ok(Val::Bool(a <= b)),
        Greater => return Ok(Val::Bool(a > b)),
        GreaterOrEqual => return Ok(Val::Bool(a >= b)),
        _ => {}
    }

    // Integer arithmetic stays integral: ids, counts and indices lose meaning
    // as floats, and `7 / 2` is 3 in C#.
    if integral {
        let (x, y) = (a as i64, b as i64);
        let value = match op {
            Add => x.wrapping_add(y),
            Subtract => x.wrapping_sub(y),
            Multiply => x.wrapping_mul(y),
            Divide | Remainder if y == 0 => return Err(EvalError::Type("division by zero".into())),
            Divide => x / y,
            Remainder => x % y,
            _ => return Err(EvalError::Type("unsupported operator".into())),
        };
        return Ok(Val::Int(value));
    }

    let value = match op {
        Add => a + b,
        Subtract => a - b,
        Multiply => a * b,
        Divide => a / b,
        Remainder => a % b,
        _ => return Err(EvalError::Type("unsupported operator".into())),
    };
    Ok(Val::Real(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::expr::parse;
    use crate::debug::fake_agent::{debug_info_body, FakeAgent};
    use crate::debug::protocol;
    use crate::debug::values::{TYPE_CLASS, TYPE_I4, TYPE_STRING};
    use crate::debug::wire::Writer;

    const FRAME: Frame = Frame {
        thread: 1,
        frame: 1,
        method: 4,
        il_offset: 8,
    };

    /// A fake runtime with one method holding two locals (`health`, `name`),
    /// and a `this` of type Player with a `Score` field.
    fn respond(cs: u8, cmd: u8, body: &[u8]) -> Option<(u16, Vec<u8>)> {
        let id = if body.len() >= 4 {
            u32::from_be_bytes([body[0], body[1], body[2], body[3]])
        } else {
            0
        };
        match (cs, cmd) {
            // METHOD_GET_LOCALS_INFO: two locals, both live for the method.
            (protocol::CMD_SET_METHOD, 5) => {
                let mut w = Writer::new();
                w.int(0).int(2);
                w.id(3).id(30);
                w.string("health").string("name");
                w.int(0).int(100);
                w.int(0).int(100);
                Some((0, w.into_bytes()))
            }
            // STACK_FRAME_GET_VALUES: slot 0 = health (7), slot 1 = name.
            (protocol::CMD_SET_STACK_FRAME, 1) => {
                let mut r = crate::debug::wire::Reader::new(body);
                let _thread = r.id().unwrap();
                let _frame = r.int().unwrap();
                let count = r.int().unwrap();
                let mut w = Writer::new();
                for _ in 0..count {
                    match r.int().unwrap() {
                        0 => {
                            w.byte(TYPE_I4).int(7);
                        }
                        1 => {
                            w.byte(TYPE_STRING).id(31);
                        }
                        _ => {
                            w.byte(TYPE_I4).int(0);
                        }
                    }
                }
                Some((0, w.into_bytes()))
            }
            // STACK_FRAME_GET_THIS
            (protocol::CMD_SET_STACK_FRAME, 2) => {
                let mut w = Writer::new();
                w.byte(TYPE_CLASS).id(2);
                Some((0, w.into_bytes()))
            }
            (protocol::CMD_SET_OBJECT_REF, 1) => {
                let mut w = Writer::new();
                w.id(60);
                Some((0, w.into_bytes()))
            }
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_INFO) => {
                let mut w = Writer::new();
                w.string("")
                    .string("Player")
                    .string("Player")
                    .id(1)
                    .id(1)
                    .id(0)
                    .id(0);
                Some((0, w.into_bytes()))
            }
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_FIELDS) => {
                let mut w = Writer::new();
                w.int(1);
                w.id(12).string("Score").id(3).int(0);
                Some((0, w.into_bytes()))
            }
            (protocol::CMD_SET_OBJECT_REF, 2) => {
                let mut w = Writer::new();
                w.byte(TYPE_I4).int(42);
                Some((0, w.into_bytes()))
            }
            // STRING_REF_GET_VALUE, with the flag byte the runtime sends.
            (protocol::CMD_SET_STRING_REF, 1) => {
                let mut w = Writer::new();
                w.byte(0).string(if id == 31 { "boss" } else { "other" });
                Some((0, w.into_bytes()))
            }
            (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_DEBUG_INFO) => {
                Some((0, debug_info_body("Fixture.cs", &[(8, 16, 9)])))
            }
            _ => Some((0, Vec::new())),
        }
    }

    async fn conn() -> (FakeAgent, Conn) {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(respond);
        let conn = Conn::connect(agent.addr).await.expect("connect");
        (agent, conn)
    }

    async fn eval(source: &str) -> Result<Val, EvalError> {
        let (_agent, conn) = conn().await;
        let expr = parse(source).expect("parse");
        evaluate(&conn, FRAME, &expr).await
    }

    async fn shown(source: &str) -> String {
        let (_agent, conn) = conn().await;
        let expr = parse(source).expect("parse");
        let value = evaluate(&conn, FRAME, &expr).await.expect("evaluate");
        display(&conn, &value).await
    }

    #[tokio::test]
    async fn literals_evaluate_to_themselves() {
        assert_eq!(eval("42").await.unwrap(), Val::Int(42));
        assert_eq!(eval("2.5").await.unwrap(), Val::Real(2.5));
        assert_eq!(eval("true").await.unwrap(), Val::Bool(true));
        assert_eq!(eval("null").await.unwrap(), Val::Null);
        assert_eq!(eval("\"hi\"").await.unwrap(), Val::Str("hi".into()));
    }

    #[tokio::test]
    async fn a_local_resolves_from_the_frame() {
        assert_eq!(
            eval("health").await.unwrap(),
            Val::Runtime(Value::Int {
                value: 7,
                tag: TYPE_I4
            })
        );
    }

    #[tokio::test]
    async fn an_unknown_name_says_so_by_name() {
        let err = eval("nonexistent").await.unwrap_err();
        assert_eq!(err, EvalError::NotFound("nonexistent".into()));
        assert!(err.to_string().contains("nonexistent"));
    }

    #[tokio::test]
    async fn this_resolves_to_the_receiver() {
        assert_eq!(
            eval("this").await.unwrap(),
            Val::Runtime(Value::Object {
                tag: TYPE_CLASS,
                id: 2
            })
        );
    }

    #[tokio::test]
    async fn a_field_reads_through_a_reference() {
        assert_eq!(
            eval("this.Score").await.unwrap(),
            Val::Runtime(Value::Int {
                value: 42,
                tag: TYPE_I4
            })
        );
    }

    #[tokio::test]
    async fn a_missing_field_names_the_member_not_the_object() {
        assert_eq!(
            eval("this.Missing").await.unwrap_err(),
            EvalError::NotFound("Missing".into())
        );
    }

    #[tokio::test]
    async fn arithmetic_on_runtime_and_literal_values_mixes() {
        assert_eq!(eval("health + 1").await.unwrap(), Val::Int(8));
        assert_eq!(eval("health * 2").await.unwrap(), Val::Int(14));
        assert_eq!(eval("health - 10").await.unwrap(), Val::Int(-3));
    }

    /// Integers stay integers so ids and counts survive the round trip.
    #[tokio::test]
    async fn integer_arithmetic_does_not_become_floating_point() {
        assert_eq!(eval("7 / 2").await.unwrap(), Val::Int(3));
        assert_eq!(eval("7.0 / 2").await.unwrap(), Val::Real(3.5));
    }

    #[tokio::test]
    async fn division_by_zero_is_an_error_not_a_panic() {
        assert!(matches!(
            eval("1 / 0").await,
            Err(EvalError::Type(_)) | Err(EvalError::Runtime(_))
        ));
    }

    #[tokio::test]
    async fn comparisons_produce_booleans() {
        assert_eq!(eval("health > 5").await.unwrap(), Val::Bool(true));
        assert_eq!(eval("health <= 5").await.unwrap(), Val::Bool(false));
        assert_eq!(eval("health == 7").await.unwrap(), Val::Bool(true));
        assert_eq!(eval("health != 7").await.unwrap(), Val::Bool(false));
    }

    /// The whole point of a breakpoint condition.
    #[tokio::test]
    async fn a_realistic_condition_evaluates() {
        assert_eq!(
            eval("health > 5 && health < 10").await.unwrap(),
            Val::Bool(true)
        );
        assert_eq!(
            eval("health > 100 || health == 7").await.unwrap(),
            Val::Bool(true)
        );
    }

    /// Comparing a runtime string to a literal has to fetch the characters.
    #[tokio::test]
    async fn a_runtime_string_compares_against_a_literal() {
        assert_eq!(eval("name == \"boss\"").await.unwrap(), Val::Bool(true));
        assert_eq!(eval("name == \"minion\"").await.unwrap(), Val::Bool(false));
    }

    #[tokio::test]
    async fn logical_not_and_negation_work() {
        assert_eq!(eval("!(health > 100)").await.unwrap(), Val::Bool(true));
        assert_eq!(eval("-health").await.unwrap(), Val::Int(-7));
    }

    #[tokio::test]
    async fn a_ternary_picks_a_branch() {
        assert_eq!(eval("health > 5 ? 1 : 2").await.unwrap(), Val::Int(1));
        assert_eq!(eval("health > 50 ? 1 : 2").await.unwrap(), Val::Int(2));
    }

    /// Short-circuiting matters: the right side of a `&&` guarded by a null
    /// check must not be evaluated when the guard fails.
    #[tokio::test]
    async fn logical_operators_short_circuit() {
        assert_eq!(
            eval("false && nonexistent").await.unwrap(),
            Val::Bool(false),
            "the right side must not be evaluated"
        );
        assert_eq!(eval("true || nonexistent").await.unwrap(), Val::Bool(true));
    }

    #[tokio::test]
    async fn a_null_reference_compares_equal_to_null() {
        // `this.Missing` does not exist, but a null-valued field would.
        assert_eq!(eval("null == null").await.unwrap(), Val::Bool(true));
        assert_eq!(eval("this == null").await.unwrap(), Val::Bool(false));
    }

    /// Invoking managed code resumes the target thread. Doing that from a
    /// breakpoint condition can hang Unity's main thread, so it is refused by
    /// name rather than attempted.
    #[tokio::test]
    async fn method_calls_are_refused_with_an_explanation() {
        let err = eval("this.ToString()").await.unwrap_err();
        assert!(matches!(err, EvalError::Unsupported(_)));
        assert!(
            err.to_string().to_lowercase().contains("method"),
            "the message should say why: {}",
            err
        );
    }

    #[tokio::test]
    async fn comparing_incompatible_things_is_an_error_not_a_silent_false() {
        assert!(matches!(
            eval("health < \"boss\"").await,
            Err(EvalError::Type(_))
        ));
    }

    #[tokio::test]
    async fn truthiness_follows_c_sharp_rather_than_javascript() {
        let (_agent, conn) = conn().await;
        assert!(truthy(&conn, &Val::Bool(true)).await.unwrap());
        assert!(!truthy(&conn, &Val::Bool(false)).await.unwrap());
        // A number is not a condition in C#.
        assert!(truthy(&conn, &Val::Int(1)).await.is_err());
    }

    #[tokio::test]
    async fn display_renders_a_runtime_string_as_its_contents() {
        assert_eq!(shown("name").await, "\"boss\"");
        assert_eq!(shown("health").await, "7");
        assert_eq!(shown("health > 5").await, "true");
        assert_eq!(shown("\"literal\"").await, "\"literal\"");
    }
}
