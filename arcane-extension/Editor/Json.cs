// Json.cs — self-contained JSON value model, parser and serializer.
//
// WHY NOT JsonUtility / Newtonsoft?
//   * UnityEngine.JsonUtility cannot represent dictionaries or heterogeneous
//     arrays, and refuses arbitrary top-level arrays — the bridge payloads are
//     exactly that (component property bags, asset lists, RPC params).
//   * com.unity.nuget.newtonsoft-json may be absent from the target project, and
//     we must not add a hard dependency. So we ship a small, correct model here.
//
// Scope: object / array / string / number / bool / null. UTF-8 throughout.
// Numbers are stored as double (the wire protocol uses doubles for timestamps
// and ints alike); helpers expose AsInt/AsLong for convenience.
//
// This is a hand-written recursive-descent parser. It is intentionally strict
// enough for machine-generated JSON (what the IDE sends) and forgiving on the
// serialize side (always emits valid, escaped JSON).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Arcane.Bridge
{
    internal enum JsonType { Null, Bool, Number, String, Array, Object }

    /// <summary>
    /// A minimal JSON value. Construct via the static factories or implicit
    /// conversions, read via the typed accessors. Indexer access on the wrong
    /// type returns a Null JsonValue rather than throwing, so inbound message
    /// parsing stays branch-light.
    /// </summary>
    internal sealed class JsonValue : IEnumerable<KeyValuePair<string, JsonValue>>
    {
        public JsonType Type { get; private set; }

        private bool _bool;
        private double _number;
        private string _string;
        private List<JsonValue> _array;
        private Dictionary<string, JsonValue> _object;

        // ── Construction ─────────────────────────────────────────────────────

        public static readonly JsonValue Null = new JsonValue { Type = JsonType.Null };

        public static JsonValue NewObject() => new JsonValue
        {
            Type = JsonType.Object,
            _object = new Dictionary<string, JsonValue>()
        };

        public static JsonValue NewArray() => new JsonValue
        {
            Type = JsonType.Array,
            _array = new List<JsonValue>()
        };

        public static JsonValue Of(string s) =>
            s == null ? Null : new JsonValue { Type = JsonType.String, _string = s };

        public static JsonValue Of(bool b) => new JsonValue { Type = JsonType.Bool, _bool = b };
        public static JsonValue Of(double d) => new JsonValue { Type = JsonType.Number, _number = d };
        public static JsonValue Of(long l) => new JsonValue { Type = JsonType.Number, _number = l };
        public static JsonValue Of(int i) => new JsonValue { Type = JsonType.Number, _number = i };

        // Implicit conversions keep call sites tidy: obj["k"] = "value";
        public static implicit operator JsonValue(string s) => Of(s);
        public static implicit operator JsonValue(bool b) => Of(b);
        public static implicit operator JsonValue(double d) => Of(d);
        public static implicit operator JsonValue(long l) => Of(l);
        public static implicit operator JsonValue(int i) => Of(i);

        // ── Typed accessors ──────────────────────────────────────────────────

        public bool IsNull => Type == JsonType.Null;
        public bool IsObject => Type == JsonType.Object;
        public bool IsArray => Type == JsonType.Array;
        public bool IsString => Type == JsonType.String;
        public bool IsNumber => Type == JsonType.Number;

        public bool AsBool => Type == JsonType.Bool && _bool;
        public double AsNumber => Type == JsonType.Number ? _number : 0d;
        public int AsInt => (int)AsNumber;
        public long AsLong => (long)AsNumber;

        /// <summary>String value, or null when this is not a string.</summary>
        public string AsString => Type == JsonType.String ? _string : null;

        /// <summary>String value with a fallback when absent/non-string.</summary>
        public string AsStringOr(string fallback) => Type == JsonType.String ? _string : fallback;

        public List<JsonValue> Array => _array;
        public int Count => Type == JsonType.Array ? _array.Count
                          : Type == JsonType.Object ? _object.Count
                          : 0;

        // ── Object/array mutation ────────────────────────────────────────────

        /// <summary>
        /// Object member access. Reading a missing key (or indexing a non-object)
        /// returns JsonValue.Null so callers can chain safely:
        /// <c>msg["payload"]["method"].AsString</c>.
        /// </summary>
        public JsonValue this[string key]
        {
            get
            {
                if (Type == JsonType.Object && _object.TryGetValue(key, out var v)) return v;
                return Null;
            }
            set
            {
                if (Type != JsonType.Object)
                    throw new InvalidOperationException("JsonValue: not an object");
                _object[key] = value ?? Null;
            }
        }

        /// <summary>Array element access; out-of-range returns Null.</summary>
        public JsonValue this[int index]
        {
            get
            {
                if (Type == JsonType.Array && index >= 0 && index < _array.Count) return _array[index];
                return Null;
            }
        }

        public bool ContainsKey(string key) => Type == JsonType.Object && _object.ContainsKey(key);

        public void Add(JsonValue value)
        {
            if (Type != JsonType.Array)
                throw new InvalidOperationException("JsonValue: not an array");
            _array.Add(value ?? Null);
        }

        // IEnumerable over object members (used rarely; arrays expose .Array).
        public IEnumerator<KeyValuePair<string, JsonValue>> GetEnumerator()
        {
            if (Type == JsonType.Object)
            {
                foreach (var kv in _object) yield return kv;
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        // ── Serialization ────────────────────────────────────────────────────

        public string Serialize()
        {
            var sb = new StringBuilder(256);
            Write(sb, this);
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, JsonValue v)
        {
            if (v == null) { sb.Append("null"); return; }
            switch (v.Type)
            {
                case JsonType.Null:
                    sb.Append("null");
                    break;
                case JsonType.Bool:
                    sb.Append(v._bool ? "true" : "false");
                    break;
                case JsonType.Number:
                    WriteNumber(sb, v._number);
                    break;
                case JsonType.String:
                    WriteString(sb, v._string);
                    break;
                case JsonType.Array:
                    sb.Append('[');
                    for (int i = 0; i < v._array.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        Write(sb, v._array[i]);
                    }
                    sb.Append(']');
                    break;
                case JsonType.Object:
                    sb.Append('{');
                    bool first = true;
                    foreach (var kv in v._object)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, kv.Key);
                        sb.Append(':');
                        Write(sb, kv.Value);
                    }
                    sb.Append('}');
                    break;
            }
        }

        private static void WriteNumber(StringBuilder sb, double d)
        {
            // Non-finite values are not valid JSON; emit null rather than "NaN".
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }

            // Integral doubles serialize without a trailing ".0" (matches the
            // IDE's serde_json output for ints, e.g. instanceId / line numbers).
            if (d == Math.Floor(d) && !double.IsInfinity(d)
                && d >= long.MinValue && d <= long.MaxValue)
            {
                sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
            }
            else
            {
                // "R" round-trips; InvariantCulture guarantees a '.' decimal sep.
                sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
            }
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            if (s == null) { sb.Append("null"); return; }
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u");
                            sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            // Pass through all other chars (incl. non-ASCII); the
                            // frame body is UTF-8 encoded on the way out, so we do
                            // not need \u escapes for BMP/supplementary chars.
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
        }

        // ── Parsing ──────────────────────────────────────────────────────────

        public static JsonValue Parse(string text)
        {
            var p = new Parser(text);
            var v = p.ParseValue();
            p.SkipWhitespace();
            if (!p.AtEnd)
                throw new FormatException("JSON: trailing characters after value at " + p.Pos);
            return v;
        }

        /// <summary>Parse without throwing; returns null on malformed input.</summary>
        public static JsonValue TryParse(string text)
        {
            try { return Parse(text); }
            catch { return null; }
        }

        private struct Parser
        {
            private readonly string _s;
            private int _i;

            public Parser(string s) { _s = s ?? ""; _i = 0; }
            public int Pos => _i;
            public bool AtEnd => _i >= _s.Length;

            public void SkipWhitespace()
            {
                while (_i < _s.Length)
                {
                    char c = _s[_i];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') _i++;
                    else break;
                }
            }

            public JsonValue ParseValue()
            {
                SkipWhitespace();
                if (AtEnd) throw new FormatException("JSON: unexpected end of input");
                char c = _s[_i];
                switch (c)
                {
                    case '{': return ParseObject();
                    case '[': return ParseArray();
                    case '"': return JsonValue.Of(ParseString());
                    case 't': Expect("true"); return JsonValue.Of(true);
                    case 'f': Expect("false"); return JsonValue.Of(false);
                    case 'n': Expect("null"); return JsonValue.Null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
                        throw new FormatException("JSON: unexpected char '" + c + "' at " + _i);
                }
            }

            private JsonValue ParseObject()
            {
                var obj = JsonValue.NewObject();
                _i++; // consume '{'
                SkipWhitespace();
                if (!AtEnd && _s[_i] == '}') { _i++; return obj; }
                while (true)
                {
                    SkipWhitespace();
                    if (AtEnd || _s[_i] != '"')
                        throw new FormatException("JSON: expected object key at " + _i);
                    string key = ParseString();
                    SkipWhitespace();
                    if (AtEnd || _s[_i] != ':')
                        throw new FormatException("JSON: expected ':' at " + _i);
                    _i++; // consume ':'
                    var val = ParseValue();
                    obj[key] = val;
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("JSON: unterminated object");
                    char c = _s[_i++];
                    if (c == ',') continue;
                    if (c == '}') break;
                    throw new FormatException("JSON: expected ',' or '}' at " + (_i - 1));
                }
                return obj;
            }

            private JsonValue ParseArray()
            {
                var arr = JsonValue.NewArray();
                _i++; // consume '['
                SkipWhitespace();
                if (!AtEnd && _s[_i] == ']') { _i++; return arr; }
                while (true)
                {
                    var val = ParseValue();
                    arr.Add(val);
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("JSON: unterminated array");
                    char c = _s[_i++];
                    if (c == ',') continue;
                    if (c == ']') break;
                    throw new FormatException("JSON: expected ',' or ']' at " + (_i - 1));
                }
                return arr;
            }

            private string ParseString()
            {
                // assumes _s[_i] == '"'
                _i++; // consume opening quote
                var sb = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw new FormatException("JSON: unterminated string");
                    char c = _s[_i++];
                    if (c == '"') break;
                    if (c == '\\')
                    {
                        if (AtEnd) throw new FormatException("JSON: unterminated escape");
                        char e = _s[_i++];
                        switch (e)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                sb.Append(ParseUnicodeEscape());
                                break;
                            default:
                                throw new FormatException("JSON: invalid escape '\\" + e + "'");
                        }
                    }
                    else
                    {
                        sb.Append(c);
                    }
                }
                return sb.ToString();
            }

            private char ParseUnicodeEscape()
            {
                if (_i + 4 > _s.Length)
                    throw new FormatException("JSON: truncated \\u escape");
                int code = 0;
                for (int k = 0; k < 4; k++)
                {
                    code = (code << 4) | HexDigit(_s[_i++]);
                }
                // We return a single char; surrogate pairs come through as two
                // consecutive \u escapes and are appended individually, which
                // reconstitutes the supplementary code point correctly in the
                // resulting C# UTF-16 string.
                return (char)code;
            }

            private static int HexDigit(char c)
            {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                throw new FormatException("JSON: invalid hex digit '" + c + "'");
            }

            private JsonValue ParseNumber()
            {
                int start = _i;
                if (!AtEnd && _s[_i] == '-') _i++;
                while (!AtEnd && _s[_i] >= '0' && _s[_i] <= '9') _i++;
                if (!AtEnd && _s[_i] == '.')
                {
                    _i++;
                    while (!AtEnd && _s[_i] >= '0' && _s[_i] <= '9') _i++;
                }
                if (!AtEnd && (_s[_i] == 'e' || _s[_i] == 'E'))
                {
                    _i++;
                    if (!AtEnd && (_s[_i] == '+' || _s[_i] == '-')) _i++;
                    while (!AtEnd && _s[_i] >= '0' && _s[_i] <= '9') _i++;
                }
                string num = _s.Substring(start, _i - start);
                double d = double.Parse(num, NumberStyles.Float, CultureInfo.InvariantCulture);
                return JsonValue.Of(d);
            }

            private void Expect(string literal)
            {
                if (_i + literal.Length > _s.Length ||
                    string.CompareOrdinal(_s, _i, literal, 0, literal.Length) != 0)
                {
                    throw new FormatException("JSON: expected '" + literal + "' at " + _i);
                }
                _i += literal.Length;
            }
        }
    }
}
