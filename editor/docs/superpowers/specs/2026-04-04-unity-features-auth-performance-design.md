# Unity Features, Authentication & Performance Optimizations

## Context

This editor is being rebuilt as a Tauri v2 + React 19 + Monaco IDE to replace an older Theia-based IDE (Arcane) that targeted Unity developers. The Theia version had extensive Unity-specific features and account-based auth, but faced customization limits and cross-device reliability issues.

This spec covers porting the core Unity features and auth system from Arcane, plus fixing a critical performance issue where the Cmd+P file search freezes the UI on large Unity projects (100K+ files).

**Source material:** `/Users/inno/Documents/experiments/arcane/arcane-edior/arcane-ui/src/`
**Target project:** `/Users/inno/Documents/experiments/editor/`

---

## Phase 0: Performance Optimizations

### Problem

`PaletteModal.tsx:106-121` runs O(n*m) fuzzy matching synchronously on the main thread for every keystroke. Unity projects contain 100K+ files (Library/, Temp/, obj/ alone have tens of thousands). The current `scan_all_files` Rust command uses hardcoded skip dirs with no `.gitignore` support.

### New Rust Module: `src-tauri/src/file_scanner.rs`

**Replace `scan_all_files` with:**

1. **`.gitignore`-aware parallel scanner** using the `ignore` crate (same crate ripgrep uses). Handles nested `.gitignore`, global gitignore, `.git/info/exclude`. Replaces the hardcoded `skip_dirs` arrays in `lib.rs:84-86,130-131`.

2. **`fuzzy_search_files` command:**
   - Signature: `(workspace_path: String, query: String, max_results: usize, extra_excludes: Vec<String>) -> Vec<FuzzyFileResult>`
   - Uses `nucleo-matcher` crate for Rust-native fuzzy matching
   - Returns `{ path, relative_path, score, match_indices }` for top N results
   - Uses a min-heap to avoid allocating all matches

3. **`start_file_watcher` / `stop_file_watcher` commands + `file-index-changed` event:**
   - Uses `notify` crate (FSEvents on macOS)
   - Emits deltas (added/removed paths) instead of full re-scans
   - 500ms internal debounce to batch rapid filesystem changes

### PaletteModal.tsx Changes

- **150ms debounce** on search input via `useRef` timer
- Replace `useMemo` fuzzy loop with `invoke('fuzzy_search_files', ...)` in `useEffect`
- Cap results at 100
- Add `@tanstack/react-virtual` for virtual scrolling (currently renders ALL DOM nodes)
- Show loading spinner during async gap

### workspace.ts Changes

- Remove `fileIndex: string[]` from store (no longer needed in JS memory)
- Remove `refreshFileIndex()` — replaced by file watcher
- `setWorkspace()` calls `invoke('start_file_watcher', { workspacePath })`
- File mutations (create/rename/delete) no longer trigger full re-scan

### Unity-Specific Auto-Exclusions

When Unity project detected, these patterns are passed as `extra_excludes`:
```
Library/**, Temp/**, obj/**, Logs/**, UserSettings/**, Build/**, Builds/**,
.vs/**, **/*.meta, **/*.csproj, *.sln, **/*.asset
```

Source: `unity-project-detector.ts:25-39`

### New Dependencies

```toml
# Cargo.toml
ignore = "0.4"          # .gitignore parsing + parallel walking
notify = "7"            # Filesystem watching
nucleo-matcher = "0.3"  # Fuzzy matching
sha1 = "0.10"           # IPC pipe path computation
```

```json
// package.json
"@tanstack/react-virtual": "^3"  // Virtual scrolling
```

---

## Phase 1: Unity Project Detection

### New Rust Module: `src-tauri/src/unity.rs`

```rust
#[tauri::command]
fn detect_unity_project(workspace_path: String) -> Result<UnityProjectInfo, String>
```

- Checks `{workspace_path}/Assets` and `{workspace_path}/ProjectSettings` exist
- Reads `ProjectSettings/ProjectVersion.txt`, extracts version via `m_EditorVersion:\s*(.+)` regex
- Returns `{ is_unity: bool, unity_version: Option<String> }`

Source: `unity-project-detector.ts:167-267`

### New Store: `src/stores/project-context.ts`

```typescript
interface ProjectContextState {
  isUnityProject: boolean;
  unityVersion: string | null;
  extraExcludePatterns: string[];
  detectProjectType: (workspacePath: string) => Promise<void>;
  reset: () => void;
}
```

- Called from `workspace.ts` `setWorkspace()` after workspace path is set
- When Unity detected: populates `extraExcludePatterns` with Unity exclusions
- Drives conditional rendering of Unity UI throughout the app

---

