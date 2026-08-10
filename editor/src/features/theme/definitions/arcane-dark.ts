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
    'bg-primary': '#13121A',
    'bg-sidebar': '#100F14',
    'bg-titlebar': '#0E0D11',
    'bg-tab-active': '#1A1922',
    'bg-tab-inactive': '#100F14',
    'bg-statusbar': '#0E0D11',
    'bg-activity-bar': '#0E0D11',
    'bg-breadcrumbs': '#13121A',
    'bg-input': '#1F1E28',
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
    // Opaque per the fill-token contract in types.ts. These are the exact
    // composites of the translucent values they replace — rgba(255,255,255,.04)
    // and rgba(212,176,98,.10) blended over `bg-sidebar`/`bg-primary` — so the
    // Arcane look is unchanged while the token now means the same thing here as
    // it does in the four VS Code-derived themes.
    'hover': '#1B1A20',
    'selected': '#25201E',
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
    'surface-container-high': '#1A1922',
    'surface-container-highest': '#22202C',
    'surface-bright': '#2A2836',
    'primary-light': '#E8C97D',
    'ghost-border': 'rgba(212, 176, 98, 0.18)',
    'warning': '#E0B048',
    'warning-bg': 'rgba(224, 176, 72, 0.10)',
    'info': '#7B9CB5',
    'info-bg': 'rgba(123, 156, 181, 0.10)',
    'success': '#7DA66B',
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
      { token: 'tag', foreground: 'D4879A' },
      { token: 'attribute.name', foreground: 'D4879A' },
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
      { token: 'meta.decorator', foreground: 'D4879A' },
    ],
    colors: {
      'editor.background': '#13121A',
      'editor.foreground': '#E2E0DA',
      'editorCursor.foreground': '#D4B062',
      'editor.lineHighlightBackground': '#1A1922',
      'editor.lineHighlightBorder': '#1A1922',
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
      'editorIndentGuide.background': '#22202C',
      'editorIndentGuide.activeBackground': '#3A3845',
      'editorWidget.background': '#1A1922',
      'editorWidget.foreground': '#E2E0DA',
      'editorWidget.border': '#22202C',
      'editorSuggestWidget.background': '#1A1922',
      'editorSuggestWidget.border': '#22202C',
      'editorSuggestWidget.selectedBackground': 'rgba(212, 176, 98, 0.15)',
      'editorHoverWidget.background': '#1A1922',
      'editorHoverWidget.border': '#22202C',
      'editorBracketMatch.background': 'rgba(212, 176, 98, 0.15)',
      'editorBracketMatch.border': '#D4B062',
      'editorGutter.background': '#13121A',
      'editorGutter.modifiedBackground': '#E0B048',
      'editorGutter.addedBackground': '#7DA66B',
      'editorGutter.deletedBackground': '#C97A8A',
      'scrollbarSlider.background': 'rgba(255, 255, 255, 0.08)',
      'scrollbarSlider.hoverBackground': 'rgba(255, 255, 255, 0.15)',
      'scrollbarSlider.activeBackground': 'rgba(255, 255, 255, 0.22)',
      'minimap.background': '#13121A',
      'minimapSlider.background': 'rgba(255, 255, 255, 0.08)',
      'minimapSlider.hoverBackground': 'rgba(255, 255, 255, 0.18)',
    },
  },
  terminal: {
    background: '#13121A',
    foreground: '#E2E0DA',
    cursor: '#D4B062',
    cursorAccent: '#0E0D11',
    selectionBackground: 'rgba(212, 176, 98, 0.25)',
    black: '#1A1922',
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
