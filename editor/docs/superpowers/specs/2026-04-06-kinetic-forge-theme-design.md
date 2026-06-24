# Kinetic Forge Theme — Unity Dark Redesign

**Date:** 2026-04-06
**Approach:** Direct Theme Override (Option A) — update `unity-dark.ts` theme definition + `App.css` styling. No architecture changes.

---

## 1. Design Philosophy

The "Kinetic Forge" design system replaces the standard VS Code-derived look with a workspace that feels like a high-end physical tool. Core principles:

- **Tonal Layering** over structural lines — boundaries defined by background color shifts, not borders
- **Deep obsidian surfaces** — layered charcoal tones for reduced eye strain during long sessions
- **Focus Funnel** — high-contrast typography against deep surfaces directs eyes to the code
- **Warm accent palette** — vibrant orange (#ff6b00) reserved for active states and critical elements

---

## 2. Color Token Mapping

### 2.1 Existing UiColors tokens — new values

| Token | Old Value | New Value | Design System Role |
|-------|-----------|-----------|-------------------|
| `bg-primary` | `#1E1E1E` | `#131313` | `surface` — base editor layer |
| `bg-sidebar` | `#212121` | `#1a1a1a` | `surface-container-low` — recessed sidebar |
| `bg-titlebar` | `#181818` | `#0e0e0e` | `surface-container-lowest` — deepest layer |
| `bg-tab-active` | `#1E1E1E` | `#131313` | Matches editor `surface` |
| `bg-tab-inactive` | `#212121` | `#1a1a1a` | Matches sidebar tone |
| `bg-statusbar` | `#181818` | `#0e0e0e` | `surface-container-lowest` |
| `bg-activity-bar` | `#181818` | `#0e0e0e` | `surface-container-lowest` |
| `bg-breadcrumbs` | `#1E1E1E` | `#131313` | Matches `surface` |
| `bg-input` | `#2D2D2D` | `#1e1e1e` | `surface-container` — slightly raised |
| `text-primary` | `#D4D4D4` | `#e5e2e1` | `on-surface` — warm white |
| `text-secondary` | `#808080` | `#e2bfb0` | `on-surface-variant` — warm peach tint |
| `text-active` | `#FFFFFF` | `#ffffff` | No change |
| `text-breadcrumb` | `#808080` | `#8a7a72` | Warm muted breadcrumb |
| `text-breadcrumb-active` | `#D4D4D4` | `#e5e2e1` | Matches `on-surface` |
| `accent` | `#E09956` | `#ff6b00` | `primary-container` — vibrant orange |
| `border` | `#2B2B2B` | `rgba(90, 65, 54, 0.15)` | Ghost border — `outline-variant` at 15% opacity |
| `hover` | `#2A2D2E` | `rgba(255, 255, 255, 0.04)` | Subtle surface shift |
| `selected` | `#37373D` | `#7b3409` | `secondary-container` — warm selection |
| `overlay-shadow` | `rgba(0,0,0,0.6)` | `rgba(0,0,0,0.4)` | Reduced, tinted shadow |
| `badge-bg` | `rgba(224,153,86,0.15)` | `rgba(255,107,0,0.15)` | Updated to match new accent |
| `hover-overlay` | `rgba(255,255,255,0.06)` | `rgba(255,255,255,0.04)` | Subtler hover |
| `statusbar-hover` | `rgba(224,153,86,0.15)` | `rgba(255,107,0,0.12)` | Warm accent tint |
| `error-bg` | `rgba(244,71,71,0.12)` | `rgba(244,71,71,0.10)` | Slightly softer |
| `error-border` | `#F44747` | `#F44747` | No change |
| `error-text` | `#F44747` | `#F44747` | No change |
| `editor-error-btn` | `#E09956` | `#ff6b00` | Matches new accent |
| `editor-error-btn-hover` | `#E8B27D` | `#ffb693` | Matches `primary-light` |
| `folder-icon` | `#E09956` | `#ff6b00` | Matches new accent |

### 2.2 New tokens to add to `UiColors` interface

| Token | Value | Purpose |
|-------|-------|---------|
| `surface-container-high` | `#2a2a2a` | Inspector fields, raised elements |
| `surface-container-highest` | `#333333` | Tooltips, topmost floating layers |
| `surface-bright` | `#3a3a3a` | Frosted glass modals (with blur) |
| `primary-light` | `#ffb693` | Light end of gradient CTAs |
| `ghost-border` | `rgba(90, 65, 54, 0.15)` | Explicit ghost border for floating elements |

These new tokens must be added to:
1. `src/features/theme/types.ts` — `UiColors` interface
2. `src/features/theme/definitions/unity-dark.ts` — values above
3. All other theme definitions — use these fallback rules:
   - `surface-container-high`: use their existing `bg-input` value
   - `surface-container-highest`: lighten their `bg-input` by ~10%
   - `surface-bright`: lighten their `bg-input` by ~20%
   - `primary-light`: lighten their `accent` by ~30%
   - `ghost-border`: copy their existing `border` value

---

## 3. Border Removal — The "No-Line" Rule

### 3.1 Borders to REMOVE (tonal layering replaces them)

These elements sit against visually distinct backgrounds, making borders redundant:

| CSS Selector | Border Property | Reason Safe to Remove |
|-------------|----------------|----------------------|
| `.activity-bar` | `border-right` | `#0e0e0e` vs `#1a1a1a` sidebar |
| `.activity-bar--right` | `border-left` | Same logic, right side |
| `.title-bar` | `border-bottom` | `#0e0e0e` vs `#131313` editor |
| `.sidebar-header` | `border-bottom` | Text weight creates hierarchy |
| `.explorer-header` | `border-bottom` | Padding + weight sufficient |
| `.tab-bar` | `border-bottom` | `#1a1a1a` vs `#131313` editor |
| `.tab` | `border-right` | Tabs separated by active state bg shift |
| `.breadcrumbs` | `border-bottom` | Same surface as editor, use 4px padding gap |
| `.bottom-panel` | `border-top` | Terminal sunken to `#0e0e0e` |
| `.bottom-panel-header` | `border-bottom` | Header vs content tonal shift |
| `.terminal-tabs` | `border-bottom` | Background difference suffices |
| `.ai-panel-header` | `border-bottom` | Within sidebar bg |
| `.ai-panel-input-area` | `border-top` | Within sidebar bg |
| `.scm-commit-box` | `border-bottom` | Within sidebar |
| `.scm-toolbar` | `border-bottom` | Within sidebar |
| `.search-summary` | `border-bottom` | Within sidebar |
| `.problems-filter-bar` | `border-bottom` | Within sidebar |

### 3.2 Borders to KEEP as Ghost Borders

Floating elements that need edge definition use `var(--ghost-border)`:

| CSS Selector | Treatment |
|-------------|-----------|
| `.palette` | `1px solid var(--ghost-border)` |
| `.theme-picker` | `1px solid var(--ghost-border)` |
| `.context-menu` | `1px solid var(--ghost-border)` |
| `.notification-toast` | `1px solid var(--ghost-border)` |
| `.branch-picker` | `1px solid var(--ghost-border)` |

### 3.3 Input fields — bottom-only focus highlight

All text inputs change from box border to:
- Default: `border: none; border-bottom: 1px solid transparent`
- Focused: `border-bottom-color: var(--accent)`

Affected selectors:
- `.scm-commit-input`
- `.search-input`, `.search-filter-input`
- `.theme-picker-input`
- `.inline-input`
- `.ai-panel-input-wrapper`
- `.ai-panel-model-select`

### 3.4 Dividers become whitespace

`.context-menu-separator`: Replace `height: 1px; background: var(--border)` with `height: 4px; background: transparent`.

---

## 4. Component Restyling

### 4.1 Tree Views (Explorer, SCM, Search)

**Selection state** (`.tree-node.selected`):
```css
background: var(--selected);            /* #7b3409 */
border-left: 2px solid var(--accent);   /* #ff6b00 indicator bar */
padding-left: 6px;                      /* compensate for indicator */
```

**Hover state** (`.tree-node:hover`):
```css
background: var(--hover);              /* rgba(255,255,255,0.04) */
```

### 4.2 Buttons

**Primary buttons** (`.welcome-btn`, `.scm-commit-btn`, `.ai-panel-send`, `.editor-error button`):
```css
background: linear-gradient(135deg, var(--primary-light), var(--accent));
border-radius: 2px;
```

**Ghost buttons** (`.explorer-action-btn`, `.scm-toolbar-btn`, `.scm-file-action-btn`, `.bottom-panel-close`, `.terminal-add-btn`):
```css
/* default: no fill, no border */
/* hover: */
background: var(--surface-container-highest);
```

### 4.3 Floating Elements — "Frosted Obsidian"

**Command Palette & Theme Picker**:
```css
background: rgba(58, 58, 58, 0.6);     /* surface-bright at 60% */
backdrop-filter: blur(20px);
-webkit-backdrop-filter: blur(20px);
border: 1px solid var(--ghost-border);
box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
```

**Context Menu**:
Same frosted treatment. Border-radius stays `4px`.

**Notifications**:
Same frosted glass. Border-radius: `12px` (`xl` — spec reserves `xl` for notifications, `full` for tooltips).

### 4.4 Tab Bar

**Active tab**:
- Background: `var(--bg-tab-active)` (#131313)
- Bottom 2px indicator: `var(--accent)` (#ff6b00)
- Text: `var(--text-active)` white
- No right border

**Inactive tabs**:
- Background: `var(--bg-tab-inactive)` (#1a1a1a)
- Text: `var(--text-secondary)` (#e2bfb0) — warm receding tone
- No right border between tabs

### 4.5 Status Bar

- Background: `#0e0e0e` (deepest layer)
- Default text: warm `var(--text-secondary)` (#e2bfb0)
- Hover: `var(--statusbar-hover)` — `rgba(255, 107, 0, 0.12)`

### 4.6 Scrollbars

Update dark theme scrollbar thumb from `rgba(255,255,255,0.15)` to `rgba(255,255,255,0.10)` for subtlety. Hover stays at `rgba(255,255,255,0.28)`.

---

## 5. Monaco Editor Theme Updates

Update the `monaco.colors` object in `unity-dark.ts`:

| Key | Old | New |
|-----|-----|-----|
| `editor.background` | `#1E1E1E` | `#131313` |
| `editor.foreground` | `#D4D4D4` | `#e5e2e1` |
| `editorCursor.foreground` | `#E09956` | `#ff6b00` |
| `editor.lineHighlightBackground` | `#252526` | `#1a1a1a` |
| `editor.selectionBackground` | `#264F78` | `rgba(123, 52, 9, 0.5)` |
| `editorLineNumber.foreground` | `#5A5A5A` | `#4a4a4a` |
| `editorLineNumber.activeForeground` | `#C6C6C6` | `#e5e2e1` |
| `editorIndentGuide.background` | `#333333` | `#1e1e1e` |
| `editorWidget.background` | `#212121` | `#1a1a1a` |
| `editorWidget.border` | `#2B2B2B` | `rgba(90, 65, 54, 0.15)` |

Monaco syntax highlighting token rules remain unchanged — they are independent of the surface palette.

---

## 6. Terminal Theme Updates

| Key | Old | New |
|-----|-----|-----|
| `background` | `#1E1E1E` | `#0e0e0e` |
| `foreground` | `#D4D4D4` | `#e5e2e1` |
| `cursor` | `#E09956` | `#ff6b00` |
| `cursorAccent` | `#1E1E1E` | `#0e0e0e` |
| `selectionBackground` | `rgba(224,153,86,0.3)` | `rgba(255,107,0,0.25)` |
| `black` | `#1E1E1E` | `#131313` |
| `yellow` | `#E09956` | `#ff6b00` |
| `brightYellow` | `#E09956` | `#ff6b00` |

Other terminal ANSI colors (red, green, blue, magenta, cyan, white) remain unchanged.

---

## 7. Files to Modify

| File | Changes |
|------|---------|
| `src/features/theme/types.ts` | Add 5 new tokens to `UiColors` interface |
| `src/features/theme/definitions/unity-dark.ts` | Update all UI color values, Monaco colors, terminal colors |
| `src/features/theme/definitions/unity-light.ts` | Add new tokens with sensible light-theme defaults |
| `src/features/theme/definitions/dark-plus.ts` | Add new tokens with existing-style defaults |
| `src/features/theme/definitions/light-plus.ts` | Add new tokens with existing-style defaults |
| `src/features/theme/definitions/monokai.ts` | Add new tokens with existing-style defaults |
| `src/features/theme/definitions/dracula.ts` | Add new tokens with existing-style defaults |
| `src/App.css` | Remove ~17 borders, update inputs, buttons, tree views, floating elements, scrollbars |

---

## 8. What Is NOT Changing

- **Architecture**: Theme pipeline (registry → store → apply) stays identical
- **Layout structure**: Flexbox layout, Allotment splits, component hierarchy untouched
- **Fonts**: Inter + JetBrains Mono already in use (matches spec)
- **Other themes**: Only receive new token defaults — their visual identity stays intact
- **Monaco syntax highlighting rules**: Token colors unchanged
- **Component logic**: No React component changes needed (CSS-only updates)
