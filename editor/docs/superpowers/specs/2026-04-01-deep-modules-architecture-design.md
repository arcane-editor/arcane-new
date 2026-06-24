# Deep Modules Architecture

## Goal

Restructure the IDE frontend from flat `components/`, `services/`, `stores/` folders into a feature-sliced architecture where each feature is self-contained and exports only a public API via `index.ts`. This prevents AI tools or developers from accidentally breaking features by modifying shared internals.

## Directory Structure

```
src/
  features/
    editor/
      index.ts
      components/
        EditorPanel.tsx
        EditorErrorBoundary.tsx
        Breadcrumbs.tsx
      services/
        monaco-init.ts
        monaco-typescript.ts
        monaco-workers.ts

    lsp/
      index.ts
      services/
        client.ts
        document-sync.ts
        providers.ts

    terminal/
      index.ts
      components/
        TerminalInstance.tsx
        TerminalTabs.tsx

    git/
      index.ts
      components/
        SourceControlPanel.tsx
        BranchPicker.tsx

    explorer/
      index.ts
      components/
        ExplorerPanel.tsx

    theme/
      index.ts
      components/
        ThemePicker.tsx
      definitions/
        dark-plus.ts
        light-plus.ts
        monokai.ts
        dracula.ts
      registry.ts
      apply.ts
      types.ts

  stores/
    workspace.ts
    ui.ts
    terminal.ts
    git.ts
    theme.ts

  components/
    ActivityBar.tsx
    SidebarPanel.tsx
    TabBar.tsx
    TitleBar.tsx
    StatusBar.tsx
    BottomPanel.tsx
    WelcomeScreen.tsx

  hooks/

  utils/
    persistence.ts

  types/
    index.ts

  App.tsx
  App.css
  main.tsx
```

## Features

### editor
Monaco editor rendering and TypeScript configuration.

**Contains:** EditorPanel (main editor + diff editor), EditorErrorBoundary, Breadcrumbs, monaco-init (initialization + workspace IntelliSense setup), monaco-typescript (compiler options mapper), monaco-workers (web worker config).

**Public API (`index.ts`):**
- `EditorPanel` - Main editor component
- `EditorErrorBoundary` - Error boundary wrapper
- `Breadcrumbs` - Path breadcrumbs component
- `initMonaco`, `getMonaco` - Monaco instance management
- `setupWorkspaceIntelliSense`, `teardownWorkspaceIntelliSense` - TS worker configuration
- `updateExtraLib`, `disposeExtraLibs` - Extra lib management

### lsp
Language Server Protocol client, document synchronization, and Monaco IntelliSense providers.

**Contains:** LspClient class (JSON-RPC over Tauri IPC), document sync (didOpen/didChange/didClose/didSave), Monaco providers (completion, hover, definition, signature help, references, diagnostics, editor opener).

**Public API (`index.ts`):**
- `lspClient` - Singleton LSP client instance
- `registerLspProviders` - Register all Monaco LSP providers
- `syncDocumentOpen`, `syncDocumentClose`, `syncDocumentSave`, `syncDocumentChange` - Document lifecycle
- `resetDocumentVersions` - Reset version tracking
- `getPendingNavigation`, `clearPendingNavigation` - Cross-file Go to Definition state

### terminal
Integrated terminal emulator using xterm.js.

**Contains:** TerminalInstance (xterm.js wrapper), TerminalTabs (tab bar with + button).

**Public API (`index.ts`):**
- `TerminalInstance` - Single terminal component
- `TerminalTabs` - Terminal tab bar component

### git
Git/source control UI.

**Contains:** SourceControlPanel (staged/unstaged file lists with stage/unstage/discard actions), BranchPicker (branch selection modal).

**Public API (`index.ts`):**
- `SourceControlPanel` - Git changes panel
- `BranchPicker` - Branch picker modal

### explorer
File tree browser.

**Contains:** ExplorerPanel (React Arborist tree with git status badges, lazy loading, context menu).

