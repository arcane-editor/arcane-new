export interface UiColors {
  'bg-primary': string;
  'bg-sidebar': string;
  'bg-titlebar': string;
  'bg-tab-active': string;
  'bg-tab-inactive': string;
  'bg-statusbar': string;
  'bg-activity-bar': string;
  'bg-breadcrumbs': string;
  'bg-input': string;
  'text-primary': string;
  'text-secondary': string;
  'text-active': string;
  'text-breadcrumb': string;
  'text-breadcrumb-active': string;
  'text-on-dark': string;
  'border': string;
  'accent': string;
  'accent-secondary': string;
  'hover': string;
  'selected': string;
  'git-modified': string;
  'git-added': string;
  'git-deleted': string;
  'git-untracked': string;
  'overlay-shadow': string;
  'badge-bg': string;
  'hover-overlay': string;
  'statusbar-hover': string;
  'error-bg': string;
  'error-border': string;
  'error-text': string;
  'editor-error-btn': string;
  'editor-error-btn-hover': string;
  'folder-icon': string;
  'surface-container-high': string;
  'surface-container-highest': string;
  'surface-bright': string;
  'primary-light': string;
  'ghost-border': string;
  'warning': string;
  'warning-bg': string;
  'info': string;
  'info-bg': string;
  'success': string;
  'modal-backdrop': string;
  'modal-shadow': string;
  'scrollbar-thumb': string;
  'scrollbar-thumb-hover': string;
  'focus-ring': string;
  'button-primary-bg': string;
  'button-primary-text': string;
  'button-primary-hover': string;
  'button-danger-bg': string;
  'button-danger-text': string;
  'avatar-gradient-start': string;
  'avatar-gradient-end': string;
  'avatar-text': string;
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
