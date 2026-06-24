# Kinetic Forge Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Unity Dark theme to match the "Kinetic Forge" design system — deep obsidian surfaces, no-line rule, warm orange accent, frosted glass floating elements.

**Architecture:** Direct theme override approach. Expand the `UiColors` type with 5 new tokens, rewrite `unity-dark.ts` color values, add fallback values to all other theme definitions, then overhaul `App.css` to remove borders, restyle components, and add frosted glass effects. No React component logic changes — pure CSS + theme data.

**Tech Stack:** TypeScript (theme definitions), CSS (App.css), Tauri/React (build verification)

**Spec:** `docs/superpowers/specs/2026-04-06-kinetic-forge-theme-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/features/theme/types.ts` | Modify | Add 5 new tokens to `UiColors` interface |
| `src/features/theme/definitions/unity-dark.ts` | Modify | Full color rewrite (UI + Monaco + Terminal) |
| `src/features/theme/definitions/dark-plus.ts` | Modify | Add 5 new token defaults |
| `src/features/theme/definitions/light-plus.ts` | Modify | Add 5 new token defaults |
| `src/features/theme/definitions/monokai.ts` | Modify | Add 5 new token defaults |
| `src/features/theme/definitions/dracula.ts` | Modify | Add 5 new token defaults |
| `src/features/theme/definitions/unity-light.ts` | Modify | Add 5 new token defaults |
| `src/App.css` | Modify | Border removal, component restyling, frosted glass |

---

### Task 1: Expand UiColors Interface

**Files:**
- Modify: `src/features/theme/types.ts:1-34`

- [ ] **Step 1: Add 5 new tokens to the UiColors interface**

Add these properties before the closing brace of `UiColors`:

```typescript
  'surface-container-high': string;
  'surface-container-highest': string;
  'surface-bright': string;
  'primary-light': string;
  'ghost-border': string;
```

The full interface should end like this:

```typescript
  'folder-icon': string;
  'surface-container-high': string;
  'surface-container-highest': string;
  'surface-bright': string;
  'primary-light': string;
  'ghost-border': string;
}
```

- [ ] **Step 2: Verify TypeScript catches missing tokens**

Run: `cd /Users/inno/Documents/experiments/editor && npx tsc --noEmit 2>&1 | head -30`

Expected: TypeScript errors in all 6 theme definition files complaining about missing properties `surface-container-high`, `surface-container-highest`, `surface-bright`, `primary-light`, `ghost-border`. This confirms the type system enforces completeness.

- [ ] **Step 3: Commit**

```bash
git add src/features/theme/types.ts
git commit -m "feat(theme): add 5 new surface/gradient tokens to UiColors interface"
```

---

### Task 2: Rewrite Unity Dark Theme Definition

**Files:**
- Modify: `src/features/theme/definitions/unity-dark.ts`

- [ ] **Step 1: Replace the entire `ui` object with new Kinetic Forge values**

Replace the `ui` property with:

```typescript
  ui: {
    'bg-primary': '#131313',
    'bg-sidebar': '#1a1a1a',
    'bg-titlebar': '#0e0e0e',
    'bg-tab-active': '#131313',
    'bg-tab-inactive': '#1a1a1a',
    'bg-statusbar': '#0e0e0e',
    'bg-activity-bar': '#0e0e0e',
    'bg-breadcrumbs': '#131313',
    'bg-input': '#1e1e1e',
    'text-primary': '#e5e2e1',
    'text-secondary': '#e2bfb0',
    'text-active': '#ffffff',
    'text-breadcrumb': '#8a7a72',
    'text-breadcrumb-active': '#e5e2e1',
    'border': 'rgba(90, 65, 54, 0.15)',
    'accent': '#ff6b00',
    'hover': 'rgba(255, 255, 255, 0.04)',
    'selected': '#7b3409',
    'git-modified': '#E2C08D',
    'git-added': '#6A9955',
    'git-deleted': '#F44747',
    'git-untracked': '#73C991',
    'overlay-shadow': 'rgba(0, 0, 0, 0.4)',
    'badge-bg': 'rgba(255, 107, 0, 0.15)',
    'hover-overlay': 'rgba(255, 255, 255, 0.04)',
    'statusbar-hover': 'rgba(255, 107, 0, 0.12)',
    'error-bg': 'rgba(244, 71, 71, 0.10)',
    'error-border': '#F44747',
    'error-text': '#F44747',
    'editor-error-btn': '#ff6b00',
    'editor-error-btn-hover': '#ffb693',
    'folder-icon': '#ff6b00',
    'surface-container-high': '#2a2a2a',
    'surface-container-highest': '#333333',
    'surface-bright': '#3a3a3a',
    'primary-light': '#ffb693',
    'ghost-border': 'rgba(90, 65, 54, 0.15)',
  },
```