**Public API (`index.ts`):**
- `ExplorerPanel` - File tree component

### theme
Theme system (definitions, registry, application to CSS/Monaco/terminal).

**Contains:** ThemePicker component, theme definitions (dark-plus, light-plus, monokai, dracula), registry (lookup/list), apply (CSS variables + Monaco themes + terminal colors), theme types.

**Public API (`index.ts`):**
- `ThemePicker` - Theme selection modal
- `applyTheme`, `ensureMonacoTheme` - Theme application functions
- `getTheme`, `getAllThemes` - Theme registry access
- Theme type definitions

## Rules

1. **Features import other features ONLY via `index.ts`**
   ```typescript
   // ALLOWED
   import { lspClient } from '../features/lsp';

   // FORBIDDEN
   import { LspClient } from '../features/lsp/services/client';
   ```

2. **No feature imports another feature's internal files.** Only the `index.ts` barrel export.

3. **Stores are centralized in `stores/`.** All Zustand stores live here and can be imported by any feature or component.

4. **Shared `components/`, `hooks/`, `utils/`, `types/` can be imported by anyone.**

5. **Feature-internal components/hooks/services stay inside the feature folder** and are not imported from outside.

## File Migration Map

| Current Path | New Path |
|---|---|
| `src/components/Editor.tsx` | `src/features/editor/components/EditorPanel.tsx` |
| `src/components/EditorErrorBoundary.tsx` | `src/features/editor/components/EditorErrorBoundary.tsx` |
| `src/components/Breadcrumbs.tsx` | `src/features/editor/components/Breadcrumbs.tsx` |
| `src/services/monaco-init.ts` | `src/features/editor/services/monaco-init.ts` |
| `src/services/monaco-typescript.ts` | `src/features/editor/services/monaco-typescript.ts` |
| `src/monaco-workers.ts` | `src/features/editor/services/monaco-workers.ts` |
| `src/services/lsp-client.ts` | `src/features/lsp/services/client.ts` |
| `src/services/lsp-document-sync.ts` | `src/features/lsp/services/document-sync.ts` |
| `src/services/monaco-lsp-providers.ts` | `src/features/lsp/services/providers.ts` |
| `src/components/TerminalInstance.tsx` | `src/features/terminal/components/TerminalInstance.tsx` |
| `src/components/TerminalTabs.tsx` | `src/features/terminal/components/TerminalTabs.tsx` |
| `src/components/SourceControlPanel.tsx` | `src/features/git/components/SourceControlPanel.tsx` |
| `src/components/BranchPicker.tsx` | `src/features/git/components/BranchPicker.tsx` |
| `src/components/ExplorerPanel.tsx` | `src/features/explorer/components/ExplorerPanel.tsx` |
| `src/components/ThemePicker.tsx` | `src/features/theme/components/ThemePicker.tsx` |
| `src/themes/dark-plus.ts` | `src/features/theme/definitions/dark-plus.ts` |
| `src/themes/light-plus.ts` | `src/features/theme/definitions/light-plus.ts` |
| `src/themes/monokai.ts` | `src/features/theme/definitions/monokai.ts` |
| `src/themes/dracula.ts` | `src/features/theme/definitions/dracula.ts` |
| `src/themes/registry.ts` | `src/features/theme/registry.ts` |
| `src/themes/apply.ts` | `src/features/theme/apply.ts` |
| `src/themes/types.ts` | `src/features/theme/types.ts` |
| `src/services/persistence.ts` | `src/utils/persistence.ts` |
| `src/components/Sidebar.tsx` | DELETED (unused, replaced by SidebarPanel) |
| All other components in `src/components/` | Stay in `src/components/` (shared) |
| All stores in `src/stores/` | Stay in `src/stores/` |
| `src/types/index.ts` | Stay in `src/types/` |

## Verification

1. `npx tsc --noEmit` compiles clean after restructuring
2. `bun run tauri dev` launches and all features work
3. No feature imports another feature's internal files (only `index.ts`)
4. CLAUDE.md documents the architecture rules
