//! Breakpoint policy: hit conditions and log messages.
//!
//! Both are pure string handling, kept out of the router so the fiddly parts —
//! what `%5` means, where a `{}` ends — are settled without a runtime.
//!
//! Conditions and hit counts are evaluated **client side**: the runtime stops,
//! this decides, and a breakpoint that should not fire is resumed immediately.
//! Mono can filter by hit count itself, but not by expression, so doing one
//! here and one there would give two breakpoints with the same UI different
//! semantics. The cost is real — a conditional breakpoint inside `Update()`
//! suspends sixty times a second — and it is the same cost every DAP adapter
//! pays, because the alternative is a condition language the runtime defines.

/// When a breakpoint with a hit condition should actually stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitPolicy {
    /// Every time.
    Always,
    /// From the Nth hit onwards.
    AtLeast(u32),
    /// Only the Nth hit.
    Exactly(u32),
    /// Every Nth hit.
    EveryNth(u32),
}

impl HitPolicy {
    /// Whether the `hits`-th stop (1-based) should surface to the user.
    pub fn allows(&self, hits: u32) -> bool {
        match self {
            HitPolicy::Always => true,
            HitPolicy::AtLeast(n) => hits >= *n,
            HitPolicy::Exactly(n) => hits == *n,
            // A zero modulus would divide by zero; treat it as "every time",
            // which is what an empty condition means anyway.
            HitPolicy::EveryNth(0) => true,
            HitPolicy::EveryNth(n) => hits % *n == 0,
        }
    }
}

/// Parse a DAP `hitCondition`.
///
/// Accepts what the debug UIs people come from accept: a bare number (meaning
/// "from here on"), `>`, `>=`, `==`/`=`, and `%`. Anything else returns `None`
/// so the caller can report it rather than silently ignoring a condition the
/// user believes is in force.
pub fn parse_hit_condition(text: &str) -> Option<HitPolicy> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(HitPolicy::Always);
    }

    let (operator, rest) = if let Some(rest) = trimmed.strip_prefix(">=") {
        (">=", rest)
    } else if let Some(rest) = trimmed.strip_prefix("==") {
        ("==", rest)
    } else if let Some(rest) = trimmed.strip_prefix('>') {
        (">", rest)
    } else if let Some(rest) = trimmed.strip_prefix('=') {
        ("==", rest)
    } else if let Some(rest) = trimmed.strip_prefix('%') {
        ("%", rest)
    } else {
        (">=", trimmed)
    };

    let count: u32 = rest.trim().parse().ok()?;
    Some(match operator {
        ">=" => HitPolicy::AtLeast(count),
        // `> 5` means the sixth hit onwards.
        ">" => HitPolicy::AtLeast(count.saturating_add(1)),
        "==" => HitPolicy::Exactly(count),
        "%" => HitPolicy::EveryNth(count),
        _ => return None,
    })
}

/// A piece of a logpoint message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogPart {
    Literal(String),
    /// An expression to evaluate and substitute.
    Expr(String),
}