- [ ] **Step 2: Replace the `monaco.colors` object with new values**

Replace the `colors` property inside `monaco`:

```typescript
    colors: {
      'editor.background': '#131313',
      'editor.foreground': '#e5e2e1',
      'editorCursor.foreground': '#ff6b00',
      'editor.lineHighlightBackground': '#1a1a1a',
      'editor.selectionBackground': 'rgba(123, 52, 9, 0.5)',
      'editorLineNumber.foreground': '#4a4a4a',
      'editorLineNumber.activeForeground': '#e5e2e1',
      'editorIndentGuide.background': '#1e1e1e',
      'editorWidget.background': '#1a1a1a',
      'editorWidget.border': 'rgba(90, 65, 54, 0.15)',
    },
```

- [ ] **Step 3: Update the terminal colors**

Replace the `terminal` property:

```typescript
  terminal: {
    background: '#0e0e0e',
    foreground: '#e5e2e1',
    cursor: '#ff6b00',
    cursorAccent: '#0e0e0e',
    selectionBackground: 'rgba(255, 107, 0, 0.25)',
    black: '#131313',
    red: '#F44747',
    green: '#6A9955',
    yellow: '#ff6b00',
    blue: '#569CD6',
    magenta: '#C586C0',
    cyan: '#4EC9B0',
    white: '#e5e2e1',
    brightBlack: '#808080',
    brightRed: '#F44747',
    brightGreen: '#6A9955',
    brightYellow: '#ff6b00',
    brightBlue: '#569CD6',
    brightMagenta: '#C586C0',
    brightCyan: '#4EC9B0',
    brightWhite: '#FFFFFF',
  },
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/inno/Documents/experiments/editor && npx tsc --noEmit 2>&1 | head -10`

Expected: Errors only from other theme files (missing new tokens), NOT from unity-dark.ts.

- [ ] **Step 5: Commit**

```bash
git add src/features/theme/definitions/unity-dark.ts
git commit -m "feat(theme): rewrite unity-dark with Kinetic Forge color palette"
```

---

### Task 3: Add New Token Defaults to All Other Themes

**Files:**
- Modify: `src/features/theme/definitions/dark-plus.ts`
- Modify: `src/features/theme/definitions/light-plus.ts`
- Modify: `src/features/theme/definitions/monokai.ts`
- Modify: `src/features/theme/definitions/dracula.ts`
- Modify: `src/features/theme/definitions/unity-light.ts`

- [ ] **Step 1: Add new tokens to dark-plus.ts**

Add these 5 properties at the end of the `ui` object, before the closing brace, after `'folder-icon': '#dcb67a',`:

```typescript
    'surface-container-high': '#3c3c3c',
    'surface-container-highest': '#454545',
    'surface-bright': '#4e4e4e',
    'primary-light': '#3399dd',
    'ghost-border': '#3c3c3c',
```

- [ ] **Step 2: Add new tokens to light-plus.ts**

Add after `'folder-icon': '#c09553',`:

```typescript
    'surface-container-high': '#ffffff',
    'surface-container-highest': '#f5f5f5',
    'surface-bright': '#ebebeb',
    'primary-light': '#33aadd',
    'ghost-border': '#e5e5e5',
```

- [ ] **Step 3: Add new tokens to monokai.ts**

Add after `'folder-icon': '#e6db74',`:

```typescript
    'surface-container-high': '#3e3d32',
    'surface-container-highest': '#484840',
    'surface-bright': '#52514a',
    'primary-light': '#c4f05e',
    'ghost-border': '#3b3a32',
```

- [ ] **Step 4: Add new tokens to dracula.ts**

Add after `'folder-icon': '#f1fa8c',`:

```typescript
    'surface-container-high': '#44475a',
    'surface-container-highest': '#4e5166',
    'surface-bright': '#585b72',
    'primary-light': '#d4b1fb',
    'ghost-border': '#44475a',
```