## Phase 2: Unity IPC Server

### New Rust Module: `src-tauri/src/unity_ipc.rs`

Port from `unity-connection-server.ts` (505 lines) and `ipc-framer.ts` (88 lines).

**Framing Protocol:**
- Wire format: `[4-byte big-endian u32 length][UTF-8 JSON payload]`
- Max frame size: 16 MB
- Source: `ipc-framer.ts`

**Pipe Path:**
- Formula: `"/tmp/unity-ide-" + SHA1(path.resolve(workspacePath)) + ".sock"`
- MUST match exactly what `arcane-extension`'s C# client computes
- Source: `ipc-pipe-utils.ts:13-22`

**Socket Server:**
- `tokio::net::UnixListener` on macOS/Linux
- Stale socket cleanup before binding (port from `ipc-pipe-utils.ts:28-68`)
- Managed as `UnityIpcState` (like `LspState`, `TerminalState`)
- Auto-started when Unity project detected
- Cleaned up on workspace close / window destroy

**Commands:**
- `unity_ipc_start(workspace_path)` — bind socket, start listening
- `unity_ipc_stop()` — close socket, cleanup
- `unity_ipc_send(message_json)` — send message to connected Unity client

**Message Routing (Tauri events):**

| Unity Message Type | Tauri Event | Payload |
|---|---|---|
| `connection_init` | `unity-connection-changed` | `{ connected: true, info: UnityProjectInfo }` |
| `heartbeat` | (auto-ack) | Responds with `heartbeat_ack` |
| `log` / `log_batch` | `unity-log` / `unity-log-batch` | `UnityLogEntry` / `UnityLogEntry[]` |
| `playstate_changed` | `unity-playstate-changed` | `{ state, isCompiling }` |
| `compilation_started/finished` | `unity-compilation` | `{ started: bool, success?, errors?, warnings? }` |
| `open_file` | `unity-open-file` | `{ path, line, column }` |
| `build_progress/result` | `unity-build-progress/result` | Build data |

Source: `unity-connection-server.ts:362-464`

### New Store: `src/stores/unity.ts`

```typescript
interface UnityState {
  connected: boolean;
  projectInfo: UnityProjectInfo | null;
  playState: 'Stopped' | 'Playing' | 'Paused';
  isCompiling: boolean;
  logs: UnityLogEntry[];

  startIpc: (workspacePath: string) => Promise<void>;
  stopIpc: () => Promise<void>;
  sendPlay: () => Promise<void>;
  sendPause: () => Promise<void>;
  sendStop: () => Promise<void>;
  sendStep: () => Promise<void>;
  clearLogs: () => void;
  addLog: (entry: UnityLogEntry) => void;
  addLogBatch: (entries: UnityLogEntry[]) => void;
}
```

Subscribes to Tauri events via `listen()` from `@tauri-apps/api/event`.

### New Types: `src/types/unity.ts`

Port from `unity-protocol.ts` (237 lines):
- `UnityLogEntry`, `UnityLogType`, `StackFrame`, `UnityPlayState`
- `UnityProjectInfo`, `UnityPlayMode`, `UnityScriptingBackend`
- Message type unions, payload interfaces
- `parseStackTrace(stackTrace: string): StackFrame[]`

---

## Phase 3A: Unity Console

### New Feature: `src/features/unity-console/`

```
src/features/unity-console/
  index.ts                         # exports UnityConsolePanel
  components/
    UnityConsolePanel.tsx           # main console UI
    ConsoleToolbar.tsx              # filter/toggle buttons
    ConsoleLogEntry.tsx             # individual log row
```

Port from `unity-console-widget.tsx` (431 lines). Theia ReactWidget -> React functional component.

**Key behaviors:**
- MAX_LOG_ENTRIES = 10,000 (circular buffer)
- Log type filtering: Log/Warning/Error toggle buttons
- Text search filter on messages
- Collapse identical consecutive messages with count badge
- Auto-scroll to bottom (with user override on manual scroll)
- Expandable stack traces with clickable `file:line` navigation -> `openFile()`
- Listens to `unity-log` / `unity-log-batch` Tauri events

**Integration:**
- Add `'unity-console'` to `BottomPanelTab` type in `src/stores/ui.ts`
- Add tab + render in `src/components/BottomPanel.tsx`
- Conditionally visible when `projectContext.isUnityProject === true`

---

## Phase 3B: Unity Play Mode Controls

### New Feature: `src/features/unity-toolbar/`

```
src/features/unity-toolbar/
  index.ts                         # exports UnityPlayControls
  components/
    UnityPlayControls.tsx           # play/pause/stop/step buttons
```

Port from `unity-play-toolbar.tsx` (142 lines).

