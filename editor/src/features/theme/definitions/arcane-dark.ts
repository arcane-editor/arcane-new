import type { ThemeDefinition } from '../types';

// Arcane Dark — "Midnight Cathedral & Candle Gold".
// Cool violet-black canvas with one signature accent (candle gold) reserved
// for active states, plus a magenta-ember used sparingly for errors / dirty
// indicators / JSX tags. Body text is near-neutral with 1% warmth so the
// overall gestalt reads as "dark IDE with a metallic accent" rather than
// "orange-and-brown."
const arcaneDark: ThemeDefinition = {
  id: 'arcane-dark',
  name: 'Arcane Dark',
  type: 'dark',
  ui: {
    // Recessed Chrome: chrome sinks, the editor is the brightest plane. The
    // luminance step IS the separator — editor-to-sidebar goes from 1.02:1 to
    // 1.9:1 — so no region needs a border. `border` below is untouched: the
    // shell regions never used it, and its 84 references are all controls.
    'bg-primary': '#16151F',
    'bg-sidebar': '#0F0E16',
    'bg-titlebar': '#0B0A10',
    // Equal to `bg-primary` on purpose: the active tab reads as continuous
    // with its content. `.tab.active::after` in App.css already draws a 2px
    // accent top rule, keyed on `.active` alone, so every tab state keeps a
    // marker without a fill difference.
    'bg-tab-active': '#16151F',
    'bg-tab-inactive': '#0F0E16',
    'bg-statusbar': '#0B0A10',
    'bg-activity-bar': '#08070C',
    'bg-breadcrumbs': '#0F0E16',
    'bg-input': '#1C1A26',
    'text-primary': '#E2E0DA',
    'text-secondary': '#7E7B86',
    'text-active': '#F4F2EC',
    'text-breadcrumb': '#5C5965',
    'text-breadcrumb-active': '#E2E0DA',
    'text-on-dark': '#E2E0DA',
    // on #0E0D11 near-black
    'statusbar-fg': '#E2E0DA',
    'border': 'rgba(255, 255, 255, 0.05)',
    'accent': '#D4B062',
    'accent-secondary': '#E8C97D',
    // Opaque per the FILL contract in types.ts — a fill replaces a row's
    // background outright, so it has to hide what it covers. Both sit one and
    // two steps up the surface ramp respectively, which is what keeps them
    // legible against the darker chrome as well as against the editor.
    'hover': '#1C1A26',
    'selected': '#252034',
    'git-modified': '#E0B048',
    'git-added': '#7DA66B',
    'git-deleted': '#C97A8A',
    'git-untracked': '#7DA66B',
    'badge-bg': 'rgba(212, 176, 98, 0.16)',
    'hover-overlay': 'rgba(255, 255, 255, 0.04)',
    'statusbar-hover': 'rgba(255, 255, 255, 0.05)',
    'error-bg': 'rgba(201, 122, 138, 0.12)',
    'error-border': '#C97A8A',
    'error-text': '#D89AA5',
    'editor-error-btn': '#C97A8A',
    'editor-error-btn-hover': '#D89AA5',
    'folder-icon': '#7E7B86',
    'surface-container-high': '#1C1A26',
    'surface-container-highest': '#242232',
    'surface-bright': '#2E2B3C',
    'primary-light': '#E8C97D',
    'ghost-border': 'rgba(212, 176, 98, 0.18)',
    'warning': '#E0B048',
    'warning-bg': 'rgba(224, 176, 72, 0.10)',
    'info': '#7B9CB5',
    'info-bg': 'rgba(123, 156, 181, 0.10)',
    'success': '#7DA66B',
    // Unity semantics. Gold is absent from `monaco.rules` now; this is where
    // it comes back — on the handful of methods per file the engine calls.
    'unity-lifecycle': '#E8C97D',
    'unity-engine-type': '#8FBEDA',
    // The rail, not a text colour. Rose read as an error (ΔE 5.2 from
    // `error-border`) and lavender-grey read as a comment (ΔE 26 from it, but
    // the same low-chroma violet family) — the six syntax roles leave no hue
    // spare, so Inspector-ness stops competing for one and becomes structural.
    // The accent ties it to the gold lifecycle glyph: both mark Unity's
    // surface of your class.
    'unity-inspector': '#D4B062',
    // A whisper, not a band — this only groups consecutive fields.
    'unity-inspector-rail': 'rgba(212, 176, 98, 0.055)',
    'modal-backdrop': 'rgba(8, 7, 14, 0.55)',
    'modal-shadow': '0 16px 48px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.06)',
    'scrollbar-thumb': 'rgba(255, 255, 255, 0.10)',
    'scrollbar-thumb-hover': 'rgba(255, 255, 255, 0.20)',
    'focus-ring': 'rgba(212, 176, 98, 0.55)',
    'button-primary-bg': '#D4B062',
    'button-primary-text': '#0E0D11',
    'button-primary-hover': '#E8C97D',
    'button-danger-bg': '#C97A8A',
    'button-danger-text': '#0E0D11',
    'avatar-gradient-start': '#E8C97D',
    'avatar-gradient-end': '#A88542',
    'avatar-text': '#0E0D11',
  },
  monaco: {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Six roles, each with its own hue. Gold is deliberately absent: it is
      // the chrome accent, and it used to resolve eight of these tokens at
      // once, which is why `public` and `Awake` were nearly the same colour.
      // It returns only via the Unity decoration layer, on the ~4 identifiers
      // per file the engine actually calls.
      { token: 'comment', foreground: '827E94', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'C79BE0' },
      { token: 'string', foreground: '8FBE7A' },
      { token: 'number', foreground: 'E0A76B' },
      { token: 'type', foreground: '8FBEDA' },
      { token: 'function', foreground: '7FD1C4' },
      { token: 'variable', foreground: 'DCD9E4' },
      { token: 'constant', foreground: 'E0A76B' },
      { token: 'parameter', foreground: 'C6C2CE' },
      { token: 'property', foreground: '8FBEDA' },
      // `tag` keeps the rose: pink tags are the convention in JSX/HTML and
      // nothing there looks like an error. C# attributes take the TYPE colour,
      // because that is what they are — `[SerializeField]` is
      // `SerializeFieldAttribute`. Rose made a .cs file read as a column of
      // alarms (one step from `error-text` #D89AA5) and grey made it read as
      // commented-out. Typing them as types needs no hue the palette lacks.
      { token: 'tag', foreground: 'D4879A' },
      { token: 'attribute.name', foreground: '8FBEDA' },
      { token: 'attribute.value', foreground: '8FBE7A' },
      { token: 'delimiter', foreground: '8B8798' },
      { token: 'operator', foreground: 'C79BE0' },
      { token: 'regexp', foreground: '8FBE7A' },

      // --- Keywords & Storage ---
      { token: 'keyword.control', foreground: 'C79BE0', fontStyle: 'italic' },
      { token: 'keyword.operator.new', foreground: 'C79BE0' },
      { token: 'keyword.operator.expression', foreground: 'C79BE0' },
      { token: 'storage', foreground: 'C79BE0' },
      { token: 'storage.type', foreground: '8FBEDA' },
      { token: 'storage.modifier', foreground: 'C79BE0' },

      // --- Variables & Constants ---
      { token: 'variable.language', foreground: 'D4879A', fontStyle: 'italic' },
      { token: 'variable.other.constant', foreground: 'E0A76B' },
      { token: 'constant.language', foreground: 'C79BE0' },

      // --- Entities & Support ---
      { token: 'entity.name.function', foreground: '7FD1C4' },
      { token: 'entity.name.class', foreground: '8FBEDA' },
      { token: 'entity.name.type', foreground: '8FBEDA' },
      { token: 'support.function', foreground: '7FD1C4' },
      { token: 'support.class', foreground: '8FBEDA' },
      { token: 'support.type', foreground: '8FBEDA' },

      // --- JSX/TSX ---
      { token: 'entity.name.tag', foreground: 'D4879A' },
      { token: 'support.class.component', foreground: '8FBEDA' },

      // --- Punctuation & Delimiters ---
      { token: 'meta.brace.round', foreground: '8B8798' },
      { token: 'meta.brace.square', foreground: '8B8798' },
      { token: 'meta.brace.curly', foreground: 'C79BE0' },
      { token: 'punctuation.separator', foreground: '8B8798' },
      { token: 'string.template', foreground: '8FBE7A' },
      { token: 'punctuation.definition.template-expression', foreground: 'C79BE0' },

      // --- Decorators ---
      { token: 'meta.decorator', foreground: '8FBEDA' },
    ],
    colors: {
      'editor.background': '#16151F',
      'editor.foreground': '#E2E0DA',
      'editorCursor.foreground': '#D4B062',
      'editor.lineHighlightBackground': '#1C1A26',
      'editor.lineHighlightBorder': '#1C1A26',
      'editor.selectionBackground': 'rgba(212, 176, 98, 0.20)',
      'editor.selectionHighlightBackground': 'rgba(212, 176, 98, 0.12)',
      'editor.wordHighlightBackground': 'rgba(212, 176, 98, 0.10)',
      'editor.findMatchBackground': 'rgba(212, 176, 98, 0.30)',
      'editor.findMatchHighlightBackground': 'rgba(212, 176, 98, 0.14)',
      // #3A3845 was 1.62:1 — effectively invisible. #656274 is 3.06:1, the
      // right floor for supporting UI rather than body copy. The active one
      // stays gold: it is one of the moments the accent should own.
      'editorLineNumber.foreground': '#656274',
      'editorLineNumber.activeForeground': '#D4B062',
      'editorIndentGuide.background': '#242232',
      'editorIndentGuide.activeBackground': '#3E3B4C',
      'editorWidget.background': '#1C1A26',
      'editorWidget.foreground': '#E2E0DA',
      'editorWidget.border': '#242232',
      'editorSuggestWidget.background': '#1C1A26',
      'editorSuggestWidget.border': '#242232',
      'editorSuggestWidget.selectedBackground': 'rgba(212, 176, 98, 0.15)',
      'editorHoverWidget.background': '#1C1A26',
      'editorHoverWidget.border': '#242232',
      'editorBracketMatch.background': 'rgba(212, 176, 98, 0.15)',
      'editorBracketMatch.border': '#D4B062',
      'editorGutter.background': '#16151F',
      'editorGutter.modifiedBackground': '#E0B048',
      'editorGutter.addedBackground': '#7DA66B',
      'editorGutter.deletedBackground': '#C97A8A',
      'scrollbarSlider.background': 'rgba(255, 255, 255, 0.08)',
      'scrollbarSlider.hoverBackground': 'rgba(255, 255, 255, 0.15)',
      'scrollbarSlider.activeBackground': 'rgba(255, 255, 255, 0.22)',
      'minimap.background': '#16151F',
      'minimapSlider.background': 'rgba(255, 255, 255, 0.08)',
      'minimapSlider.hoverBackground': 'rgba(255, 255, 255, 0.18)',
    },
  },
  terminal: {
    background: '#16151F',
    foreground: '#E2E0DA',
    cursor: '#D4B062',
    cursorAccent: '#0B0A10',
    selectionBackground: 'rgba(212, 176, 98, 0.25)',
    black: '#1C1A26',
    red: '#C97A8A',
    green: '#7DA66B',
    yellow: '#D4B062',
    blue: '#7B9CB5',
    magenta: '#A878B5',
    cyan: '#7DAFB5',
    white: '#C9C5B8',
    brightBlack: '#5C5965',
    brightRed: '#D89AA5',
    brightGreen: '#9DBE8A',
    brightYellow: '#E8C97D',
    brightBlue: '#9DB5C8',
    brightMagenta: '#C29ACB',
    brightCyan: '#9CC4C8',
    brightWhite: '#F4F2EC',
  },
};

export default arcaneDark;