- [ ] **Step 5: Add new tokens to unity-light.ts**

Add after `'folder-icon': '#E09956',`:

```typescript
    'surface-container-high': '#FFFFFF',
    'surface-container-highest': '#F5F5F5',
    'surface-bright': '#EBEBEB',
    'primary-light': '#F0C4A0',
    'ghost-border': '#E0E0E0',
```

- [ ] **Step 6: Verify clean build**

Run: `cd /Users/inno/Documents/experiments/editor && npx tsc --noEmit 2>&1 | head -10`

Expected: No TypeScript errors (or only pre-existing errors unrelated to themes).

- [ ] **Step 7: Commit**

```bash
git add src/features/theme/definitions/dark-plus.ts src/features/theme/definitions/light-plus.ts src/features/theme/definitions/monokai.ts src/features/theme/definitions/dracula.ts src/features/theme/definitions/unity-light.ts
git commit -m "feat(theme): add new surface/gradient token defaults to all themes"
```

---

### Task 4: CSS — Remove Structural Borders (No-Line Rule)

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Remove activity bar borders**

In `.activity-bar`, remove the line:
```css
  border-right: 1px solid var(--border);
```

In `.activity-bar--right`, change:
```css
  border-right: none;
  border-left: 1px solid var(--border);
```
to:
```css
  border-right: none;
  border-left: none;
```

- [ ] **Step 2: Remove title bar border**

In `.title-bar`, remove the line:
```css
  border-bottom: 1px solid var(--border);
```

- [ ] **Step 3: Remove sidebar and explorer header borders**

In `.sidebar-header`, remove:
```css
  border-bottom: 1px solid var(--border);
```

In `.explorer-header`, remove:
```css
  border-bottom: 1px solid var(--border);
```

- [ ] **Step 4: Remove tab bar and tab borders**

In `.tab-bar`, remove:
```css
  border-bottom: 1px solid var(--border);
```

In `.tab`, remove:
```css
  border-right: 1px solid var(--border);
```

- [ ] **Step 5: Remove breadcrumbs border, add padding gap**

In `.breadcrumbs`, change:
```css
  border-bottom: 1px solid var(--border);
```
to:
```css
  padding-bottom: 4px;
```

- [ ] **Step 6: Remove bottom panel and terminal borders**

In `.bottom-panel`, remove:
```css
  border-top: 1px solid var(--border);
```

In `.bottom-panel-header`, remove:
```css
  border-bottom: 1px solid var(--border);
```

In `.terminal-tabs`, remove:
```css
  border-bottom: 1px solid var(--border);
```

- [ ] **Step 7: Remove AI panel borders**

In `.ai-panel-header`, remove:
```css
  border-bottom: 1px solid var(--border);
```

In `.ai-panel-input-area`, remove:
```css
  border-top: 1px solid var(--border);
```

- [ ] **Step 8: Remove SCM, search, and problems borders**

In `.scm-commit-box`, remove:
```css
  border-bottom: 1px solid var(--border);
```

In `.scm-toolbar`, remove:
```css
  border-bottom: 1px solid var(--border);
```

In `.search-summary`, remove:
```css
  border-bottom: 1px solid var(--border);
```

In `.problems-filter-bar`, remove:
```css
  border-bottom: 1px solid var(--border);
```

- [ ] **Step 9: Verify build still works**

Run: `cd /Users/inno/Documents/experiments/editor && npm run build 2>&1 | tail -5`

Expected: Build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/App.css
git commit -m "feat(theme): remove 17 structural borders (No-Line Rule)"
```

---

### Task 5: CSS — Restyle Floating Elements as Ghost Borders

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Update floating element borders to ghost-border**

In `.palette`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: 1px solid var(--ghost-border);
```

In `.theme-picker`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: 1px solid var(--ghost-border);
```

In `.context-menu`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: 1px solid var(--ghost-border);
```

In `.notification-toast`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: 1px solid var(--ghost-border);
```

In `.branch-picker`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: 1px solid var(--ghost-border);
```

- [ ] **Step 2: Update divider to whitespace**

