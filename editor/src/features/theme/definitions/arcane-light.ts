import type { ThemeDefinition } from '../types';

// Arcane Light — "Vellum & Iron-Gall Ink".
// Fully light (no dark titlebar) — vellum canvas, deep sepia ink, balanced
// sienna accent like a rubricated capital in an illuminated manuscript.
// Iron-rust reserved for errors / JSX tags / dirty-state, deep moss for
// strings and added-lines. Different personality from Arcane Dark, not an
// inverted-lightness flip.
const arcaneLight: ThemeDefinition = {
  id: 'arcane-light',
  name: 'Arcane Light',
  type: 'light',
  ui: {
    // Recessed Chrome, mirrored: the editor is the brightest plane and the
    // chrome steps down away from it. Same principle as Arcane Dark — the
    // luminance step is the separator, so no region needs a border.
    'bg-primary': '#FCFAF3',
    'bg-sidebar': '#F2EDE0',
    'bg-titlebar': '#EBE4D3',
    // Equal to `bg-primary`: the active tab reads as continuous with its
    // content, marked by `.tab.active::after`'s accent rule instead.
    'bg-tab-active': '#FCFAF3',
    'bg-tab-inactive': '#F2EDE0',
    'bg-statusbar': '#EBE4D3',
    'bg-activity-bar': '#E7DFCC',
    'bg-breadcrumbs': '#F2EDE0',
    'bg-input': '#FCFAF3',
    'text-primary': '#2A2622',
    'text-secondary': '#6B6358',
    'text-active': '#1A1612',
    'text-breadcrumb': '#857C6E',
    'text-breadcrumb-active': '#2A2622',
    'text-on-dark': '#2A2622',
    // on #EBE4D3 vellum
    'statusbar-fg': '#2A2622',
    'border': 'rgba(42, 38, 34, 0.08)',
    'accent': '#A8632A',
    'accent-secondary': '#7A4318',
    // Opaque per the fill-token contract in types.ts — see arcane-dark.
    'hover': '#EEEAE0',
    'selected': '#EEE4D5',
    'git-modified': '#9E7A1C',
    'git-added': '#4F6B3A',
    'git-deleted': '#9E3A2C',
    'git-untracked': '#4F6B3A',
    'badge-bg': 'rgba(168, 99, 42, 0.14)',
    'hover-overlay': 'rgba(42, 38, 34, 0.04)',
    'statusbar-hover': 'rgba(42, 38, 34, 0.05)',
    'error-bg': 'rgba(158, 58, 44, 0.08)',
    'error-border': '#9E3A2C',
    'error-text': '#9E3A2C',
    'editor-error-btn': '#9E3A2C',
    'editor-error-btn-hover': '#7A2A1E',
    'folder-icon': '#857C6E',
    'surface-container-high': '#F2EDE0',
    'surface-container-highest': '#EBE4D3',
    // The editor is now the brightest vellum, so a raised surface has to go
    // past it toward paper-white to still read as raised.
    'surface-bright': '#FFFFFF',
    'primary-light': '#7A4318',
    'ghost-border': 'rgba(168, 99, 42, 0.20)',
    'warning': '#9E7A1C',
    'warning-bg': 'rgba(158, 122, 28, 0.10)',
    'info': '#3A6680',
    'info-bg': 'rgba(58, 102, 128, 0.08)',
    'success': '#4F6B3A',
    // Unity semantics, in Light's own ink — burnt umber for what the engine
    // calls, slate for engine types, iron-rust for what reaches the Inspector.
    'unity-lifecycle': '#8A5A12',
    'unity-engine-type': '#2F5A73',
    // Muted slate-plum, deliberately not the iron-rust used for errors.
    'unity-inspector': '#6E667E',
    'unity-inspector-rail': 'rgba(110, 102, 126, 0.05)',
    'modal-backdrop': 'rgba(42, 38, 34, 0.30)',
    'modal-shadow': '0 8px 32px rgba(42, 38, 34, 0.12), 0 0 0 1px rgba(42, 38, 34, 0.06)',
    'scrollbar-thumb': 'rgba(42, 38, 34, 0.16)',
    'scrollbar-thumb-hover': 'rgba(42, 38, 34, 0.28)',
    'focus-ring': 'rgba(168, 99, 42, 0.45)',
    // Nudged a hair darker than `accent` so white button text clears AA (4.67:1).
    'button-primary-bg': '#A56028',
    'button-primary-text': '#FCFAF3',
    'button-primary-hover': '#7A4318',
    'button-danger-bg': '#9E3A2C',
    'button-danger-text': '#FCFAF3',
    'avatar-gradient-start': '#A8632A',
    'avatar-gradient-end': '#6B3410',
    'avatar-text': '#FCFAF3',
  },
  monaco: {
    base: 'vs',
    inherit: true,
    rules: [
      // The same six-role structure as Arcane Dark, in Light's own ink. Not a
      // darkened copy of the dark palette: this stays iron-gall and sienna on
      // vellum. The sienna accent (#A8632A) is gone from the code — it was
      // resolving five function-ish tokens at 4.38:1 while also being the
      // chrome accent, the same double duty gold was doing in the dark theme.
      { token: 'comment', foreground: '776D61', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6B3A7A' },
      { token: 'string', foreground: '415C2F' },
      { token: 'number', foreground: '8A4A16' },
      { token: 'type', foreground: '2F5A73' },
      { token: 'function', foreground: '1F6459' },
      { token: 'variable', foreground: '2A2622' },
      { token: 'constant', foreground: '8A4A16' },
      { token: 'parameter', foreground: '4A443C' },
      { token: 'property', foreground: '2F5A73' },
      // `tag` keeps the iron-rust for JSX/HTML; C# attributes move off it so a
      // file full of them stops reading as a column of errors.
      { token: 'tag', foreground: '8F3324' },
      { token: 'attribute.name', foreground: '6E667E' },
      { token: 'attribute.value', foreground: '415C2F' },
      { token: 'delimiter', foreground: '6B6358' },
      { token: 'operator', foreground: '6B3A7A' },
      { token: 'regexp', foreground: '415C2F' },

      // --- Keywords & Storage ---
      { token: 'keyword.control', foreground: '6B3A7A', fontStyle: 'italic' },
      { token: 'keyword.operator.new', foreground: '6B3A7A' },
      { token: 'keyword.operator.expression', foreground: '6B3A7A' },
      { token: 'storage', foreground: '6B3A7A' },
      { token: 'storage.type', foreground: '2F5A73' },
      { token: 'storage.modifier', foreground: '6B3A7A' },

      // --- Variables & Constants ---
      { token: 'variable.language', foreground: '8F3324', fontStyle: 'italic' },
      { token: 'variable.other.constant', foreground: '8A4A16' },
      { token: 'constant.language', foreground: '6B3A7A' },

      // --- Entities & Support ---
      { token: 'entity.name.function', foreground: '1F6459' },
      { token: 'entity.name.class', foreground: '2F5A73' },
      { token: 'entity.name.type', foreground: '2F5A73' },
      { token: 'support.function', foreground: '1F6459' },
      { token: 'support.class', foreground: '2F5A73' },
      { token: 'support.type', foreground: '2F5A73' },

      // --- JSX/TSX ---
      { token: 'entity.name.tag', foreground: '8F3324' },
      { token: 'support.class.component', foreground: '2F5A73' },

      // --- Punctuation & Delimiters ---
      { token: 'meta.brace.round', foreground: '6B6358' },
      { token: 'meta.brace.square', foreground: '6B6358' },
      { token: 'meta.brace.curly', foreground: '6B3A7A' },
      { token: 'punctuation.separator', foreground: '6B6358' },
      { token: 'string.template', foreground: '415C2F' },
      { token: 'punctuation.definition.template-expression', foreground: '6B3A7A' },

      // --- Decorators ---
      { token: 'meta.decorator', foreground: '6E667E' },
    ],
    colors: {
      'editor.background': '#FCFAF3',
      'editor.foreground': '#2A2622',
      'editorCursor.foreground': '#A8632A',
      'editor.lineHighlightBackground': '#F2EDE0',
      'editor.lineHighlightBorder': '#F2EDE0',
      'editor.selectionBackground': 'rgba(168, 99, 42, 0.15)',
      'editor.selectionHighlightBackground': 'rgba(168, 99, 42, 0.10)',
      'editor.wordHighlightBackground': 'rgba(168, 99, 42, 0.08)',
      'editor.findMatchBackground': 'rgba(168, 99, 42, 0.25)',
      'editor.findMatchHighlightBackground': 'rgba(168, 99, 42, 0.12)',
      'editorLineNumber.foreground': '#948B7E',
      'editorLineNumber.activeForeground': '#A8632A',
      'editorIndentGuide.background': '#E5DECD',
      'editorIndentGuide.activeBackground': '#C5BDAE',
      'editorWidget.background': '#FCFAF3',
      'editorWidget.foreground': '#2A2622',
      'editorWidget.border': '#E5DECD',
      'editorSuggestWidget.background': '#FCFAF3',
      'editorSuggestWidget.border': '#E5DECD',
      'editorSuggestWidget.selectedBackground': 'rgba(168, 99, 42, 0.12)',
      'editorHoverWidget.background': '#FCFAF3',
      'editorHoverWidget.border': '#E5DECD',
      'editorBracketMatch.background': 'rgba(168, 99, 42, 0.12)',
      'editorBracketMatch.border': '#A8632A',
      'editorGutter.background': '#FCFAF3',
      'editorGutter.modifiedBackground': '#9E7A1C',
      'editorGutter.addedBackground': '#4F6B3A',
      'editorGutter.deletedBackground': '#9E3A2C',
      'scrollbarSlider.background': 'rgba(42, 38, 34, 0.10)',
      'scrollbarSlider.hoverBackground': 'rgba(42, 38, 34, 0.20)',
      'scrollbarSlider.activeBackground': 'rgba(42, 38, 34, 0.30)',
      'minimap.background': '#FCFAF3',
      'minimapSlider.background': 'rgba(42, 38, 34, 0.08)',
      'minimapSlider.hoverBackground': 'rgba(42, 38, 34, 0.18)',
    },
  },
  terminal: {
    background: '#FCFAF3',
    foreground: '#2A2622',
    cursor: '#A8632A',
    cursorAccent: '#FCFAF3',
    selectionBackground: 'rgba(168, 99, 42, 0.20)',
    black: '#2A2622',
    red: '#9E3A2C',
    green: '#4F6B3A',
    yellow: '#9E7A1C',
    blue: '#3A6680',
    magenta: '#7A3A6E',
    cyan: '#3A7080',
    white: '#857C6E',
    brightBlack: '#857C6E',
    brightRed: '#C25940',
    brightGreen: '#6B8A52',
    brightYellow: '#C29A28',
    brightBlue: '#5882A0',
    brightMagenta: '#9C5C8E',
    brightCyan: '#5894A4',
    brightWhite: '#FCFAF3',
  },
};

export default arcaneLight;
