import type { ThemeDefinition } from '../types';
import unityideLight from './unityide-light';

const syntax: Record<string, string> = {
  '776D61': '667085', '6B3A7A': '82512D', '415C2F': '346B34',
  '8A4A16': '315FCC', '2F5A73': '186A61', '1F6459': '70551C',
  '2A2622': '222630', '4A443C': '4F5868', '8F3324': '7652A7', '6B6358': '5D6677',
};

const riderLight: ThemeDefinition = {
  id: 'rider-light', name: 'Rider Light', type: 'light',
  ui: {
    ...unityideLight.ui,
    'bg-primary': '#FFFFFF', 'bg-sidebar': '#F0F2F6',
    'bg-titlebar': '#E5E8EF', 'bg-activity-bar': '#D6DBE5',
    'bg-tab-active': '#FFFFFF', 'bg-tab-inactive': '#F0F2F6',
    'bg-statusbar': '#E5E8EF', 'bg-breadcrumbs': '#F0F2F6',
    'bg-input': '#FFFFFF', 'surface-container-high': '#F0F2F6',
    'surface-container-highest': '#E5E8EF', 'surface-bright': '#D6DBE5',
    'text-primary': '#222630', 'text-secondary': '#667085',
    'text-active': '#10131A', 'text-breadcrumb': '#667085',
    'text-breadcrumb-active': '#222630', 'text-on-dark': '#222630',
    'statusbar-fg': '#222630', 'border': '#CCD2DD',
    'accent': '#315FCC', 'accent-secondary': '#2348A7',
    'mode-ask': '#186A61', 'mode-agent': '#315FCC', 'mode-plan': '#7652A7',
    'hover': '#E7EBF3', 'selected': '#DCE7FC',
    'git-modified': '#70551C', 'git-added': '#346B34',
    'git-deleted': '#AA3E4C', 'git-untracked': '#346B34',
    'badge-bg': '#315FCC1A', 'ghost-border': '#315FCC33',
    'error-bg': '#AA3E4C14', 'error-border': '#AA3E4C', 'error-text': '#AA3E4C',
    'editor-error-btn': '#AA3E4C', 'editor-error-btn-hover': '#872C38',
    'folder-icon': '#315FCC', 'primary-light': '#2348A7',
    'warning': '#70551C', 'warning-bg': '#70551C14',
    'info': '#315FCC', 'info-bg': '#315FCC14', 'success': '#346B34',
    'unity-lifecycle': '#70551C', 'unity-engine-type': '#186A61',
    'unity-inspector': '#315FCC', 'unity-inspector-rail': '#315FCC10',
    'focus-ring': '#315FCC88', 'button-primary-bg': '#315FCC',
    'button-primary-text': '#FFFFFF', 'button-primary-hover': '#2348A7',
    'button-danger-bg': '#AA3E4C', 'button-danger-text': '#FFFFFF',
    'avatar-gradient-start': '#315FCC', 'avatar-gradient-end': '#2348A7', 'avatar-text': '#FFFFFF',
  },
  monaco: {
    base: 'vs', inherit: true,
    rules: unityideLight.monaco.rules.map((rule) => ({
      ...rule, foreground: rule.foreground ? syntax[rule.foreground] ?? rule.foreground : undefined,
    })),
    colors: {
      'editor.background': '#FFFFFF', 'editor.foreground': '#222630',
      'editorCursor.foreground': '#222630',
      'editor.lineHighlightBackground': '#F0F2F6', 'editor.lineHighlightBorder': '#F0F2F6',
      'editor.selectionBackground': '#DCE7FC', 'editor.selectionHighlightBackground': '#315FCC1A',
      'editor.wordHighlightBackground': '#315FCC14', 'editor.findMatchBackground': '#315FCC40',
      'editor.findMatchHighlightBackground': '#315FCC1F',
      'editorLineNumber.foreground': '#7D879A', 'editorLineNumber.activeForeground': '#315FCC',
      'editorIndentGuide.background': '#E5E8EF', 'editorIndentGuide.activeBackground': '#B4BDCD',
      'editorWidget.background': '#FFFFFF', 'editorWidget.foreground': '#222630',
      'editorWidget.border': '#CCD2DD', 'editorSuggestWidget.background': '#FFFFFF',
      'editorSuggestWidget.border': '#CCD2DD', 'editorSuggestWidget.selectedBackground': '#DCE7FC',
      'editorHoverWidget.background': '#FFFFFF', 'editorHoverWidget.border': '#CCD2DD',
      'editorBracketMatch.background': '#315FCC1F', 'editorBracketMatch.border': '#315FCC',
      'editorGutter.background': '#FFFFFF', 'editorGutter.modifiedBackground': '#70551C',
      'editorGutter.addedBackground': '#346B34', 'editorGutter.deletedBackground': '#AA3E4C',
      'scrollbarSlider.background': '#2226301A', 'scrollbarSlider.hoverBackground': '#22263033',
      'scrollbarSlider.activeBackground': '#2226304C', 'minimap.background': '#FFFFFF',
      'minimapSlider.background': '#22263014', 'minimapSlider.hoverBackground': '#2226302E',
      'editorOverviewRuler.border': '#00000000',
    },
  },
  terminal: {
    background: '#FFFFFF', foreground: '#222630', cursor: '#222630', cursorAccent: '#FFFFFF',
    selectionBackground: '#315FCC26', black: '#222630', red: '#AA3E4C', green: '#346B34',
    yellow: '#70551C', blue: '#315FCC', magenta: '#7652A7', cyan: '#186A61', white: '#667085',
    brightBlack: '#667085', brightRed: '#C15E6B', brightGreen: '#51884B', brightYellow: '#95732A',
    brightBlue: '#557DDD', brightMagenta: '#9674C5', brightCyan: '#3B8E83', brightWhite: '#FFFFFF',
  },
};

export default riderLight;