In `.context-menu-separator`, change:
```css
  height: 1px;
  background: var(--border);
  margin: 4px 0;
```
to:
```css
  height: 4px;
  background: transparent;
  margin: 0;
```

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "feat(theme): convert floating element borders to ghost-border token"
```

---

### Task 6: CSS — Restyle Input Fields (Bottom-Only Focus)

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Restyle SCM commit input**

In `.scm-commit-input`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: none;
  border-bottom: 1px solid transparent;
```

In `.scm-commit-input:focus`, change:
```css
  border-color: var(--accent);
```
to:
```css
  border-bottom-color: var(--accent);
```

- [ ] **Step 2: Restyle search inputs**

In `.search-input`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: none;
  border-bottom: 1px solid transparent;
```

In `.search-input:focus`, change:
```css
  border-color: var(--accent);
```
to:
```css
  border-bottom-color: var(--accent);
```

In `.search-filter-input`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: none;
  border-bottom: 1px solid transparent;
```

In `.search-filter-input:focus`, change:
```css
  border-color: var(--accent);
```
to:
```css
  border-bottom-color: var(--accent);
```

- [ ] **Step 3: Restyle theme picker input**

In `.theme-picker-input`, change:
```css
  border-bottom: 1px solid var(--border);
```
to:
```css
  border-bottom: 1px solid transparent;
```

(It already has `border: none` above this line, so only the bottom border needs updating.)

- [ ] **Step 4: Restyle inline input**

In `.inline-input`, change:
```css
  border: 1px solid var(--accent);
```
to:
```css
  border: none;
  border-bottom: 1px solid var(--accent);
```

- [ ] **Step 5: Restyle AI panel input wrapper**

In `.ai-panel-input-wrapper`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: none;
  border-bottom: 1px solid transparent;
```

In `.ai-panel-input-wrapper:focus-within`, change:
```css
  border-color: var(--accent);
```
to:
```css
  border-bottom-color: var(--accent);
```

- [ ] **Step 6: Restyle AI panel model select**

In `.ai-panel-model-select`, change:
```css
  border: 1px solid var(--border);
```
to:
```css
  border: none;
  border-bottom: 1px solid transparent;
```

In `.ai-panel-model-select:focus`, change:
```css
  border-color: var(--accent);
```
to:
```css
  border-bottom-color: var(--accent);
