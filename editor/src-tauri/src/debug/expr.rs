//! A C# expression parser.
//!
//! Deliberately pure: text in, syntax tree out, no runtime and no I/O. That
//! split is what makes the hard half testable — precedence, associativity and
//! error reporting are settled here without a debuggee, and `eval.rs` only has
//! to walk a tree it can trust.
//!
//! This is not a C# compiler. It covers what people actually type into a watch
//! window or a breakpoint condition: names, member access, indexing, calls,
//! literals, arithmetic, comparison, logic and a ternary. Things it knowingly
//! omits — lambdas, generics, casts, `new`, LINQ — are reported as syntax
//! errors rather than silently mis-parsed, because a condition that quietly
//! means something other than what it says is worse than one that fails.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Int(i64),
    Real(f64),
    Str(String),
    Bool(bool),
    Null,
    /// A bare name: a local, a parameter, `this`, or a type.
    Ident(String),
    Member {
        target: Box<Expr>,
        name: String,
    },
    Index {
        target: Box<Expr>,
        index: Box<Expr>,
    },
    Call {
        target: Box<Expr>,
        args: Vec<Expr>,
    },
    Unary {
        op: UnaryOp,
        operand: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Conditional {
        condition: Box<Expr>,
        then: Box<Expr>,
        otherwise: Box<Expr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Not,
    Negate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Remainder,
    Equal,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    And,
    Or,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    /// Byte offset where parsing gave up, for a caret in the UI.
    pub at: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// Parse a complete expression. Trailing input is an error, not something to
/// ignore: `a b` is a typo, and evaluating just `a` would answer a question the
/// user did not ask.
pub fn parse(input: &str) -> Result<Expr, ParseError> {
    let tokens = lex(input)?;
    let mut parser = Parser { tokens, at: 0 };
    let expr = parser.expression()?;
    match parser.peek() {
        Some(token) => Err(parser.error_at(
            token.at,
            format!("unexpected {} after the end of the expression", token.kind.describe()),
        )),
        None => Ok(expr),
    }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Int(i64),
    Real(f64),
    Str(String),
    Ident(String),
    Symbol(&'static str),
}

impl TokenKind {
    fn describe(&self) -> String {
        match self {
            TokenKind::Int(v) => format!("number {}", v),
            TokenKind::Real(v) => format!("number {}", v),
            TokenKind::Str(_) => "string".to_string(),
            TokenKind::Ident(name) => format!("name '{}'", name),
            TokenKind::Symbol(s) => format!("'{}'", s),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Token {
    kind: TokenKind,
    at: usize,
}

/// Longest first, so `<=` is never read as `<` followed by `=`.
const SYMBOLS: &[&str] = &[
    "==", "!=", "<=", ">=", "&&", "||", "?", ":", "(", ")", "[", "]", ",", ".", "+", "-", "*", "/",
    "%", "<", ">", "!", "=",
];

fn lex(input: &str) -> Result<Vec<Token>, ParseError> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_whitespace() {
            i += 1;
            continue;
        }

        if c == '"' {
            let (text, next) = lex_string(input, i)?;
            tokens.push(Token {
                kind: TokenKind::Str(text),
                at: i,
            });
            i = next;
            continue;
        }

        if c.is_ascii_digit() {
            let start = i;
            let mut seen_dot = false;
            while i < bytes.len() {
                let d = bytes[i] as char;
                if d.is_ascii_digit() {
                    i += 1;
                } else if d == '.' && !seen_dot && i + 1 < bytes.len() && (bytes[i + 1] as char).is_ascii_digit() {
                    // Only a dot with a digit after it is a decimal point;
                    // otherwise `1.ToString` would lose its member access.
                    seen_dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            let text = &input[start..i];
            // Trailing type suffixes people type out of habit.
            if i < bytes.len() && matches!(bytes[i] as char, 'f' | 'F' | 'd' | 'D' | 'L' | 'l') {
                i += 1;
            }
            let kind = if seen_dot {
                TokenKind::Real(text.parse().map_err(|_| ParseError {
                    message: format!("'{}' is not a number", text),
                    at: start,
                })?)
            } else {
                match text.parse::<i64>() {
                    Ok(v) => TokenKind::Int(v),
                    // Too big for i64: keep it as a real rather than refuse.
                    Err(_) => TokenKind::Real(text.parse().map_err(|_| ParseError {
                        message: format!("'{}' is not a number", text),
                        at: start,
                    })?),
                }
            };
            tokens.push(Token { kind, at: start });
            continue;
        }

        if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < bytes.len() {
                let d = bytes[i] as char;
                if d.is_alphanumeric() || d == '_' {
                    i += 1;
                } else {
                    break;
                }
            }
            tokens.push(Token {
                kind: TokenKind::Ident(input[start..i].to_string()),
                at: start,
            });
            continue;
        }

        let symbol = SYMBOLS
            .iter()
            .find(|s| input[i..].starts_with(**s))
            .ok_or_else(|| ParseError {
                message: format!("unexpected character '{}'", c),
                at: i,
            })?;
        tokens.push(Token {
            kind: TokenKind::Symbol(symbol),
            at: i,
        });
        i += symbol.len();
    }

    Ok(tokens)
}

fn lex_string(input: &str, start: usize) -> Result<(String, usize), ParseError> {
    let bytes = input.as_bytes();
    let mut out = String::new();
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] as char {
            '"' => return Ok((out, i + 1)),
            '\\' => {
                i += 1;
                let escaped = *bytes.get(i).ok_or_else(|| ParseError {
                    message: "string ends in a backslash".to_string(),
                    at: start,
                })? as char;
                out.push(match escaped {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    '0' => '\0',
                    other => other,
                });
                i += 1;
            }
            other => {
                out.push(other);
                i += other.len_utf8();
            }
        }
    }
    Err(ParseError {
        message: "unterminated string".to_string(),
        at: start,
    })
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

struct Parser {
    tokens: Vec<Token>,
    at: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn position(&self) -> usize {
        self.peek()
            .map(|t| t.at)
            .unwrap_or_else(|| self.tokens.last().map(|t| t.at + 1).unwrap_or(0))
    }

    fn error_at(&self, at: usize, message: String) -> ParseError {
        ParseError { message, at }
    }

    fn error(&self, message: impl Into<String>) -> ParseError {
        ParseError {
            message: message.into(),
            at: self.position(),
        }
    }

    fn eat_symbol(&mut self, symbol: &str) -> bool {
        match self.peek() {
            Some(Token {
                kind: TokenKind::Symbol(s),
                ..
            }) if *s == symbol => {
                self.at += 1;
                true
            }
            _ => false,
        }
    }

    fn expect_symbol(&mut self, symbol: &str) -> Result<(), ParseError> {
        if self.eat_symbol(symbol) {
            Ok(())
        } else {
            Err(self.error(format!("expected '{}'", symbol)))
        }
    }

    fn expression(&mut self) -> Result<Expr, ParseError> {
        self.conditional()
    }

    fn conditional(&mut self) -> Result<Expr, ParseError> {
        let condition = self.logical_or()?;
        if !self.eat_symbol("?") {
            return Ok(condition);
        }
        // Right-associative: the else branch is another full conditional.
        let then = self.expression()?;
        self.expect_symbol(":")?;
        let otherwise = self.expression()?;
        Ok(Expr::Conditional {
            condition: Box::new(condition),
            then: Box::new(then),
            otherwise: Box::new(otherwise),
        })
    }

    fn logical_or(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.logical_and()?;
        while self.eat_symbol("||") {
            let right = self.logical_and()?;
            left = binary(BinaryOp::Or, left, right);
        }
        Ok(left)
    }

    fn logical_and(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.equality()?;
        while self.eat_symbol("&&") {
            let right = self.equality()?;
            left = binary(BinaryOp::And, left, right);
        }
        Ok(left)
    }

    fn equality(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.relational()?;
        loop {
            let op = if self.eat_symbol("==") {
                BinaryOp::Equal
            } else if self.eat_symbol("!=") {
                BinaryOp::NotEqual
            } else if matches!(
                self.peek(),
                Some(Token {
                    kind: TokenKind::Symbol("="),
                    ..
                })
            ) {
                // Assignment in a watch is a common slip and a dangerous one.
                return Err(self.error("'=' assigns; did you mean '=='?"));
            } else {
                return Ok(left);
            };
            let right = self.relational()?;
            left = binary(op, left, right);
        }
    }

    fn relational(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.additive()?;
        loop {
            let op = if self.eat_symbol("<=") {
                BinaryOp::LessOrEqual
            } else if self.eat_symbol(">=") {
                BinaryOp::GreaterOrEqual
            } else if self.eat_symbol("<") {
                BinaryOp::Less
            } else if self.eat_symbol(">") {
                BinaryOp::Greater
            } else {
                return Ok(left);
            };
            let right = self.additive()?;
            left = binary(op, left, right);
        }
    }

    fn additive(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.multiplicative()?;
        loop {
            let op = if self.eat_symbol("+") {
                BinaryOp::Add
            } else if self.eat_symbol("-") {
                BinaryOp::Subtract
            } else {
                return Ok(left);
            };
            let right = self.multiplicative()?;
            left = binary(op, left, right);
        }
    }

    fn multiplicative(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.unary()?;
        loop {
            let op = if self.eat_symbol("*") {
                BinaryOp::Multiply
            } else if self.eat_symbol("/") {
                BinaryOp::Divide
            } else if self.eat_symbol("%") {
                BinaryOp::Remainder
            } else {
                return Ok(left);
            };
            let right = self.unary()?;
            left = binary(op, left, right);
        }
    }

    fn unary(&mut self) -> Result<Expr, ParseError> {
        if self.eat_symbol("!") {
            return Ok(Expr::Unary {
                op: UnaryOp::Not,
                operand: Box::new(self.unary()?),
            });
        }
        if self.eat_symbol("-") {
            return Ok(Expr::Unary {
                op: UnaryOp::Negate,
                operand: Box::new(self.unary()?),
            });
        }
        self.postfix()
    }

    fn postfix(&mut self) -> Result<Expr, ParseError> {
        let mut target = self.primary()?;
        loop {
            if self.eat_symbol(".") {
                let name = match self.peek().cloned() {
                    Some(Token {
                        kind: TokenKind::Ident(name),
                        ..
                    }) => {
                        self.at += 1;
                        name
                    }
                    _ => return Err(self.error("expected a member name after '.'")),
                };
                target = Expr::Member {
                    target: Box::new(target),
                    name,
                };
            } else if self.eat_symbol("[") {
                let index = self.expression()?;
                self.expect_symbol("]")?;
                target = Expr::Index {
                    target: Box::new(target),
                    index: Box::new(index),
                };
            } else if self.eat_symbol("(") {
                let mut args = Vec::new();
                if !self.eat_symbol(")") {
                    loop {
                        args.push(self.expression()?);
                        if self.eat_symbol(",") {
                            continue;
                        }
                        self.expect_symbol(")")?;
                        break;
                    }
                }
                target = Expr::Call {
                    target: Box::new(target),
                    args,
                };
            } else {
                return Ok(target);
            }
        }
    }

    fn primary(&mut self) -> Result<Expr, ParseError> {
        let Some(token) = self.peek().cloned() else {
            return Err(self.error("expected an expression"));
        };
        self.at += 1;

        match token.kind {
            TokenKind::Int(v) => Ok(Expr::Int(v)),
            TokenKind::Real(v) => Ok(Expr::Real(v)),
            TokenKind::Str(s) => Ok(Expr::Str(s)),
            TokenKind::Ident(name) => match name.as_str() {
                "true" => Ok(Expr::Bool(true)),
                "false" => Ok(Expr::Bool(false)),
                "null" => Ok(Expr::Null),
                // Named rather than mis-parsed: `new Vector3(1,2,3)` would
                // otherwise read as the name `new` applied to a call.
                "new" => Err(self.error_at(token.at, "'new' is not supported in expressions".into())),
                _ => Ok(Expr::Ident(name)),
            },
            TokenKind::Symbol("(") => {
                let inner = self.expression()?;
                self.expect_symbol(")")?;
                Ok(inner)
            }
            other => Err(self.error_at(token.at, format!("unexpected {}", other.describe()))),
        }
    }
}

fn binary(op: BinaryOp, left: Expr, right: Expr) -> Expr {
    Expr::Binary {
        op,
        left: Box::new(left),
        right: Box::new(right),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ident(name: &str) -> Expr {
        Expr::Ident(name.to_string())
    }

    fn parsed(input: &str) -> Expr {
        parse(input).unwrap_or_else(|e| panic!("failed to parse {:?}: {}", input, e))
    }

    #[test]
    fn parses_literals() {
        assert_eq!(parsed("42"), Expr::Int(42));
        assert_eq!(parsed("3.5"), Expr::Real(3.5));
        assert_eq!(parsed("true"), Expr::Bool(true));
        assert_eq!(parsed("false"), Expr::Bool(false));
        assert_eq!(parsed("null"), Expr::Null);
        assert_eq!(parsed("\"hi\""), Expr::Str("hi".to_string()));
    }

    #[test]
    fn an_integer_literal_stays_an_integer() {
        // `count == 2` must not become a float comparison; ids and indices are
        // integers and comparing them as doubles loses precision at the top of
        // the range.
        assert_eq!(parsed("2"), Expr::Int(2));
        assert_eq!(parsed("2.0"), Expr::Real(2.0));
    }

    #[test]
    fn parses_a_bare_name() {
        assert_eq!(parsed("health"), ident("health"));
        assert_eq!(parsed("this"), ident("this"));
        assert_eq!(parsed("_private"), ident("_private"));
    }

    #[test]
    fn parses_a_member_chain() {
        assert_eq!(
            parsed("transform.position.x"),
            Expr::Member {
                target: Box::new(Expr::Member {
                    target: Box::new(ident("transform")),
                    name: "position".to_string(),
                }),
                name: "x".to_string(),
            }
        );
    }

    #[test]
    fn parses_indexing() {
        assert_eq!(
            parsed("items[0]"),
            Expr::Index {
                target: Box::new(ident("items")),
                index: Box::new(Expr::Int(0)),
            }
        );
    }

    #[test]
    fn parses_a_call_with_arguments() {
        assert_eq!(
            parsed("Add(1, x)"),
            Expr::Call {
                target: Box::new(ident("Add")),
                args: vec![Expr::Int(1), ident("x")],
            }
        );
    }

    #[test]
    fn parses_a_call_with_no_arguments() {
        assert_eq!(
            parsed("GetCount()"),
            Expr::Call {
                target: Box::new(ident("GetCount")),
                args: vec![],
            }
        );
    }

    #[test]
    fn postfix_operators_chain_left_to_right() {
        // `a.b[0].c()` — each step applies to the result of the last.
        let e = parsed("a.b[0].c()");
        let Expr::Call { target, args } = &e else {
            panic!("expected a call, got {:?}", e)
        };
        assert!(args.is_empty());
        let Expr::Member { name, .. } = target.as_ref() else {
            panic!("expected a member")
        };
        assert_eq!(name, "c");
    }

    /// Multiplication binds tighter than addition. A condition like
    /// `hp - dmg * 2 > 0` means something different if it does not.
    #[test]
    fn multiplication_binds_tighter_than_addition() {
        assert_eq!(
            parsed("1 + 2 * 3"),
            Expr::Binary {
                op: BinaryOp::Add,
                left: Box::new(Expr::Int(1)),
                right: Box::new(Expr::Binary {
                    op: BinaryOp::Multiply,
                    left: Box::new(Expr::Int(2)),
                    right: Box::new(Expr::Int(3)),
                }),
            }
        );
    }

    #[test]
    fn parentheses_override_precedence() {
        assert_eq!(
            parsed("(1 + 2) * 3"),
            Expr::Binary {
                op: BinaryOp::Multiply,
                left: Box::new(Expr::Binary {
                    op: BinaryOp::Add,
                    left: Box::new(Expr::Int(1)),
                    right: Box::new(Expr::Int(2)),
                }),
                right: Box::new(Expr::Int(3)),
            }
        );
    }

    #[test]
    fn subtraction_is_left_associative() {
        // `10 - 3 - 2` is 5, not 9.
        let Expr::Binary { op, left, .. } = parsed("10 - 3 - 2") else {
            panic!("expected a binary expression")
        };
        assert_eq!(op, BinaryOp::Subtract);
        assert!(matches!(
            left.as_ref(),
            Expr::Binary {
                op: BinaryOp::Subtract,
                ..
            }
        ));
    }

    #[test]
    fn comparison_binds_looser_than_arithmetic() {
        assert_eq!(
            parsed("hp - 1 > 0"),
            Expr::Binary {
                op: BinaryOp::Greater,
                left: Box::new(Expr::Binary {
                    op: BinaryOp::Subtract,
                    left: Box::new(ident("hp")),
                    right: Box::new(Expr::Int(1)),
                }),
                right: Box::new(Expr::Int(0)),
            }
        );
    }

    #[test]
    fn logical_and_binds_tighter_than_or() {
        let Expr::Binary { op, .. } = parsed("a || b && c") else {
            panic!("expected a binary expression")
        };
        assert_eq!(op, BinaryOp::Or, "the top of the tree must be the `||`");
    }

    #[test]
    fn equality_binds_looser_than_comparison() {
        let Expr::Binary { op, .. } = parsed("a < b == c") else {
            panic!("expected a binary expression")
        };
        assert_eq!(op, BinaryOp::Equal);
    }

    #[test]
    fn parses_unary_operators() {
        assert_eq!(
            parsed("!ready"),
            Expr::Unary {
                op: UnaryOp::Not,
                operand: Box::new(ident("ready")),
            }
        );
        assert_eq!(
            parsed("-5"),
            Expr::Unary {
                op: UnaryOp::Negate,
                operand: Box::new(Expr::Int(5)),
            }
        );
    }

    #[test]
    fn parses_a_ternary() {
        assert_eq!(
            parsed("a ? 1 : 2"),
            Expr::Conditional {
                condition: Box::new(ident("a")),
                then: Box::new(Expr::Int(1)),
                otherwise: Box::new(Expr::Int(2)),
            }
        );
    }

    #[test]
    fn a_ternary_is_right_associative() {
        // `a ? 1 : b ? 2 : 3` groups as `a ? 1 : (b ? 2 : 3)`.
        let Expr::Conditional { otherwise, .. } = parsed("a ? 1 : b ? 2 : 3") else {
            panic!("expected a conditional")
        };
        assert!(matches!(otherwise.as_ref(), Expr::Conditional { .. }));
    }

    #[test]
    fn a_realistic_breakpoint_condition_parses() {
        let e = parsed("enemy.health <= 0 && !enemy.isDead");
        assert!(matches!(
            e,
            Expr::Binary {
                op: BinaryOp::And,
                ..
            }
        ));
    }

    #[test]
    fn whitespace_is_insignificant() {
        assert_eq!(parsed("  a  +  b  "), parsed("a+b"));
    }

    #[test]
    fn string_escapes_are_understood() {
        assert_eq!(parsed(r#""a\"b""#), Expr::Str("a\"b".to_string()));
        assert_eq!(parsed(r#""line\n""#), Expr::Str("line\n".to_string()));
    }

    /// Trailing input means the user typed something the parser does not
    /// understand. Evaluating the prefix would answer a different question.
    #[test]
    fn trailing_input_is_an_error() {
        assert!(parse("a b").is_err());
        assert!(parse("1 2").is_err());
    }

    #[test]
    fn an_empty_expression_is_an_error() {
        assert!(parse("").is_err());
        assert!(parse("   ").is_err());
    }

    #[test]
    fn unbalanced_parentheses_are_an_error() {
        assert!(parse("(1 + 2").is_err());
        assert!(parse("items[0").is_err());
        assert!(parse("f(1, 2").is_err());
    }

    #[test]
    fn an_unterminated_string_is_an_error() {
        assert!(parse("\"unterminated").is_err());
    }

    #[test]
    fn a_dangling_operator_is_an_error() {
        assert!(parse("1 +").is_err());
        assert!(parse("a.").is_err());
        assert!(parse("* 2").is_err());
    }

    /// Unsupported C# is rejected rather than mis-parsed. A lambda that parsed
    /// as `x` followed by garbage would silently watch the wrong thing.
    #[test]
    fn unsupported_syntax_is_rejected_not_reinterpreted() {
        assert!(parse("x => x.health").is_err());
        assert!(parse("new Vector3(1,2,3)").is_err());
    }

    #[test]
    fn errors_report_where_they_gave_up() {
        let err = parse("a + ").unwrap_err();
        assert!(err.at >= 3, "expected a position near the end: {:?}", err);
        assert!(!err.message.is_empty());
    }

    #[test]
    fn a_single_equals_is_reported_as_a_comparison_mistake() {
        // Assignment in a watch expression is a common slip and a dangerous
        // one; naming it beats a generic "unexpected token".
        let err = parse("health = 5").unwrap_err();
        assert!(
            err.message.contains("=="),
            "expected a hint about ==, got {:?}",
            err.message
        );
    }
}
