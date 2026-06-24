# Theming System Design

## Context

The IDE currently has a single hardcoded dark theme: CSS variables in `:root` (App.css), `"vs-dark"` in Monaco Editor, and a `THEME` object in TerminalInstance.tsx. There is no way to switch themes. This design adds a modular, type-safe theming system with 4 built-in themes (Dark+, Light+, Monokai, Dracula) and a VS Code-style theme picker.

## Architecture: Theme Registry + CSS Variables

Each theme is a self-contained TypeScript object covering three rendering surfaces. A Zustand store manages the active theme. Applying a theme injects CSS variables on `:root`, defines/applies a Monaco editor theme, and updates all live xterm terminal instances.

---

## 1. ThemeDefinition Interface

**File: `src/themes/types.ts`**

```typescript
export interface UiColors {
  // Existing variables (22)
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
  'border': string;
  'accent': string;
  'hover': string;
  'selected': string;
  'git-modified': string;
  'git-added': string;
  'git-deleted': string;
  'git-untracked': string;
  // New variables (replacing hardcoded rgba/hex in App.css)
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
}

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black';
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>;
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
```

## 2. File Structure

```
src/themes/
  types.ts          -- Interfaces
  registry.ts       -- Map<id, ThemeDefinition>, registerTheme(), getTheme(), getAllThemes()
  apply.ts          -- applyTheme(), ensureMonacoTheme(), registerTerminal(), unregisterTerminal()
  dark-plus.ts      -- Default dark theme (current hardcoded values)
  light-plus.ts     -- VS Code Light+
  monokai.ts        -- Monokai
  dracula.ts        -- Dracula
src/stores/theme.ts -- Zustand store
src/components/ThemePicker.tsx -- Command palette overlay
```

## 3. Theme Registry

**File: `src/themes/registry.ts`**

- `Map<string, ThemeDefinition>` holding all registered themes
- `registerTheme(theme)`, `getTheme(id)`, `getAllThemes()`
- `DEFAULT_THEME_ID = 'dark-plus'`
- All 4 built-in themes registered at module scope

Adding a new theme = create one file + add one `registerTheme()` call in registry.ts.

## 4. Theme Store (Zustand)

**File: `src/stores/theme.ts`**

State:
- `activeThemeId: string`

Actions:
- `setTheme(id)` -- Apply + persist to localStorage
- `previewTheme(id)` -- Apply visually without persisting (for picker hover/arrow)
- `revertPreview()` -- Snap back to confirmed theme (picker Escape/dismiss)
- `getActiveTheme()` -- Returns full ThemeDefinition
- `getAvailableThemes()` -- Returns all registered themes

A module-level `confirmedThemeId` tracks the "real" choice separately from the store's `activeThemeId` (which may be a transient preview). Persistence uses its own localStorage key (`editor-theme-id`), separate from the existing workspace persistence.

**FOUC prevention**: The store eagerly calls `applyCssVariables()` at module scope (during import, before React renders).

## 5. Theme Application Logic

**File: `src/themes/apply.ts`**

`applyTheme(theme: ThemeDefinition)` does three things:

1. **CSS Variables**: Loop `theme.ui` entries, call `root.style.setProperty(`--${key}`, value)`. Set `data-theme-type` attribute on `<html>` for scrollbar styling.

2. **Monaco**: Call `monaco.editor.defineTheme('app-theme-${id}', theme.monaco)` then `monaco.editor.setTheme('app-theme-${id}')`. If Monaco isn't loaded yet (returns null from `getMonaco()`), it's a no-op -- `ensureMonacoTheme()` handles it when the editor mounts.

3. **Terminal**: A `liveTerminals: Map<number, Terminal>` tracks mounted xterm instances. `registerTerminal(id, term)` / `unregisterTerminal(id)` are called by TerminalInstance.tsx on mount/unmount. `applyTerminalTheme()` iterates all live instances and sets `term.options.theme`.

**No circular dependencies**: `apply.ts` imports from `services/monaco-init.ts` only. It does NOT import the theme store. Components import both the store and apply.ts.

