/**
 * Unity-aware rendering of DAP variable values. The mono-debug adapter returns
 * values as strings + a type name; we post-process common Unity types so the
 * Variables/Watch panels read like Unity's own inspector rather than raw CLR
 * dumps. Best-effort and purely cosmetic — the raw value is always preserved.
 */

export interface RawVariable {
  name: string;
  value: string;
  type?: string;
}

export interface RenderedValue {
  display: string;
  /** CSS color when the value is a UnityEngine.Color/Color32 (for a swatch). */
  swatch?: string;
}

const VECTOR_RE = /\(?\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:,\s*(-?\d+(?:\.\d+)?))?(?:,\s*(-?\d+(?:\.\d+)?))?\s*\)?/;

function isUnityObjectType(type?: string): boolean {
  if (!type) return false;
  return /UnityEngine\.(GameObject|Transform|Component|MonoBehaviour|Object|Rigidbody|Collider|Renderer)/.test(
    type,
  );
}

function num(s: string): string {
  // Trim trailing zeros for compact display (3.140000 → 3.14).
  const n = Number(s);
  return Number.isFinite(n) ? String(parseFloat(n.toFixed(4))) : s;
}

export function renderValue(v: RawVariable): RenderedValue {
  const type = v.type ?? '';
  const value = v.value ?? '';

  // Destroyed UnityEngine.Object: the C# "fake null" — show it honestly.
  if (isUnityObjectType(type) && /^(null|\(null\))$/i.test(value.trim())) {
    return { display: '<destroyed-or-null>' };
  }

  // Vector2/3/4 and Quaternion → (x, y, z[, w]).
  if (/UnityEngine\.(Vector2|Vector3|Vector4|Quaternion)/.test(type)) {
    const m = VECTOR_RE.exec(value);
    if (m) {
      const parts = [m[1], m[2], m[3], m[4]].filter((p) => p != null).map(num);
      return { display: `(${parts.join(', ')})` };
    }
  }

  // Color / Color32 → swatch + RGBA.
  if (/UnityEngine\.Color(32)?/.test(type)) {
    const m = VECTOR_RE.exec(value);
    if (m) {
      const is32 = /Color32/.test(type);
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      const a = m[4] != null ? Number(m[4]) : is32 ? 255 : 1;
      const to255 = (c: number) => (is32 ? Math.round(c) : Math.round(c * 255));
      const swatch = `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${is32 ? a / 255 : a})`;
      const parts = [m[1], m[2], m[3], m[4]].filter((p) => p != null).map(num);
      return { display: `(${parts.join(', ')})`, swatch };
    }
  }

  // GameObject / Component → "name (type)" if the adapter gives a useful string.
  if (isUnityObjectType(type) && value && value !== type) {
    return { display: value };
  }

  return { display: value };
}