**UI:** Pill-shaped control group in `TitleBar.tsx`, conditional on Unity detection.

| Play State | Buttons |
|---|---|
| Stopped | [Play] |
| Playing | [Stop] [Pause] |
| Paused | [Resume] [Stop] [Step] |
| Disconnected | [Play (disabled)] |

**Keyboard shortcuts:** Ctrl+Shift+F5 (Play), F6 (Pause), F10 (Stop), F11 (Step)

**Status bar:** Unity connection indicator (green/gray dot + version) in `StatusBar.tsx`

---

## Phase 3C: C# Intelligence

### New Feature: `src/features/csharp-intelligence/`

```
src/features/csharp-intelligence/
  index.ts
  services/
    lifecycle-db.ts                # Unity lifecycle method database
    csharp-decorations.ts          # Monaco decoration provider
```

**`lifecycle-db.ts`:** Port from `unity-lifecycle-db.ts` (234 lines). Pure data — array of lifecycle method names (Awake, Start, Update, FixedUpdate, LateUpdate, OnEnable, OnDisable, OnDestroy, etc.) with categories and descriptions.

**`csharp-decorations.ts`:**
- Watches active file via workspace store subscription
- When `.cs` file is active + Unity project detected:
  - Regex-matches lifecycle method definitions -> gutter icon + background decoration
  - Regex-matches `[SerializeField]` attributes + public field declarations -> subtle indicator
- Uses `monaco.editor.deltaDecorations()` to apply/update
- Cleans up when switching away from `.cs` files

---

## Phase 4: Scene/Asset Context

### New Feature: `src/features/unity-context/`

```
src/features/unity-context/
  index.ts
  components/
    SceneContextPanel.tsx           # sidebar panel
  services/
    scene-parser.ts                 # YAML parser for .unity/.prefab files
    guid-resolver.ts                # GUID <-> asset path resolution
```

**Scene Parser** (port from `scene-graph-parser.ts`, 581 lines):
- Splits Unity YAML files on `--- !u!<classID> &<fileID>` markers
- Extracts GameObjects (name, tag, layer, active)
- Extracts Transform hierarchy (parent/child)
- Extracts Component references + MonoBehaviour script GUIDs
- Extracts serialized field values
- Start in TypeScript. Move to Rust (`src-tauri/src/scene_parser.rs`) if perf insufficient for large scenes.

**GUID Resolver:**
- New Rust command: `scan_meta_files(workspace_path) -> HashMap<String, String>`
- Scans `.meta` files for `guid: <hex32>` entries
- Builds bidirectional GUID <-> asset path map
- Cached in project-context store

**Scene Context Panel:**
- Sidebar panel (add `'scene-context'` to `SidebarView` in `ui.ts`)
- Tree view: Scene > GameObject > Components > Serialized Fields
- "Copy GUID" context menu for assets
- Click entry to open the `.unity`/`.prefab` file
- Visible when Unity project detected

---

## Phase 5: Authentication

### New Rust Module: `src-tauri/src/auth.rs`

Token storage with secure file permissions:
- `auth_read_token()` -> reads `~/.arcane/auth.json`, returns `{ token, email }`
- `auth_write_token(token, email)` -> writes with `0o600` Unix permissions
- `auth_delete_token()` -> removes the file

### Auth Client: `src/features/auth/services/auth-client.ts`

Port from `arcane-auth-service-impl.ts` (239 lines).

- Server URL: `https://api.arcaneai.org`
- `login(email, password)` -> `POST /v1/auth/login`
- `signup(email, password, promoCode?)` -> `POST /v1/auth/signup`
- `requestDeviceCode()` -> `POST /v1/auth/device/code` (returns device_code, user_code, verification_uri)
- `pollDeviceToken(deviceCode)` -> `POST /v1/auth/device/token` (5s polling interval)
- Token refresh via `X-Refreshed-Token` response header
- Disk I/O via Rust `invoke` commands (secure permissions)

### New Store: `src/stores/auth.ts`

```typescript
interface AuthState {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  token: string | null;
  loading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<boolean>;
  signup: (email: string, password: string, promoCode?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  loadFromDisk: () => Promise<void>;
  requestDeviceCode: () => Promise<DeviceCodeResponse>;
  pollDeviceToken: (deviceCode: string) => Promise<DeviceTokenResult>;
}
```

`loadFromDisk()` called on app startup in `App.tsx`.

### Auth Tab UI: `src/features/auth/`

```
src/features/auth/
  index.ts
  components/
    AuthTab.tsx              # login/signup form (opens as editor tab)
    DeviceFlowPanel.tsx      # device code display + polling
    UserProfileBadge.tsx     # status bar display
  services/
    auth-client.ts
```