## 6. Command Palette Theme Picker

**File: `src/components/ThemePicker.tsx`**

- Fixed overlay at top-center (600px wide, like VS Code's quick pick)
- Search input with filtering
- Arrow keys navigate + live preview (calls `previewTheme`)
- Enter confirms (`setTheme` + close), Escape reverts (`revertPreview` + close)
- Mouse hover previews, click confirms
- Cleanup useEffect reverts preview on any unmount path

**Keyboard shortcut: Ctrl+K Ctrl+T (chord)**

Registered in two places:
1. **Window level** (App.tsx): keydown handler with chord state machine, guarded to skip when Monaco is focused
2. **Monaco level** (Editor.tsx): `editor.addCommand(KeyMod.chord(...))` dispatches `open-theme-picker` custom event

## 7. Integration Changes

| File | Change |
|------|--------|
| `App.css` | Remove `:root` color values (lines 1-23), replace ~14 hardcoded rgba/hex with CSS vars, add `[data-theme-type]` scrollbar rules, add ThemePicker styles |
| `Editor.tsx` | `theme="vs-dark"` -> dynamic `theme={monacoThemeId}` (lines 63, 85), add `ensureMonacoTheme()` in onMount, add chord command |
| `TerminalInstance.tsx` | Remove `THEME` object (lines 10-32), read from theme store, call `registerTerminal`/`unregisterTerminal` |
| `App.tsx` | Import theme store, apply initial theme in useEffect, add chord handler, render ThemePicker conditionally |
| `index.html` | Add sync `<script>` to set `data-theme-type` attribute before paint (FOUC prevention) |

## 8. CSS Variable Replacements in App.css

These hardcoded values must be replaced with CSS variables:

| Current Value | New Variable |
|--------------|-------------|
| `color: #dcb67a` (folder icon) | `var(--folder-icon)` |
| `rgba(255,255,255,0.1)` (badges/close buttons) | `var(--badge-bg)` or `var(--hover-overlay)` |
| `rgba(255,255,255,0.12)` (statusbar hover) | `var(--statusbar-hover)` |
| `rgba(0,0,0,0.4)` (overlay shadows) | `var(--overlay-shadow)` |
| `rgba(204,51,51,0.15)` (error bg) | `var(--error-bg)` |
| `#cc3333` (error border) | `var(--error-border)` |
| `#f48771` (error text) | `var(--error-text)` |
| `#0078d4` (error button) | `var(--editor-error-btn)` |
| `#1a8ad4` (error button hover) | `var(--editor-error-btn-hover)` |

## 9. Edge Cases

- **Monaco not loaded**: `applyMonacoTheme()` no-ops; `ensureMonacoTheme()` catches up on mount
- **Existing terminals**: Live-updated via `liveTerminals` Map, no destroy/recreate
- **FOUC**: Eager module-scope CSS injection + sync index.html script
- **Ctrl+K conflict**: Dual registration (window + Monaco keybinding system)
- **Preview revert**: Cleanup useEffect in ThemePicker reverts unless confirmed

## 10. Built-in Themes

1. **Dark+ (Default Dark)** -- Current hardcoded values, VS Code's default dark
2. **Light+ (Default Light)** -- VS Code's default light, light bg/dark text
3. **Monokai** -- Classic warm dark theme with vibrant syntax colors
4. **Dracula** -- Purple-tinted dark theme with pastel syntax colors

## 11. Implementation Order

1. Create `src/themes/types.ts` + `dark-plus.ts` + `registry.ts` (no runtime changes)
2. Create `src/themes/apply.ts` + `src/stores/theme.ts` (application layer)
3. Wire into `App.tsx`, `Editor.tsx`, `TerminalInstance.tsx`, `App.css` (integration)
4. Create remaining themes: `light-plus.ts`, `monokai.ts`, `dracula.ts`
5. Create `src/components/ThemePicker.tsx`
6. Add FOUC prevention script to `index.html`
7. Test all themes across all surfaces
