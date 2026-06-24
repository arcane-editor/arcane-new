# Graph Report - /Users/inno/Documents/experiments/editor  (2026-05-04)

## Corpus Check
- 144 files · ~56,475 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 510 nodes · 551 edges · 30 communities detected
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 65 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Tauri Backend Commands|Tauri Backend Commands]]
- [[_COMMUNITY_AI Agent Tools|AI Agent Tools]]
- [[_COMMUNITY_LSP Document Sync|LSP Document Sync]]
- [[_COMMUNITY_Agent Loop & Chat UI|Agent Loop & Chat UI]]
- [[_COMMUNITY_Monaco TypeScript Setup|Monaco TypeScript Setup]]
- [[_COMMUNITY_Unity IPC|Unity IPC]]
- [[_COMMUNITY_Auth Client Flow|Auth Client Flow]]
- [[_COMMUNITY_LSP Client (TS)|LSP Client (TS)]]
- [[_COMMUNITY_Terminal PTY Backend|Terminal PTY Backend]]
- [[_COMMUNITY_File Scanner & Fuzzy Search|File Scanner & Fuzzy Search]]
- [[_COMMUNITY_LSP Backend (Rust)|LSP Backend (Rust)]]
- [[_COMMUNITY_Unity Scene Parser|Unity Scene Parser]]
- [[_COMMUNITY_AI Event Stream|AI Event Stream]]
- [[_COMMUNITY_C Decorations|C# Decorations]]
- [[_COMMUNITY_Theme Registry|Theme Registry]]
- [[_COMMUNITY_AI Tool Path Utils|AI Tool Path Utils]]
- [[_COMMUNITY_AI Session Persistence|AI Session Persistence]]
- [[_COMMUNITY_AI Edit Diff|AI Edit Diff]]
- [[_COMMUNITY_Auth Backend (Rust)|Auth Backend (Rust)]]
- [[_COMMUNITY_Unity Meta File Manager|Unity Meta File Manager]]
- [[_COMMUNITY_Editor Error Boundary|Editor Error Boundary]]
- [[_COMMUNITY_Platform Detection|Platform Detection]]
- [[_COMMUNITY_State Persistence|State Persistence]]
- [[_COMMUNITY_Exclude Matcher|Exclude Matcher]]
- [[_COMMUNITY_Search Backend (Rust)|Search Backend (Rust)]]
- [[_COMMUNITY_Arcane API Stream|Arcane API Stream]]
- [[_COMMUNITY_File Icon Resolver|File Icon Resolver]]
- [[_COMMUNITY_Settings Backend|Settings Backend]]
- [[_COMMUNITY_AI Tool Operations|AI Tool Operations]]
- [[_COMMUNITY_AI Message Conversion|AI Message Conversion]]

## God Nodes (most connected - your core abstractions)
1. `Agent` - 15 edges
2. `LspClient` - 12 edges
3. `AuthClient` - 9 edges
4. `AgentService` - 9 edges
5. `createTools()` - 7 edges
6. `fileUri()` - 6 edges
7. `syncDocumentOpen()` - 6 edges
8. `parseSceneFile()` - 6 edges
9. `EventStream` - 6 edges
10. `generate_arcane_csproj()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `proactivelyOpenCSharpFiles()` --calls--> `syncDocumentOpen()`  [INFERRED]
  src/stores/workspace.ts → src/features/lsp/services/document-sync.ts
- `handleStop()` --calls--> `getAgentService()`  [INFERRED]
  src/features/ai-panel/components/ChatInput.tsx → src/features/ai-panel/services/agent-service.ts
- `createTools()` --calls--> `createReadTool()`  [INFERRED]
  src/features/ai-panel/services/agent-service.ts → src/features/ai-panel/services/vendor/tools/read.ts
- `createTools()` --calls--> `createWriteTool()`  [INFERRED]
  src/features/ai-panel/services/agent-service.ts → src/features/ai-panel/services/vendor/tools/write.ts
- `createTools()` --calls--> `createEditTool()`  [INFERRED]
  src/features/ai-panel/services/agent-service.ts → src/features/ai-panel/services/vendor/tools/edit.ts

## Communities

### Community 0 - "Tauri Backend Commands"
Cohesion: 0.06
Nodes (47): git_commit(), git_diff(), git_discard_all(), git_discard_file(), git_fetch(), git_list_branches(), git_log(), git_pull() (+39 more)

### Community 1 - "AI Agent Tools"
Cohesion: 0.1
Nodes (14): handleNewChat(), handleKeyDown(), handleSend(), handleStop(), AgentService, buildSystemPrompt(), createTools(), getAgentService() (+6 more)

### Community 2 - "LSP Document Sync"
Cohesion: 0.12
Nodes (12): fileUri(), getOpenDocumentUris(), isSyncablePath(), syncDocumentChange(), syncDocumentClose(), syncDocumentOpen(), syncDocumentSave(), buildTextDocumentPositionParams() (+4 more)

### Community 3 - "Agent Loop & Chat UI"
Cohesion: 0.11
Nodes (6): handleModelChange(), Agent, agentLoop(), runLoop(), streamAssistantResponse(), updateAssistantMessage()

### Community 4 - "Monaco TypeScript Setup"
Cohesion: 0.14
Nodes (12): getMonaco(), initMonaco(), setupWorkspaceIntelliSense(), teardownWorkspaceIntelliSense(), configureTypeScriptDefaults(), disposeExtraLibs(), mapTsConfigToMonaco(), applyCssVariables() (+4 more)

### Community 5 - "Unity IPC"
Cohesion: 0.22
Nodes (10): cleanup_stale_socket(), compute_pipe_path(), ConnectionChangedPayload, encode_frame(), handle_client(), route_message(), unity_ipc_start(), UnityIpcInner (+2 more)

### Community 6 - "Auth Client Flow"
Cohesion: 0.23
Nodes (2): handleSubmit(), AuthClient

### Community 7 - "LSP Client (TS)"
Cohesion: 0.24
Nodes (1): LspClient

### Community 8 - "Terminal PTY Backend"
Cohesion: 0.18
Nodes (6): clone_master_as_writer(), PtyInstance, terminal_spawn(), TerminalExitPayload, TerminalOutputPayload, TerminalState

### Community 9 - "File Scanner & Fuzzy Search"
Cohesion: 0.21
Nodes (7): FileIndexDelta, FileWatcherState, fuzzy_search_files(), FuzzyFileResult, scan_all_files_v2(), ScoredEntry, start_file_watcher()

### Community 10 - "LSP Backend (Rust)"
Cohesion: 0.26
Nodes (11): kill_and_clear(), lsp_send(), lsp_start(), lsp_stop(), lsp_trace_path(), LspInner, LspState, resolve_server_binary() (+3 more)

### Community 12 - "Unity Scene Parser"
Cohesion: 0.31
Nodes (7): extractComponentRefs(), extractField(), extractGuid(), parseSceneFile(), splitDocuments(), extractMonoBehaviourFields(), findScenesUsingScript()

### Community 13 - "AI Event Stream"
Cohesion: 0.2
Nodes (2): AssistantMessageEventStream, EventStream

### Community 14 - "C# Decorations"
Cohesion: 0.38
Nodes (4): applyCSharpDecorations(), clearDecorations(), withAlpha(), getThemeColor()

### Community 15 - "Theme Registry"
Cohesion: 0.29
Nodes (2): loadPersistedThemeId(), getTheme()

### Community 16 - "AI Tool Path Utils"
Cohesion: 0.48
Nodes (5): expandPath(), isAbsolute(), joinPath(), normalizePath(), resolveToCwd()

### Community 18 - "AI Session Persistence"
Cohesion: 0.47
Nodes (3): getSessionsDir(), loadSession(), saveSession()

### Community 19 - "AI Edit Diff"
Cohesion: 0.6
Nodes (4): applyEdits(), fuzzyFindText(), mapNormalizedIndexToOriginal(), normalizeWhitespace()

### Community 20 - "Auth Backend (Rust)"
Cohesion: 0.53
Nodes (5): auth_delete_token(), auth_file_path(), auth_read_token(), auth_write_token(), AuthToken

### Community 21 - "Unity Meta File Manager"
Cohesion: 0.8
Nodes (4): coDeleteMeta(), coRenameMeta(), getMetaPath(), isMetaFile()

### Community 22 - "Editor Error Boundary"
Cohesion: 0.4
Nodes (1): EditorErrorBoundary

### Community 25 - "Platform Detection"
Cohesion: 0.7
Nodes (4): isLinux(), isMac(), isWindows(), ua()

### Community 26 - "State Persistence"
Cohesion: 0.5
Nodes (2): loadLayoutSizes(), saveLayoutSizes()

### Community 27 - "Exclude Matcher"
Cohesion: 0.5
Nodes (2): ExcludeMatcher, globToRegex()

### Community 28 - "Search Backend (Rust)"
Cohesion: 0.4
Nodes (4): FileSearchResult, search_in_files(), SearchMatch, SearchResults

### Community 30 - "Arcane API Stream"
Cohesion: 0.83
Nodes (3): arcaneStream(), convertToOpenAI(), doStream()

### Community 31 - "File Icon Resolver"
Cohesion: 0.67
Nodes (2): getFileIcon(), resolveFileIcon()

### Community 34 - "Settings Backend"
Cohesion: 0.83
Nodes (3): read_settings(), settings_path(), write_settings()

### Community 39 - "AI Tool Operations"
Cohesion: 1.0
Nodes (2): onFileEdited(), onFileWritten()

### Community 40 - "AI Message Conversion"
Cohesion: 1.0
Nodes (2): bashExecutionToUserMessage(), convertToLlm()

## Knowledge Gaps
- **20 isolated node(s):** `UnityProjectInfo`, `PtyInstance`, `TerminalOutputPayload`, `TerminalExitPayload`, `FileEntry` (+15 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Auth Client Flow`** (13 nodes): `handleDeviceFlow()`, `handleSubmit()`, `AuthClient`, `.handleRefreshToken()`, `.loadFromDisk()`, `.login()`, `.logout()`, `.pollDeviceToken()`, `.requestDeviceCode()`, `.saveToken()`, `.signup()`, `AuthTab.tsx`, `auth-client.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `LSP Client (TS)`** (13 nodes): `LspClient`, `.cleanup()`, `.clearPendingTimeout()`, `.getRecentStderr()`, `.handleMessage()`, `.isRunning()`, `.notify()`, `.onExited()`, `.onNotification()`, `.request()`, `.start()`, `.stop()`, `client.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `AI Event Stream`** (10 nodes): `event-stream.ts`, `AssistantMessageEventStream`, `.constructor()`, `createAssistantMessageEventStream()`, `EventStream`, `.constructor()`, `.end()`, `.push()`, `.result()`, `.[Symbol.asyncIterator]()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Theme Registry`** (7 nodes): `registry.ts`, `theme.ts`, `loadPersistedThemeId()`, `persistThemeId()`, `getAllThemes()`, `getTheme()`, `registerTheme()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Editor Error Boundary`** (5 nodes): `EditorErrorBoundary`, `.componentDidCatch()`, `.getDerivedStateFromError()`, `.render()`, `EditorErrorBoundary.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `State Persistence`** (5 nodes): `persistence.ts`, `loadLayoutSizes()`, `loadState()`, `saveLayoutSizes()`, `saveState()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Exclude Matcher`** (5 nodes): `exclude-matcher.ts`, `ExcludeMatcher`, `.constructor()`, `.matches()`, `globToRegex()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `File Icon Resolver`** (4 nodes): `file-icons.tsx`, `getFileIcon()`, `resolveFileIcon()`, `resolveFolderIcon()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `AI Tool Operations`** (3 nodes): `onFileEdited()`, `onFileWritten()`, `tool-operations.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `AI Message Conversion`** (3 nodes): `messages.ts`, `bashExecutionToUserMessage()`, `convertToLlm()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `handleModelChange()` connect `Agent Loop & Chat UI` to `AI Agent Tools`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `createTools()` (e.g. with `createReadTool()` and `createWriteTool()`) actually correct?**
  _`createTools()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `UnityProjectInfo`, `PtyInstance`, `TerminalOutputPayload` to the rest of the system?**
  _20 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Tauri Backend Commands` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `AI Agent Tools` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `LSP Document Sync` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._
- **Should `Agent Loop & Chat UI` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._