/// Split a log message into literal text and `{expression}` holes.
///
/// `{{` and `}}` are literal braces, so a message can mention them without
/// being read as an expression.
pub fn parse_log_message(text: &str) -> Vec<LogPart> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '{' if chars.peek() == Some(&'{') => {
                chars.next();
                literal.push('{');
            }
            '}' if chars.peek() == Some(&'}') => {
                chars.next();
                literal.push('}');
            }
            '{' => {
                // Read to the closing brace before committing anything: if
                // this turns out not to be a hole, the text belongs to the
                // literal already in progress rather than starting a new one.
                let mut expr = String::new();
                let mut closed = false;
                for inner in chars.by_ref() {
                    if inner == '}' {
                        closed = true;
                        break;
                    }
                    expr.push(inner);
                }

                if closed && !expr.trim().is_empty() {
                    if !literal.is_empty() {
                        parts.push(LogPart::Literal(std::mem::take(&mut literal)));
                    }
                    parts.push(LogPart::Expr(expr.trim().to_string()));
                } else if !closed {
                    // An unclosed brace is text, not a broken expression. A
                    // logpoint should print something rather than fail.
                    literal.push('{');
                    literal.push_str(&expr);
                }
                // An empty hole contributes nothing and leaves the surrounding
                // text as one run.
            }
            other => literal.push(other),
        }
    }

    if !literal.is_empty() {
        parts.push(LogPart::Literal(literal));
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn literal(text: &str) -> LogPart {
        LogPart::Literal(text.to_string())
    }

    fn expr(text: &str) -> LogPart {
        LogPart::Expr(text.to_string())
    }

    #[test]
    fn a_bare_number_means_from_that_hit_onwards() {
        assert_eq!(parse_hit_condition("5"), Some(HitPolicy::AtLeast(5)));
    }

    #[test]
    fn comparison_forms_are_understood() {
        assert_eq!(parse_hit_condition(">= 3"), Some(HitPolicy::AtLeast(3)));
        assert_eq!(parse_hit_condition("== 3"), Some(HitPolicy::Exactly(3)));
        assert_eq!(parse_hit_condition("= 3"), Some(HitPolicy::Exactly(3)));
        assert_eq!(parse_hit_condition("% 4"), Some(HitPolicy::EveryNth(4)));
    }

    /// `> 5` is the sixth hit onwards, not the fifth.
    #[test]
    fn strictly_greater_starts_one_later() {
        assert_eq!(parse_hit_condition("> 5"), Some(HitPolicy::AtLeast(6)));
        assert!(!HitPolicy::AtLeast(6).allows(5));
        assert!(HitPolicy::AtLeast(6).allows(6));
    }

    #[test]
    fn an_empty_condition_means_always() {
        assert_eq!(parse_hit_condition(""), Some(HitPolicy::Always));
        assert_eq!(parse_hit_condition("   "), Some(HitPolicy::Always));
    }

    /// Reported, not ignored: a user who typed a condition believes it applies.
    #[test]
    fn nonsense_is_rejected_rather_than_treated_as_always() {
        assert_eq!(parse_hit_condition("banana"), None);
        assert_eq!(parse_hit_condition(">= x"), None);
        assert_eq!(parse_hit_condition("-3"), None);
    }

    #[test]
    fn at_least_fires_from_its_count_onwards() {
        let policy = HitPolicy::AtLeast(3);
        assert!(!policy.allows(1));
        assert!(!policy.allows(2));
        assert!(policy.allows(3));
        assert!(policy.allows(400));
    }

    #[test]
    fn exactly_fires_once() {
        let policy = HitPolicy::Exactly(3);
        assert!(!policy.allows(2));
        assert!(policy.allows(3));
        assert!(!policy.allows(4));
    }

    #[test]
    fn every_nth_fires_on_multiples() {
        let policy = HitPolicy::EveryNth(3);
        assert!(!policy.allows(1));
        assert!(!policy.allows(2));
        assert!(policy.allows(3));
        assert!(policy.allows(6));
    }

    /// A modulus of zero would divide by zero on every hit.
    #[test]
    fn a_zero_modulus_does_not_panic() {
        assert!(HitPolicy::EveryNth(0).allows(1));
    }

    #[test]
    fn a_plain_message_is_one_literal() {
        assert_eq!(parse_log_message("hello"), vec![literal("hello")]);
    }

    #[test]
    fn braces_mark_expressions() {
        assert_eq!(
            parse_log_message("hp is {health} now"),
            vec![literal("hp is "), expr("health"), literal(" now")]
        );
    }

    #[test]
    fn several_expressions_are_all_captured() {
        assert_eq!(
            parse_log_message("{a}{b}"),
            vec![expr("a"), expr("b")]
        );
    }

    #[test]
    fn expressions_are_trimmed() {
        assert_eq!(parse_log_message("{  health  }"), vec![expr("health")]);
    }

    #[test]
    fn doubled_braces_are_literal_braces() {
        assert_eq!(
            parse_log_message("{{not an expression}}"),
            vec![literal("{not an expression}")]
        );
    }

    /// A logpoint exists to print something. An unclosed brace should degrade
    /// to text rather than swallow the whole message.
    #[test]
    fn an_unclosed_brace_stays_text() {
        assert_eq!(
            parse_log_message("value is {health"),
            vec![literal("value is {health")]
        );
    }

    /// An empty hole has nothing to evaluate, so it contributes nothing and
    /// the text around it stays a single run.
    #[test]
    fn an_empty_hole_is_dropped_and_does_not_split_the_text() {
        assert_eq!(parse_log_message("a{}b"), vec![literal("ab")]);
    }

    #[test]
    fn an_empty_message_produces_nothing() {
        assert!(parse_log_message("").is_empty());
    }
}
