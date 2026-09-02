# Input Map — the whole input system on one screen

> **Date:** 2026-09-02
> **Status:** Design, approved in chat. Not yet planned.
> **Supersedes:** the "PlayerInput contract check" pitch from the same session — see *Why not just lint* below.

## Context

The Input Actions editor in this repo currently lists maps, actions and
bindings. That is a port of Unity's own window: it shows the same information
in a second place, so it earns nothing. The user's words: *"if it's just
porting it from Unity to the editor, that's not a moat."*

The thing no tool shows is the **join**. Unity's Input Actions window owns the
left half of the chain; your C# owns the right half; nothing draws the line
between them:

```
Device → Control Scheme → Binding → Interaction → Action ┊ ??? ┊ your method
                    Unity's Input Actions window          gap    your code
```

Drawing that line needs the `.inputactions` asset, the scene/prefab graph and a
code index **in one process**. Unity's window structurally cannot have the code
index. Rider has the code index but no asset semantics. That join is the moat.

**The product is the map. The diagnostics are a property of the map** — a link
that does not connect is drawn broken. That framing also matches the UI Toolkit
binding thread shipped in the same cycle, so the two features read as one idea.

### Why not just lint

The first proposal was a set of `PlayerInput` contract diagnostics
(`UNITY0601`–`0606`). Rejected as the primary framing, for two reasons found
during the probe:

1. **Wrong audience.** Those checks only fire for `PlayerInput` +
   Send Messages, which is the *prototype* path — it is what Unity's own
   starter assets ship. Projects past prototype set `generateWrapperCode: 1`
   and subscribe with `.performed +=`, where three of the six checks never fire
   at all. `STANDOUT-FEATURES.md` puts professional/studio devs first, so the
   lint-first framing was loudest for exactly the audience it was not for.
2. **A diagnostic is invisible until something breaks.** It is insurance, not a
   reason to open the panel. The map is something you look at on purpose.

The checks are not discarded — they become properties of edges in the graph and
can be published as diagnostics in a later phase, at which point they are
justified by a model that already exists rather than being the whole feature.

## What the probe established

All verified on disk against `com.unity.inputsystem@02433b2481ab`.

| Fact | Where | Why it matters |
|---|---|---|
| `PlayerInput` script guid `62899f850307741f2a39c98a8b639597` | package `.meta` | Stable in every project — this is how a `PlayerInput` component is found in prefab/scene YAML |
| `m_NotificationBehavior`: **0** SendMessages · **1** BroadcastMessages · **2** InvokeUnityEvents · **3** InvokeCSharpEvents | `PlayerNotifications.cs:22-42` | Decides how the code edge resolves |
| Handler name is `"On" + MakeTypeName(action.name)` | `PlayerInput.cs:1541` | Sanitised, so `"Move Camera"` → `OnMoveCamera`. A naive `"On" + name` is wrong |
| `SendMessage(msg, value, SendMessageOptions.DontRequireReceiver)` | `PlayerInput.cs:1518` | Unity **deliberately silences** the missing-handler case. This is why the failure is invisible and why drawing it is worth doing |
| `generateWrapperCode` / `wrapperClassName` / `wrapperCodePath` live in `.inputactions.meta` | verified on a real asset | Lets the graph know which code pattern a project uses, and therefore which edges to expect |

### The blind spot this fixes first

`services/action-refs.ts` today detects `FindAction("Jump")`,
`actions["Player/Jump"]` and `void OnJump(...)`. It does **not** detect
generated-wrapper access (`controls.Player.Jump.performed += OnJump`), which
contains no string literal. In a project with `generateWrapperCode: 1` every
action therefore reports **0 references**, and the current UI states outright
*"Nothing in the project reads Jump."* That is confidently wrong, and it is the
reason the existing panel reads as noise. Fixing it is a precondition for the
map being trustworthy at all.

## The model

One pure graph, assembled per `.inputactions` asset.

```ts
interface InputGraph {
  asset: string;                    // project path
  wrapper: WrapperInfo | null;      // from the .meta
  maps: InputMapNode[];
  schemes: ControlSchemeNode[];
  players: PlayerInputNode[];       // PlayerInput components using this asset
}

interface ActionNode {
  map: string;
  name: string;
  type: 'Button' | 'Value' | 'PassThrough';
  bindings: BindingNode[];          // controls, composites, interactions
  code: CodeEdge[];                 // how C# reaches this action
  status: ActionStatus;             // derived, see below
}

type CodeEdge =
  | { via: 'wrapper';      property: string; site: SourceSite }  // controls.Player.Jump
  | { via: 'find-action';  site: SourceSite }                    // FindAction("Jump")
  | { via: 'indexer';      site: SourceSite }                    // actions["Player/Jump"]
  | { via: 'send-message'; method: string; site: SourceSite }    // OnJump(InputValue)
  | { via: 'subscription'; phase: 'started'|'performed'|'canceled'; handler: string; site: SourceSite };

type ActionStatus =
  | 'wired'          // at least one code edge
  | 'unread'         // no code edge, and nothing is suppressing that conclusion
  | 'never-fires'    // starved by a binding conflict
  | 'no-bindings'    // cannot fire at all
  | 'unknown';       // something we cannot see could be reading it
```

