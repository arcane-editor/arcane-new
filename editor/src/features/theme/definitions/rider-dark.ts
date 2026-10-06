import type { ThemeDefinition } from '../types';
import unityideDark from './unityide-dark';

// An Islands-inspired palette, adapted to UnityIDE's own semantic surfaces.
// The editor stays the brightest island; blue marks navigation and selection.
const syntax: Record<string, string> = {
  '827E94': '9699A6', 'C79BE0': 'CF8E6D', '8FBE7A': '9DC978',
  'E0A76B': 'AAC8F0', '8FBEDA': '70C8B3', '7FD1C4': 'E2B676',
  'DCD9E4': 'DDE0E7', 'C6C2CE': 'C1C5D0', 'D4879A': 'B6A2E8',
  '8B8798': 'A0A5B3',
};

const riderDark: ThemeDefinition = {
  id: 'rider-dark', name: 'Rider Dark', type: 'dark',
  ui: {
    ...unityideDark.ui,
    'bg-primary': '#20232B', 'bg-sidebar': '#171A21',
    'bg-titlebar': '#10131A', 'bg-activity-bar': '#0D1016',
    'bg-tab-active': '#20232B', 'bg-tab-inactive': '#171A21',
    'bg-statusbar': '#10131A', 'bg-breadcrumbs': '#171A21',
    'bg-input': '#2B2E38', 'surface-container-high': '#2B2E38',
    'surface-container-highest': '#333844', 'surface-bright': '#3D4351',
    'text-primary': '#DDE0E7', 'text-secondary': '#9699A6',
    'text-active': '#F2F4F8', 'text-breadcrumb': '#9699A6',
    'text-breadcrumb-active': '#DDE0E7', 'text-on-dark': '#DDE0E7',
    'statusbar-fg': '#DDE0E7', 'border': '#3B404C',
    'accent': '#7DA2FF', 'accent-secondary': '#A2BDFF',
    'mode-ask': '#70C8B3', 'mode-agent': '#7DA2FF', 'mode-plan': '#B6A2E8',
    'hover': '#303440', 'selected': '#29394E',
    'git-modified': '#E2B676', 'git-added': '#9DC978',
    'git-deleted': '#E68A92', 'git-untracked': '#9DC978',
    'badge-bg': '#7DA2FF26', 'ghost-border': '#7DA2FF33',
    'error-bg': '#E68A921F', 'error-border': '#E68A92', 'error-text': '#F0A2A8',
    'editor-error-btn': '#E68A92', 'editor-error-btn-hover': '#F0A2A8',
    'folder-icon': '#AAC8F0', 'primary-light': '#A2BDFF',
    'warning': '#E2B676', 'warning-bg': '#E2B6761A',
    'info': '#AAC8F0', 'info-bg': '#AAC8F01A', 'success': '#9DC978',
    'unity-lifecycle': '#E2B676', 'unity-engine-type': '#70C8B3',
    'unity-inspector': '#7DA2FF', 'unity-inspector-rail': '#7DA2FF12',
    'focus-ring': '#7DA2FF99', 'button-primary-bg': '#7DA2FF',
    'button-primary-text': '#10131A', 'button-primary-hover': '#A2BDFF',
    'button-danger-bg': '#E68A92', 'button-danger-text': '#10131A',
    'avatar-gradient-start': '#A2BDFF', 'avatar-gradient-end': '#5C7ED2',
    'avatar-text': '#10131A',
  },
  monaco: {
    base: 'vs-dark', inherit: true,
    rules: unityideDark.monaco.rules.map((rule) => ({
      ...rule, foreground: rule.foreground ? syntax[rule.foreground] ?? rule.foreground : undefined,
    })),
    colors: {
      'editor.background': '#20232B', 'editor.foreground': '#DDE0E7',
      'editorCursor.foreground': '#DDE0E7',
      'editor.lineHighlightBackground': '#2B2E38', 'editor.lineHighlightBorder': '#2B2E38',
      'editor.selectionBackground': '#355589', 'editor.selectionHighlightBackground': '#7DA2FF24',
      'editor.wordHighlightBackground': '#7DA2FF1A', 'editor.findMatchBackground': '#7DA2FF4C',
      'editor.findMatchHighlightBackground': '#7DA2FF24',
      'editorLineNumber.foreground': '#7C8291', 'editorLineNumber.activeForeground': '#A2BDFF',
      'editorIndentGuide.background': '#333844', 'editorIndentGuide.activeBackground': '#5C6475',
      'editorWidget.background': '#2B2E38', 'editorWidget.foreground': '#DDE0E7',
      'editorWidget.border': '#3B404C', 'editorSuggestWidget.background': '#2B2E38',
      'editorSuggestWidget.border': '#3B404C', 'editorSuggestWidget.selectedBackground': '#355589',
      'editorHoverWidget.background': '#2B2E38', 'editorHoverWidget.border': '#3B404C',
      'editorBracketMatch.background': '#7DA2FF26', 'editorBracketMatch.border': '#7DA2FF',
      'editorGutter.background': '#20232B', 'editorGutter.modifiedBackground': '#E2B676',
      'editorGutter.addedBackground': '#9DC978', 'editorGutter.deletedBackground': '#E68A92',
      'scrollbarSlider.background': '#DDE0E71A', 'scrollbarSlider.hoverBackground': '#DDE0E733',
      'scrollbarSlider.activeBackground': '#DDE0E74C', 'minimap.background': '#20232B',
      'minimapSlider.background': '#DDE0E714', 'minimapSlider.hoverBackground': '#DDE0E72E',
      'editorOverviewRuler.border': '#00000000',
    },
  },
  terminal: {
    background: '#20232B', foreground: '#DDE0E7', cursor: '#DDE0E7', cursorAccent: '#20232B',
    selectionBackground: '#7DA2FF33', black: '#171A21', red: '#E68A92', green: '#9DC978',
    yellow: '#E2B676', blue: '#7DA2FF', magenta: '#B6A2E8', cyan: '#70C8B3', white: '#C1C5D0',
    brightBlack: '#9699A6', brightRed: '#F0A2A8', brightGreen: '#B4DF90', brightYellow: '#F1CC95',
    brightBlue: '#A2BDFF', brightMagenta: '#CDBBF5', brightCyan: '#91DAC8', brightWhite: '#F2F4F8',
  },
};

export default riderDark;
