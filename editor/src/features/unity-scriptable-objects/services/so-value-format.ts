// ── Value coercion, both directions ─────────────────────────────────────────
//
// Where Unity's serialization quirks live. Pure and separately tested, because
// getting one of these backwards writes a plausible-looking wrong value rather
// than failing loudly:
//
//  • a bool is `0`/`1`, not `false`/`true`
//  • an enum is its INTEGER, never its member name
//  • a float that was written `1` must come back `1`, not `1.0` — otherwise
//    every no-op edit rewrites the file and the whole team sees a diff

import type { SoField } from '../../unity-analyzers';

/** Display text for a raw YAML value, given the field's widget. */
export function toDisplay(raw: string, field: SoField): string {
  const v = raw.trim();
  switch (field.widget) {
    case 'bool':
      return v === '1' ? 'true' : v === '0' ? 'false' : v;
    case 'string':
      return decodeYamlString(v);
    default:
      return v;
  }
}

/** Strip YAML quoting from a scalar, undoubling `''`. */
export function decodeYamlString(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v;
}

/**
 * Quote a string the way Unity does: plain when unambiguous, single-quoted with
 * `'` doubled otherwise.
 *
 * Mirrors `encode_yaml_string` in Rust. Both exist because the editor needs to
 * show what WILL be written before writing it; the Rust one is authoritative
 * and validates whatever arrives.
 */
export function encodeYamlString(value: string): string {
  const needsQuotes =
    value.length === 0 ||
    value !== value.trim() ||
    /['":#,{}[\]\n\r\t]/.test(value) ||
    /^[|>&*!%@`\-?]/.test(value) ||
    /^(yes|no|true|false|null|~)$/i.test(value) ||
    (value.trim() !== '' && Number.isFinite(Number(value)));

  if (!needsQuotes) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** Outcome of turning a UI draft back into bytes. */
export type EncodeResult =
  | { ok: true; raw: string }
  | { ok: false; error: string };

/**
 * Encode a draft value for a field.
 *
 * Clamping happens here rather than in the widget so a value typed into a text
 * box obeys `[Range]` exactly as a dragged slider does.
 */
export function encodeValue(draft: string, field: SoField): EncodeResult {
  const v = draft.trim();

  switch (field.widget) {
    case 'bool':
      if (v === 'true' || v === '1') return { ok: true, raw: '1' };
      if (v === 'false' || v === '0') return { ok: true, raw: '0' };
      return { ok: false, error: 'Expected true or false.' };

    case 'int': {
      if (!/^[-+]?\d+$/.test(v)) return { ok: false, error: 'Expected a whole number.' };
      const n = clamp(Number(v), field);
      return { ok: true, raw: String(Math.trunc(n)) };
    }

    case 'float': {
      if (v === '' || !Number.isFinite(Number(v))) {
        return { ok: false, error: 'Expected a number.' };
      }
      const n = clamp(Number(v), field);
      // Preserve the user's own spelling when it is already in range and
      // unchanged in value — `12` must not become `12.0`.
      return { ok: true, raw: n === Number(v) ? v : String(n) };
    }

    case 'enum':
    case 'enumFlags': {
      if (/^[-+]?\d+$/.test(v)) return { ok: true, raw: String(Number(v)) };
      const member = field.enumMembers?.find((m) => m.name === v);
      if (!member) return { ok: false, error: `Not a member of ${field.bareType}.` };
      // Unity serializes the ordinal, never the name.
      return { ok: true, raw: String(member.value) };
    }

    case 'string':
      return { ok: true, raw: encodeYamlString(draft) };

    default:
      return { ok: false, error: 'This field is not editable here.' };
  }
}

function clamp(n: number, field: SoField): number {
  let out = n;
  if (field.range) out = Math.min(field.range.max, Math.max(field.range.min, out));
  if (field.min !== null) out = Math.max(field.min, out);
  return out;
}

/** The label to show for an enum value, falling back to the raw ordinal. */
export function enumLabel(raw: string, field: SoField): string {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return raw;
  return field.enumMembers?.find((m) => m.value === n)?.name ?? raw;
}