`status` is derived, never authored. **`unknown` outranks `unread`**, and the
precise rule is: an action with no code edge is `unknown` rather than `unread`
whenever any asset-level suppressor is present — a scene or prefab references
this `.inputactions` asset (so an `InputActionReference` field may be wired in
the Inspector), or the project contains `[SerializeField] InputActionReference`
at all. Otherwise it is `unread`.

That suppressor lives at **asset granularity on the graph**, not as an edge on
an individual action — resolving a prefab's `fileID` down to which specific
action it references is explicitly out of phase one, so claiming a per-action
inspector edge would be inventing precision we do not have.

The rule from the rest of this codebase applies unchanged: **no snapshot means
say nothing** rather than guess.

## The view

Primary axis is the **action**, because that is the unit developers think in,
with the control on the left and the code on the right so the chain reads in
one direction.

```
INPUT MAP — InputSystem_Actions.inputactions       wrapper: PlayerControls
[ by action ]  [ by control ]  [ by device ]                 ⚠ 3 broken

Player
  <Keyboard>/space  ┐
  <Gamepad>/south   ┼─ Jump     Button  ──→  OnJump()               Player.cs:42
                    ┘
  <Mouse>/left      ─── Fire     Button  ──✕  nothing reads this
  <Keyboard>/r      ─── Reload   Button  ──→  .performed += OnReload  Weapons.cs:88
```

Three pivots on the same graph, which is why the graph is worth building:

- **by action** — the default above.
- **by control** — *"what does Space actually do in this game?"* Every action a
  control triggers, across every map and scheme. Answerable nowhere today.
- **by device** — the coverage matrix: actions × control schemes, holes
  highlighted. This is how *"Cancel has no gamepad binding"* gets found in the
  editor rather than during console certification.

Visual language is inherited, not invented: the same broken-link treatment as
the UI Toolkit binding thread, and the existing `unityide-dark` tokens.

## Scope

**In, phase one**

1. Wrapper + subscription detection in `action-refs.ts` (the blind spot above).
2. `.inputactions.meta` reading for `generateWrapperCode` / `wrapperClassName`.
3. `PlayerInput` extraction from prefab/scene YAML — behaviour, assigned asset,
   default map. Needed to resolve the code edge for Send Messages projects.
4. The pure graph assembly + status derivation.
5. The three pivots.

**Out, deliberately**

- The live Play-Mode input trace. Bigger wow, needs a Unity-package hook, and
  it only reports presses you actually made — it finds nothing on its own. It
  annotates this same graph later, which is the reason to build the graph first.
- Publishing the `UNITY06xx` diagnostics. They fall out of `status`; ship them
  once the map has earned trust.
- Interaction lint (`Hold` with only `.started` subscribed) — same reasoning.
- Rebinding, and `InputActionReference` resolution down to the individual
  action. A scene or prefab that references the asset is recorded as an
  asset-level suppressor that pushes otherwise-unread actions to `unknown`;
  resolving the referenced `fileID` to a specific action is later work.

## Honest limits, surfaced in the UI

- `BroadcastMessages` searches children as well as the same GameObject, so a
  miss there is lower confidence than for `SendMessages`.
- A handler on a component added at runtime via `AddComponent` is invisible.
- Reflection and string-built action names are invisible.

In all three the status is `unknown`, not `unread`. The panel says which of
these it could not see rather than implying the action is dead.

## Verification

- Pure graph assembly, status derivation, wrapper/subscription extraction:
  colocated `bun:test`, fixtures under `editor/src-tauri/fixtures/unity-input/`.
- The `.meta` and `PlayerInput` YAML readers get fixture-driven tests in the
  same style as `fixtures/unity-yaml/EventWiring.prefab`.
- End to end, manual: `~/Arcane Demo` has a real
  `Assets/InputSystem_Actions.inputactions` (Unity's own starter asset). The map
  must render it with **no `unread` false positives**. This is a local project,
  not a repo fixture — it cannot run in CI, so the automated equivalent is a
  trimmed copy of that asset committed under `fixtures/unity-input/`.
- `bun run verify` green, including `verify:intellisense` and `verify:acp`; a
  `SKIPPED` from either is not a pass.
