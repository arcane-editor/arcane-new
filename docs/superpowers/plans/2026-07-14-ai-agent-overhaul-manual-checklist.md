# Manual verification checklist — ai-agent-overhaul (merge gate)

Branch: `ai-agent-overhaul` (f0bc68e..HEAD). Automated gates at HEAD: bun 763/763, tsc clean, check:modules OK, vite build OK. Server already deployed (version 3aef14be) with migration 0011 applied and observability verified live.

Run `bun run tauri dev` in `editor/` with a Unity (or any) workspace open, signed in.

## A. Error surfacing (Workstream D)

- [ ] **Normal turn**: send a simple ask-mode message → streams normally, no error block, no banner.
- [ ] **Abort**: send a long request, press Stop mid-stream → partial text stays, NO error block, no frozen spinner.
- [ ] **Network failure**: turn Wi-Fi off (or add `127.0.0.1 api.arcaneai.org` to /etc/hosts), send → after ~3 retry attempts an inline "Network error" block appears with Retry; expandable raw detail works.
- [ ] **Retry**: restore network, press Retry → the failed turn is replaced by a clean one; NO duplicate user bubble; checkpoint row still present on the retried turn (reanchor fix).
- [ ] **Auth expiry**: in devtools `useAuthStore.setState({ token: 'garbage' })`, send → sign-in gate reappears WITH the "session expired" notice; after re-login the timeline shows the auth error block.
- [ ] **Persistence**: force any error, quit the app fully, relaunch → restored session still shows the error block; Retry works (replays the bubble text).
- [ ] **Server errors visible in dashboards**: after the network-failure test, check dash → Workers & Pages → arcane-server → Logs for `chat_error` JSON lines, and AI → AI Gateway → arcane-ai-gateway → Logs for the request entries (first real traffic through the gateway).

## B. Cursor-style edit review (Workstream E)

- [ ] **Auto-apply**: in agent mode ask for edits to two `.cs`/`.ts` files → edits apply immediately; open tabs show new content and are NOT marked dirty (no dot on the tab).
- [ ] **ReviewBar**: appears above the input: "2 files changed"; expands to per-file rows with Open/Accept/Reject.
- [ ] **Per-diff Accept/Reject**: each tool-call diff block shows Accept/Reject; Reject disabled while the agent is running.
- [ ] **Reject**: reject one file → disk content back to pre-edit, open tab reloads clean, entry leaves the bar, file tree/git refresh.
- [ ] **Accept**: accept the other → entry clears, file unchanged on disk.
- [ ] **Same file twice in one turn** → single review entry; Reject restores to BEFORE the first write.
- [ ] **Unity serialized asset** (`.prefab`/`.unity`/`.asset`): agent edit still shows the pre-apply Apply/Reject prompt with diff; on Apply it does NOT enter the ReviewBar; on Reject nothing lands on disk.
- [ ] **Abort during a Unity-asset approval prompt** → the prompt block locks showing rejected (no stuck buttons).
- [ ] **Persistence**: with pending reviews, quit + relaunch, reopen the session → ReviewBar restores and Reject still works.
- [ ] **Checkpoint restore clears reviews**: with pending reviews, use the checkpoint row's Restore → files restored AND their pending entries leave the bar.
- [ ] **Legacy mode**: Settings → set Apply Mode to Approve → every edit prompts before writing, no ReviewBar (old flow intact).

## C. Todos (Workstream C)

- [ ] **Appears**: give the agent a multi-step task → PlanList shows above the input with items checking off (in_progress → done).
- [ ] **Survives sends**: send a follow-up message → list stays (no wipe).
- [ ] **Survives restart**: quit + relaunch → list restored with the session.
- [ ] **Clears**: New Chat → list gone.
- [ ] **Collapsible**: header shows "Plan (N/M done)", collapse/expand works.
- [ ] **Plan mode**: run plan → execute → todos mirror the plan steps during execution.

## C2. ask_user tool (added 2026-07-14, branch ask-user-tool)

- [ ] **Chip answer**: in agent mode, prompt "Ask me which of two approaches I prefer before doing anything" → a question card with option chips appears mid-turn and the agent waits; click a chip → card locks showing `Answered: <choice>`, agent continues using it.
- [ ] **Typed answer**: repeat; instead of clicking, type in the composer (placeholder should read "Answer the agent's question — or click an option above.") and press Enter → question resolves with your text, NO extra user bubble appears, agent continues.
- [ ] **Attachments survive**: stage an attachment, answer a question by typing → attachment still staged for your next real message.
- [ ] **Stop while pending**: press Stop while a question is open → card shows Cancelled, no error block, no hang.
- [ ] **Restart with open question**: quit while a question pends, relaunch → restored card shows Cancelled.
- [ ] **Plan mode**: give an ambiguous build request in plan mode → model asks a clarifying question BEFORE writing the plan.

## D. Server/gateway (Workstreams A/B — mostly verified live already)

- [x] Migration 0011 applied to prod D1 (PRAGMA verified 2026-07-13).
- [x] `d1_migrations` baselined; `wrangler d1 migrations list --remote` → none pending.
- [x] Deployed version 3aef14be with CF_AI_GATEWAY_ID=arcane-ai-gateway; JWT_SECRET intact.
- [x] Observability live (401 smoke requests visible in Workers Logs, custom domain routing confirmed).
- [ ] **First real chat through the gateway**: after any successful editor chat, gateway Logs show the request (model, tokens, `cached: false`).
- [ ] **Telemetry columns populate**: `npx wrangler d1 execute arcane-db --remote --command "SELECT grounding_lint_hits, loop_guard_hits, escalated FROM request_logs ORDER BY id DESC LIMIT 3;"` returns non-NULL values after one editor turn.

## 2026-08-03 — Shadow suggestions, external routing, hardening

Routing (dev env, after the manual-setup runbook):
- [ ] Chat at Low effort → gateway logs show `custom-minimax/…`; response streams normally
- [ ] Chat at High effort → `custom-moonshot/…` likewise
- [ ] Remove the MiniMax key from a dev secret → Low chat still answers (CF fallback), `wrangler tail` shows `provider_config_fallback`, request_logs.fallback_model set
- [ ] /v1/usage shows non-zero cost for external-model chats (catalog prices)

Inline suggestions:
- [ ] Type in a .cs file, pause → ghost text ≤ ~1s; Tab accepts; Esc dismisses; typing through the suggestion keeps it trimmed without new requests (watch network)
- [ ] Toggle off via status-bar item / mod+alt+i / Settings row → no requests fire
- [ ] Seed inline_usage to the cap on dev → status bar shows "Tab · daily limit" with reset tooltip; no toasts
- [ ] Stop the dev server → after 3 failures status shows "Tab · paused", requests stop for ~60s, then a single probe
- [ ] File > 1MB → no inline requests

Offline / credits:
- [ ] Kill wifi → chat send fails INSTANTLY with "You're offline"; wifi back → Retry succeeds; inline shows "Tab · offline" then recovers
- [ ] Kill wifi mid-stream → existing stall/network error path still works (no regression)
- [ ] Zero a dev account's credits → chat shows "Out of credits" with working "Manage plan & credits" button; status bar shows the low-credit warning; inline completions STILL work (allowance, not credits)
