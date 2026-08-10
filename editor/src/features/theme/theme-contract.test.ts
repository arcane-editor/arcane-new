/**
 * Executable version of the token contract documented in `types.ts`.
 *
 * Themes broke in the past not because a palette was ugly but because the
 * MECHANISM had no invariants: `--hover` was a 4% overlay in the Arcane themes
 * and an opaque slab in the four VS Code-derived ones, so no single CSS rule
 * could be right in both; `--bg-hover` was referenced 19 times and defined by
 * nobody, so those hovers silently did nothing; `--overlay-shadow` was a bare
 * colour used as a `box-shadow`, which is invalid and rendered no shadow at all.
 *
 * Each of those is a rule below. The section headers in `types.ts` are the
 * single source of truth for which token belongs to which class — this file
 * parses them rather than restating them, so the doc and the test cannot drift.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getAllThemes } from './registry';
import type { ThemeDefinition } from './types';

const THEME_DIR = import.meta.dir;
const EDITOR_ROOT = join(THEME_DIR, '..', '..', '..');
const SRC = join(EDITOR_ROOT, 'src');

const themes: ThemeDefinition[] = getAllThemes();

// ─── colour helpers ──────────────────────────────────────────────────

interface Rgba { r: number; g: number; b: number; a: number }

function parseColor(value: string): Rgba | null {
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: n(6) / 255 };
  }
  const fn = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
  if (fn) {
    return { r: +fn[1], g: +fn[2], b: +fn[3], a: fn[4] === undefined ? 1 : +fn[4] };
  }
  return null;
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const ch = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio. Both colours must be opaque for this to be meaningful. */
function contrast(fg: string, bg: string): number {
  const f = parseColor(fg), b = parseColor(bg);
  if (!f || !b) return NaN;
  const [hi, lo] = [relativeLuminance(f), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE Lab. Perceptually uniform, so straight-line distance means something. */
function toLab(color: string): [number, number, number] | null {
  const c = parseColor(color);
  if (!c) return null;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** ΔE76. Below ~6 two colours are not reliably tellable apart. */
function deltaE(a: string, b: string): number {
  const A = toLab(a), B = toLab(b);
  if (!A || !B) return NaN;
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/** CIE L* — perceptual lightness, 0 (black) to 100 (white). */
function lightness(color: string): number {
  const c = parseColor(color);
  if (!c) return NaN;
  const y = relativeLuminance(c);
  const f = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  return 116 * f - 16;
}

/**
 * Perceptual distance between two SURFACES.
 *
 * Deliberately not `contrast()`. WCAG's ratio is built for text legibility and
 * saturates near black — its +0.05 flare constant dominates once both
 * luminances are under ~0.01, so it reports ≈1.0 for any two dark surfaces no
 * matter how different they look. That is precisely the regime a dark IDE's
 * chrome lives in, and it is why a ramp of twelve tokens carrying effectively
 * one value passed every check for so long. ΔL* ≈ 1 is at the threshold of
 * perceptibility; ≈ 3 is a clearly visible step.
 */
function surfaceStep(a: string, b: string): number {
  return Math.abs(lightness(a) - lightness(b));
}

// ─── the contract, parsed out of types.ts ────────────────────────────

type TokenClass = 'SURFACE' | 'FILL' | 'OVERLAY' | 'CONTENT' | 'SHADOWS';

function tokenClasses(): Record<TokenClass, string[]> {
  const src = readFileSync(join(THEME_DIR, 'types.ts'), 'utf8');
  const body = src.slice(src.indexOf('export interface UiColors'));
  const out: Record<string, string[]> = { SURFACE: [], FILL: [], OVERLAY: [], CONTENT: [], SHADOWS: [] };
  let current: TokenClass | null = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('}')) break;
    const header = line.match(/\/\/ ── (SURFACE|FILL|OVERLAY|CONTENT|SHADOWS)/);
    if (header) { current = header[1] as TokenClass; continue; }
    const key = line.match(/^\s*'([\w-]+)':\s*string;/);
    if (key && current) out[current].push(key[1]);
  }
  return out as Record<TokenClass, string[]>;
}

const CLASSES = tokenClasses();
const ALL_TOKENS = Object.values(CLASSES).flat();

describe('token contract is parseable', () => {
  it('assigns every UiColors key to exactly one semantic class', () => {
    expect(ALL_TOKENS.length).toBeGreaterThan(40);
    expect(new Set(ALL_TOKENS).size).toBe(ALL_TOKENS.length);
  });

  it('registers all six themes', () => {
    expect(themes.map((t) => t.id).sort()).toEqual([
      'arcane-dark', 'arcane-light', 'dark-plus', 'dracula', 'light-plus', 'monokai',
    ]);
  });
});

describe.each(themes.map((t) => [t.id, t] as const))('%s', (_id, theme) => {
  it('defines every token in the contract', () => {
    const missing = ALL_TOKENS.filter((t) => !(t in theme.ui));
    const extra = Object.keys(theme.ui).filter((k) => !ALL_TOKENS.includes(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('every colour token parses', () => {
    const bad = ALL_TOKENS
      .filter((t) => !CLASSES.SHADOWS.includes(t))
      .filter((t) => parseColor(theme.ui[t as keyof typeof theme.ui]) === null)
      .map((t) => `${t}=${theme.ui[t as keyof typeof theme.ui]}`);
    expect(bad).toEqual([]);
  });

  // A surface is the only opaque thing under a floating element. If it is
  // translucent, whatever is behind it reads through.
  it('SURFACE tokens are fully opaque', () => {
    const bad = CLASSES.SURFACE
      .map((t) => [t, theme.ui[t as keyof typeof theme.ui]] as const)
      .filter(([, v]) => (parseColor(v)?.a ?? 1) < 1)
      .map(([t, v]) => `${t}=${v}`);
    expect(bad).toEqual([]);
  });

  // A fill REPLACES a row's background, so it must hide what it covers.
  it('FILL tokens are fully opaque', () => {
    const bad = CLASSES.FILL
      .map((t) => [t, theme.ui[t as keyof typeof theme.ui]] as const)
      .filter(([, v]) => (parseColor(v)?.a ?? 1) < 1)
      .map(([t, v]) => `${t}=${v}`);
    expect(bad).toEqual([]);
  });

  // An overlay is composited ON something. Opaque here means it erases the
  // layer it was supposed to tint.
  it('OVERLAY tokens are translucent', () => {
    const bad = CLASSES.OVERLAY
      .map((t) => [t, theme.ui[t as keyof typeof theme.ui]] as const)
      .filter(([, v]) => (parseColor(v)?.a ?? 1) >= 1)
      .map(([t, v]) => `${t}=${v}`);
    expect(bad).toEqual([]);
  });

  // `box-shadow: rgba(...)` is invalid and renders nothing.
  it('SHADOW tokens are complete box-shadow lists, not bare colours', () => {
    const bad = CLASSES.SHADOWS
      .map((t) => [t, theme.ui[t as keyof typeof theme.ui]] as const)
      .filter(([, v]) => parseColor(v) !== null || !/\d/.test(v))
      .map(([t, v]) => `${t}=${v}`);
    expect(bad).toEqual([]);
  });

  it('body text clears WCAG AA on every surface it sits on', () => {
    const failures: string[] = [];
    for (const bg of ['bg-primary', 'bg-sidebar', 'bg-input'] as const) {
      const r = contrast(theme.ui['text-primary'], theme.ui[bg]);
      if (r < 4.5) failures.push(`text-primary on ${bg} = ${r.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it('secondary text and accents clear the 3:1 UI-text floor', () => {
    const failures: string[] = [];
    for (const [fg, bg] of [
      ['text-secondary', 'bg-primary'], ['text-secondary', 'bg-sidebar'],
      ['accent', 'bg-primary'], ['accent', 'bg-sidebar'],
    ] as const) {
      const r = contrast(theme.ui[fg], theme.ui[bg]);
      if (r < 3) failures.push(`${fg} on ${bg} = ${r.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  // The regression this was written for: `bg-statusbar` is VS Code blue in the
  // +Plus themes regardless of theme type, so no `[data-theme-type]` rule can
  // pick its foreground. Each theme states it, and it has to be readable.
  it('status bar text clears WCAG AA on its own bar', () => {
    const r = contrast(theme.ui['statusbar-fg'], theme.ui['bg-statusbar']);
    expect(r).toBeGreaterThanOrEqual(4.5);
  });

  it('primary button text clears WCAG AA on its own button', () => {
    const r = contrast(theme.ui['button-primary-text'], theme.ui['button-primary-bg']);
    expect(r).toBeGreaterThanOrEqual(4.5);
  });

  // A serialized field is a HEALTHY field. The first version of this feature
  // painted `unity-inspector` #D4879A while `error-border` was #C97A8A — ΔE 5.2,
  // which is under the threshold where two colours are tellable apart at all —
  // and put it on a tinted whole-line band. A real MonoBehaviour carries six or
  // seven [SerializeField]s, so every file looked like a list of problems.
  //
  // Enforced for all six themes: unlike the syntax-contrast rule this is not
  // about fidelity to an upstream palette, it is about our own feature not
  // impersonating a diagnostic.
  it('does not colour Inspector fields like errors', () => {
    const failures: string[] = [];
    for (const err of ['error-border', 'error-text'] as const) {
      const d = deltaE(theme.ui['unity-inspector'], theme.ui[err]);
      if (d < 20) {
        failures.push(
          `unity-inspector ${theme.ui['unity-inspector']} vs ${err} ${theme.ui[err]} ΔE=${d.toFixed(1)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('hover and selected fills are distinguishable from the surfaces they sit on', () => {
    for (const bg of ['bg-primary', 'bg-sidebar'] as const) {
      for (const fill of ['hover', 'selected'] as const) {
        expect(theme.ui[fill]).not.toBe(theme.ui[bg]);
      }
    }
  });
});

// ─── syntax contrast ─────────────────────────────────────────────────
//
// The `ui` contrast tests above have existed for a while. `monaco.rules` and
// `monaco.colors` never had any, which is how `comment` sat at 2.72:1 in
// arcane-dark and 2.75:1 in arcane-light through a green suite — roughly 40%
// of a typical C# file rendered below the AA floor.
//
// Enforced for the Arcane themes ONLY. The other four are faithful ports and
// their palettes are upstream's decision, not ours; an audit at the time of
// writing found monokai with 11 rules under 4.5:1 (its signature #F92672 sits
// at 3.93) and dracula's canonical comment blue #6272A4 at 3.03. Holding them
// to AA would mean not shipping Monokai or Dracula.
const CONTRAST_ENFORCED = new Set(['arcane-dark', 'arcane-light']);

const enforced = themes.filter((t) => CONTRAST_ENFORCED.has(t.id));

describe.each(enforced.map((t) => [t.id, t] as const))('%s syntax contrast', (_id, theme) => {
  const bg = theme.monaco.colors['editor.background'];

  it('declares an editor background to measure against', () => {
    expect(parseColor(bg)).not.toBeNull();
  });

  // `monaco.rules` foregrounds are bare hex with no leading '#'.
  it('every syntax rule clears WCAG AA on the editor background', () => {
    const failures = theme.monaco.rules
      .filter((r) => r.foreground)
      .map((r) => [r.token, `#${r.foreground!.replace(/^#/, '')}`] as const)
      .map(([token, fg]) => [token, fg, contrast(fg, bg)] as const)
      .filter(([, , ratio]) => ratio < 4.5)
      .map(([token, fg, ratio]) => `${token}=${fg} ${ratio.toFixed(2)}`);
    expect([...new Set(failures)]).toEqual([]);
  });

  // Line numbers are supporting UI, not body copy: 3:1, not 4.5:1.
  it('line numbers clear the 3:1 non-text floor', () => {
    const failures: string[] = [];
    for (const key of ['editorLineNumber.foreground', 'editorLineNumber.activeForeground']) {
      const fg = theme.monaco.colors[key];
      if (!fg) continue;
      const ratio = contrast(fg, bg);
      if (ratio < 3) failures.push(`${key}=${fg} ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it('terminal text clears WCAG AA on the terminal background', () => {
    const ratio = contrast(theme.terminal.foreground, theme.terminal.background);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  // The elevation ladder. Arcane Dark once had twelve surface tokens whose
  // values sat within ~2% luminance of each other, so the whole window read as
  // one flat sheet and every region boundary depended on a 5%-white hairline.
  // These regions carry no border by design — the step IS the separator — so
  // if the step collapses there is nothing left to see.
  it('keeps a visible step between adjacent shell surfaces', () => {
    const pairs = [
      ['bg-primary', 'bg-sidebar'],
      ['bg-sidebar', 'bg-activity-bar'],
      ['bg-primary', 'bg-titlebar'],
    ] as const;
    const failures = pairs
      .map(([a, b]) => [a, b, surfaceStep(theme.ui[a], theme.ui[b])] as const)
      .filter(([, , step]) => step < 1.5)
      .map(([a, b, step]) => `${a}↔${b} ΔL*=${step.toFixed(2)}`);
    expect(failures).toEqual([]);
  });
});

// ─── stylesheet references must resolve ──────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(css|tsx|ts)$/.test(p) && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Blanks out block comments and whole-line `//` comments, preserving line count. */
function stripComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

describe('every custom-property reference resolves', () => {
  it('has no reference to a token that no theme and no :root block defines', () => {
    const files = sourceFiles(SRC);

    // Tokens can also come from a plain CSS `--x: value` declaration (the font
    // stacks live in App.css's :root, not in the themes).
    const cssDefined = new Set<string>();
    const references = new Map<string, string[]>();

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?<!var\()--([\w-]+)\s*:/g)) cssDefined.add(m[1]);
      // Prose in doc comments talks about tokens without referencing them.
      stripComments(text).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/var\(\s*--([\w-]+)\s*\)/g)) {
          // Bare references only: one WITH a fallback still renders something.
          const where = `${file.slice(EDITOR_ROOT.length + 1)}:${i + 1}`;
          references.set(m[1], [...(references.get(m[1]) ?? []), where]);
        }
      });
    }

    const known = new Set([...ALL_TOKENS, ...cssDefined]);
    const dangling: string[] = [];
    for (const [token, where] of references) {
      if (known.has(token)) continue;
      dangling.push(`--${token} (${where.length}x, e.g. ${where[0]})`);
    }
    expect(dangling).toEqual([]);
  });
});
