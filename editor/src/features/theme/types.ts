/**
 * Every key here is published to the document as `--<key>` by `applyCssVariables`,
 * so this interface IS the stylesheet's contract: if App.css says `var(--x)`,
 * `x` must be a key below or the declaration is invalid at computed-value time
 * and silently drops (backgrounds fall back to transparent, fonts to inherited).
 *
 * The keys are grouped by SEMANTIC CLASS, and each class carries an invariant
 * every theme must satisfy. The classes exist because a colour's alpha decides
 * where it may legally be used, and a token that is translucent in one theme and
 * opaque in another cannot be used correctly by any single CSS rule:
 *
 *   SURFACE — always OPAQUE. Painted as the sole backdrop of a region, including
 *             floating elements with nothing opaque behind them.
 *   FILL    — always OPAQUE. Replaces a row/button's background outright; it must
 *             hide whatever it covers.
 *   OVERLAY — always TRANSLUCENT. Composited ON TOP of an existing surface; used
 *             where the layer underneath must remain visible.
 *   CONTENT — foreground colours (text, icons, borders, accents). Alpha is free.
 *
 * `theme-contract.test.ts` enforces all of this — both the invariants above and
 * the "no CSS reference without a token" rule. Adding a token means adding it to
 * all six definitions; the compiler enforces that part.
 */
export interface UiColors {
  // ── SURFACE (opaque) ──────────────────────────────────────────────
  'bg-primary': string;
  'bg-sidebar': string;
  'bg-titlebar': string;
  'bg-tab-active': string;
  'bg-tab-inactive': string;
  /** May be a saturated accent independent of the theme's light/dark type — the
   *  +Plus themes paint this VS Code blue. Never derive its foreground from the
   *  theme type; always pair it with `statusbar-fg`. */
  'bg-statusbar': string;
  'bg-activity-bar': string;
  'bg-breadcrumbs': string;
  'bg-input': string;
  'surface-container-high': string;
  'surface-container-highest': string;
  'surface-bright': string;

  // ── FILL (opaque) ─────────────────────────────────────────────────
  /** Hover fill for rows, menu items and icon buttons sitting on a known surface.
   *  For tinting something layered over content, use `hover-overlay` instead. */
  'hover': string;
  /** Active/selected row fill. */
  'selected': string;

  // ── OVERLAY (translucent) ─────────────────────────────────────────
  'hover-overlay': string;
  'statusbar-hover': string;
  'badge-bg': string;
  'modal-backdrop': string;
  'error-bg': string;
  'warning-bg': string;
  'info-bg': string;
  'scrollbar-thumb': string;
  'scrollbar-thumb-hover': string;
  'focus-ring': string;
  /** Tints the line behind an Inspector-facing field. Composited over the
   *  editor background, so it must stay translucent. */
  'unity-inspector-rail': string;

  // ── CONTENT (alpha free) ──────────────────────────────────────────
  'text-primary': string;
  'text-secondary': string;
  'text-active': string;
  'text-breadcrumb': string;
  'text-breadcrumb-active': string;
  /** Title-bar foreground. Despite the name it is dark in light themes — it means
   *  "on the title bar", not "on a dark surface". */
  'text-on-dark': string;
  /** Status-bar foreground, stated per theme because `bg-statusbar` can be a
   *  saturated accent that no theme-type rule could predict. */
  'statusbar-fg': string;
  'border': string;
  'ghost-border': string;
  'accent': string;
  'accent-secondary': string;
  'primary-light': string;
  'git-modified': string;
  'git-added': string;
  'git-deleted': string;
  'git-untracked': string;
  'error-border': string;
  'error-text': string;
  'editor-error-btn': string;
  'editor-error-btn-hover': string;
  'folder-icon': string;
  'warning': string;
  'info': string;
  'success': string;
  /** A method the engine calls — Awake, Update, OnTriggerEnter. Gold in the
   *  Arcane themes: this is the accent's one job inside the editor. */
  'unity-lifecycle': string;
  /** A UnityEngine type — MonoBehaviour, Vector3, Time — as distinct from a
   *  type the user wrote. */
  'unity-engine-type': string;
  /** The RAIL marking a field that surfaces in the Inspector — not a text
   *  colour. `[SerializeField]` and `[Header]` are UnityEngine types and are
   *  coloured as such; Inspector-ness is structural, so it is drawn in the
   *  margin instead of competing for a hue the palette does not have spare.
   *  Use the theme's accent: together with the gold lifecycle glyph it says
   *  "this is Unity's surface of your class". */
  'unity-inspector': string;
  'button-primary-bg': string;
  'button-primary-text': string;
  'button-primary-hover': string;
  'button-danger-bg': string;
  'button-danger-text': string;
  'avatar-gradient-start': string;
  'avatar-gradient-end': string;
  'avatar-text': string;

  // ── SHADOWS (complete box-shadow lists, NOT bare colours) ─────────
  /** Must be a full shadow list (`0 8px 24px rgba(...)`). A bare colour here is
   *  not a valid `box-shadow` value and renders no shadow at all. */
  'modal-shadow': string;
}

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black';
  inherit: boolean;
  rules: Array<{
    token: string;
    foreground?: string;
    background?: string;
    fontStyle?: string;
  }>;
  colors: Record<string, string>;
}

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  type: 'dark' | 'light';
  ui: UiColors;
  monaco: MonacoThemeData;
  terminal: TerminalColors;
}