```

- [ ] **Step 7: Commit**

```bash
git add src/App.css
git commit -m "feat(theme): restyle inputs with bottom-only focus highlight"
```

---

### Task 7: CSS — Restyle Tree View Selection

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Update tree node selection with indicator bar**

In `.tree-node.selected`, change:
```css
.tree-node.selected {
  background: var(--selected);
}
```
to:
```css
.tree-node.selected {
  background: var(--selected);
  border-left: 2px solid var(--accent);
  padding-left: 6px;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/App.css
git commit -m "feat(theme): add orange indicator bar to tree view selection"
```

---

### Task 8: CSS — Restyle Buttons with Gradients

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Update primary buttons to gradient**

In `.welcome-btn`, change:
```css
  background: var(--accent);
```
to:
```css
  background: linear-gradient(135deg, var(--primary-light), var(--accent));
```

Change:
```css
  border-radius: 4px;
```
to:
```css
  border-radius: 2px;
```

In `.scm-commit-btn`, change:
```css
  background: var(--accent);
```
to:
```css
  background: linear-gradient(135deg, var(--primary-light), var(--accent));
```

Change:
```css
  border-radius: 3px;
```
to:
```css
  border-radius: 2px;
```

In `.ai-panel-send`, change:
```css
  background: var(--accent);
```
to:
```css
  background: linear-gradient(135deg, var(--primary-light), var(--accent));
```

Change:
```css
  border-radius: 4px;
```
to:
```css
  border-radius: 2px;
```

In `.editor-error button`, change:
```css
  border-radius: 4px;
```
to:
```css
  background: linear-gradient(135deg, var(--primary-light), var(--accent));
  border-radius: 2px;
```

(Note: `.editor-error button` already uses `var(--editor-error-btn)` for background. Change that to the gradient instead.)

- [ ] **Step 2: Update ghost button hovers**

In `.explorer-action-btn:hover`, change:
```css
  background: var(--hover);
```
to:
```css
  background: var(--surface-container-highest);
```

In `.scm-toolbar-btn:hover`, change:
```css
  background: var(--hover);
```
to:
```css
  background: var(--surface-container-highest);
```

In `.scm-file-action-btn:hover`, change:
```css
  background: var(--hover-overlay);
```
to:
```css
  background: var(--surface-container-highest);
```

In `.bottom-panel-close:hover`, change:
```css
  background: var(--hover);
```
to:
```css
  background: var(--surface-container-highest);
```

In `.terminal-add-btn:hover`, change:
```css
  background: var(--hover);
```
to:
```css
  background: var(--surface-container-highest);
```

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "feat(theme): gradient primary buttons, surface-container-highest ghost hovers"
```

---

### Task 9: CSS — Frosted Glass Floating Elements

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Apply frosted obsidian to Command Palette**

In `.palette`, change:
```css
  background: var(--bg-sidebar);
  border: 1px solid var(--ghost-border);
  border-top: none;
  border-radius: 0 0 8px 8px;
  box-shadow: 0 8px 24px var(--overlay-shadow);
```
to:
```css
  background: rgba(58, 58, 58, 0.6);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--ghost-border);
  border-top: none;
  border-radius: 0 0 8px 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
```

- [ ] **Step 2: Apply frosted obsidian to Theme Picker**

In `.theme-picker`, change:
```css
  background: var(--bg-sidebar);
  border: 1px solid var(--ghost-border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  box-shadow: 0 8px 24px var(--overlay-shadow);
```
to:
```css
  background: rgba(58, 58, 58, 0.6);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--ghost-border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
```

- [ ] **Step 3: Apply frosted obsidian to Context Menu**

In `.context-menu`, change:
```css
  background: var(--bg-sidebar);
  border: 1px solid var(--ghost-border);
  border-radius: 4px;
  box-shadow: 0 4px 12px var(--overlay-shadow);
```
to:
```css
  background: rgba(58, 58, 58, 0.6);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--ghost-border);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
```

- [ ] **Step 4: Apply frosted obsidian to Notifications**

In `.notification-toast`, change:
```css
  background: var(--bg-sidebar);
  border: 1px solid var(--ghost-border);
  border-radius: 4px;
  box-shadow: 0 4px 12px var(--overlay-shadow);
```
to:
```css
  background: rgba(58, 58, 58, 0.6);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--ghost-border);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
```

- [ ] **Step 5: Apply frosted obsidian to Branch Picker**

In `.branch-picker`, change:
```css
  background: var(--bg-sidebar);
  border: 1px solid var(--ghost-border);
  border-radius: 4px;
  box-shadow: 0 4px 12px var(--overlay-shadow);
```
to:
```css
  background: rgba(58, 58, 58, 0.6);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--ghost-border);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
```

- [ ] **Step 6: Commit**

```bash
git add src/App.css
git commit -m "feat(theme): frosted obsidian glass effect on all floating elements"
```

---

### Task 10: CSS — Update Scrollbars

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Reduce dark theme scrollbar opacity**

In `:root[data-theme-type="dark"] ::-webkit-scrollbar-thumb`, change:
```css
  background: rgba(255, 255, 255, 0.15);
```
to:
```css
  background: rgba(255, 255, 255, 0.10);
```

- [ ] **Step 2: Commit**

```bash
git add src/App.css
git commit -m "feat(theme): subtler scrollbar thumb for dark themes"
```

---

### Task 11: Final Build Verification

- [ ] **Step 1: Run full TypeScript check**

Run: `cd /Users/inno/Documents/experiments/editor && npx tsc --noEmit 2>&1 | head -20`

Expected: No theme-related errors.

- [ ] **Step 2: Run full build**

Run: `cd /Users/inno/Documents/experiments/editor && npm run build 2>&1 | tail -10`

Expected: Build succeeds.

- [ ] **Step 3: Visual verification**

Run: `cd /Users/inno/Documents/experiments/editor && npm run dev`

Verify visually:
- Deep obsidian backgrounds (#131313 editor, #0e0e0e titlebar/statusbar)
- No visible structural borders between panels
- Warm orange (#ff6b00) accent on active tab indicator, activity bar indicator, buttons
- Warm text tones (#e5e2e1 primary, #e2bfb0 secondary)
- Gradient primary buttons
- Bottom-only focus highlight on inputs
- Frosted glass on Command Palette (Cmd+P) and context menus (right-click)
- Orange indicator bar on selected tree node
- Terminal has sunken (#0e0e0e) background