**Tab mechanism:** Uses virtual path `auth://account` (same pattern as `diff://` tabs). The tab system renders `<AuthTab />` when this is the active file path.

**AuthTab.tsx:**
- Login form: email + password fields, submit, error display
- Toggle to signup: same + optional promo code
- Device flow panel as alternative auth method
- Once logged in: account info, usage stats, logout button

**Integration:**
- "Sign In" / "Account" command registered in command palette
- User email or "Sign In" in `StatusBar.tsx` (right side)
- Auth state loaded on app init

---

## File Change Summary

### New Files (27)

**Rust backend:**
1. `src-tauri/src/file_scanner.rs`
2. `src-tauri/src/unity.rs`
3. `src-tauri/src/unity_ipc.rs`
4. `src-tauri/src/auth.rs`

**Stores:**
5. `src/stores/project-context.ts`
6. `src/stores/unity.ts`
7. `src/stores/auth.ts`

**Types:**
8. `src/types/unity.ts`

**Features:**
9. `src/features/unity-console/index.ts`
10. `src/features/unity-console/components/UnityConsolePanel.tsx`
11. `src/features/unity-console/components/ConsoleToolbar.tsx`
12. `src/features/unity-console/components/ConsoleLogEntry.tsx`
13. `src/features/unity-toolbar/index.ts`
14. `src/features/unity-toolbar/components/UnityPlayControls.tsx`
15. `src/features/csharp-intelligence/index.ts`
16. `src/features/csharp-intelligence/services/lifecycle-db.ts`
17. `src/features/csharp-intelligence/services/csharp-decorations.ts`
18. `src/features/unity-context/index.ts`
19. `src/features/unity-context/components/SceneContextPanel.tsx`
20. `src/features/unity-context/services/scene-parser.ts`
21. `src/features/unity-context/services/guid-resolver.ts`
22. `src/features/auth/index.ts`
23. `src/features/auth/components/AuthTab.tsx`
24. `src/features/auth/components/DeviceFlowPanel.tsx`
25. `src/features/auth/components/UserProfileBadge.tsx`
26. `src/features/auth/services/auth-client.ts`

### Existing Files to Modify (10)

27. `src-tauri/Cargo.toml` — add `ignore`, `notify`, `nucleo-matcher`, `sha1`
28. `src-tauri/src/lib.rs` — register new modules, commands, managed state
29. `src/features/command-palette/components/PaletteModal.tsx` — debounce, async Rust search, virtual scroll
30. `src/stores/workspace.ts` — remove `fileIndex`, add file watcher, call project detection
31. `src/stores/ui.ts` — extend `BottomPanelTab` and `SidebarView` types
32. `src/components/BottomPanel.tsx` — add Unity Console tab
33. `src/components/StatusBar.tsx` — add Unity connection + auth user display
34. `src/components/ActivityBar.tsx` — add scene context sidebar icon
35. `src/components/SidebarPanel.tsx` — add scene context panel routing
36. `src/App.tsx` — Unity toolbar, Unity commands, auth init, `auth://` tab routing

### Frontend Dependency

37. `package.json` — add `@tanstack/react-virtual`

---

## Implementation Order

Phases can be partially parallelized:

```
Phase 0 (Performance) ──> Phase 1 (Detection) ──> Phase 2 (IPC) ──> Phase 3A-C (Console, Toolbar, C#)
                                                                ──> Phase 4 (Scene Context)
Phase 5 (Auth) can run in parallel with everything
```

---

## Risk Areas

1. **IPC Protocol Compatibility** — Pipe path formula + framing MUST match the C# extension exactly. Write integration tests with known test vectors.

2. **Performance Regression** — Moving fuzzy to Rust adds IPC overhead. The 150ms debounce absorbs this. `nucleo-matcher` handles millions of candidates in <10ms.

3. **File Watcher Reliability** — `notify` on macOS uses FSEvents which can coalesce events. Keep a manual "Refresh" command as fallback.

4. **Large Scene Files** — Unity scenes can be 50-100MB. Start with TypeScript parser; if too slow, port to Rust.

5. **Auth Token Security** — Rust `auth_write_token` uses `0o600` permissions. Verify in tests.

---

## Verification

- Open a Unity project: verify detection, status bar shows version, exclusion patterns applied
- Cmd+P with 100K+ files: verify no freeze, results appear within 200ms
- Start Unity with arcane-extension: verify IPC connection, status shows "Connected"
- Enter/exit Play Mode: verify toolbar state updates
- Open .cs MonoBehaviour: verify lifecycle method highlighting
- Login via auth tab: verify token persists across restart
- Device flow: verify code display and polling
