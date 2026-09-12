# First-class ScriptableObject support

A ScriptableObject is not a script. It is **game data** — the numbers a designer
balances, the tables a system reads, the wiring that holds a project together.
Every other tool treats it as either a C# file or an opaque YAML blob, and
neither is what it is.

Rider renders a `.asset` as raw YAML. Cursor cannot see it at all. Unity's own
Inspector shows one asset at a time, behind a domain reload. This feature treats
it as data.

## What it gives you

| You open | Editor pane | Right Inspector panel |
|---|---|---|
| `WeaponDef.cs` (a `ScriptableObject`) | the C# file + an `N instances` codelens | **Instances** · **Usages** · **Drift** (when there is any) |
| `Sidewinder_SMG.asset` (an instance) | a typed form + reference map | *not applicable — one asset is a form, not a table* |
| a MonoBehaviour `.cs` | unchanged | unchanged — today's `SceneUsagePanel`, byte for byte |

Plus a **Scriptable Objects** entry in the left activity bar: every data asset in
the project grouped by its class.

## Layout

```
components/
  ScriptableObjectsPanel  left sidebar — all types in the project
  UnityInspectorPanel     right panel — decides which view, owns the tabs
    InspectorTabs         local two/three-tab strip
    SoInstancesTab        the value table
    SoDriftTab            class-vs-assets findings + one-click fixes
  ScriptableObjectEditor  the .asset editor pane
    SoFieldRow            one label + control
    SoReferenceMap        referenced-by / references-out, at the form's foot
services/
  asset-fields-client     the ONLY invoke site for asset field I/O
  so-inspector-gate       pure: which view the panel shows
  so-instance-columns     pure: which columns, what goes in a cell
  so-value-model          pure: schema (intent) x asset (truth) -> rows
  so-value-format         pure: Unity's serialization quirks, both directions
  so-drift                pure: what the class says vs. what the assets store
  so-codelens             the class-level "N instances" lens
```

The schema itself lives in **`unity-analyzers`** (`services/so-schema.ts`), not
here — see *Where the schema lives* below.

### Rust

| File | Role |
|---|---|
| `src-tauri/src/unity_asset_edit.rs` | span locator, byte-exact splice writer, the four commands |
| `src-tauri/src/fs_atomic.rs` | `write_atomic` — temp beside the target, fsync, rename |
| `src-tauri/src/unity_yaml.rs` | `split_document_spans` (added here) |
| `src-tauri/fixtures/unity-yaml/*.asset` | the byte-exactness fixtures |

Commands: `unity_asset_read_fields`, `unity_asset_apply_edits`,
`unity_asset_read_many`, `unity_scriptable_object_types`.

Settings: `unity.scriptableObjects.inspector`, `unity.scriptableObjects.browser`,
`unity.codeLens.scriptableObjectInstances` — all default `true`, all
Unity-gated.

---

## The four invariants

Everything here is a consequence of one of these. Break one and the feature
becomes unsafe rather than merely wrong.

### 1. Never re-serialise. Splice byte spans.

Changing one field must leave **every other byte** of the file untouched: line
endings, trailing whitespace, a missing final newline, the `%YAML`/`%TAG`
preamble, key order, and every field our parsers do not model. Unity
re-serialises assets itself, so a byte we move is a spurious diff for the whole
team, and anything we drop is lost data.

So the writer locates the exact byte range of one value and splices a
replacement into the original text. Everything outside that range survives *by
construction*, not by care.

Two properties assert it, both over `Vec<u8>`, never `String`:

- **P1 tiling** — `preamble ++ Σ(header ++ body)` reassembles the input exactly.
- **P2 surgical splice** — `old[..start] == new[..start]` and
  `old[end..] == new[start+len..]`. This forbids *any* byte outside the edited
  substring from moving. Stronger than "it still parses"; stronger than a diff.

The headline test is `no_op_edit_round_trips_byte_identically`: set every
editable field to the value it already has, over every fixture × {LF, CRLF,
no-final-newline}, and require the output bytes to equal the input.

### 2. Under-claim, never over-claim.

The schema decides which widget a field gets. Guessing `float` for something
Unity actually stored as `{fileID: 0}` writes a scalar over an object reference
and **silently unassigns it**. Guessing `unknown` for a float merely costs an
edit.

So `widgetForType` falls back to `'unknown'` (a read-only row) rather than
picking something plausible. `WIDGET_BY_TYPE` maps `AnimationCurve`, `Gradient`
and `Matrix4x4` to `'unknown'` *deliberately* — a declared `'unknown'` is a
decision; a missing key is a type nobody thought about, and a drift test fails
the build until one is made.

### 3. Two-source reconciliation.

The C# class is **intent**. The bytes on disk are **truth**. They disagree
constantly, and `so-value-model` gives every disagreement a name rather than a
crash or a guess:

| State | Meaning |
|---|---|
| `bound` | schema field, key of the same name |
| `migrated` | bound through a `[FormerlySerializedAs]` name |
| `missing` | in the class, not in the asset — writing it *inserts* the key |
| `degraded` | present, but the shape contradicts the type → **read-only** |
| `unmapped` | in the asset, not in the class — a rename's debris |

`degraded` is the safety net that lets invariant 2 be merely good rather than
perfect: truth gets a veto over intent.

### 4. A no-op must never reach disk.

An unchanged value that still gets written bumps the asset's mtime, wakes the
file watcher, and triggers a Unity reimport. So `toEdit` returns `null` for a
no-op, and `unity_asset_apply_edits` returns `unchanged: true` without touching
the file when every edit resolves to the bytes already there.

---

## Traps

Each of these cost real debugging. They are not hypothetical.

**Attribute arguments come from `text`, never `code`.**
`collectLeadingAttributes` walks the *blanked* view, where string contents are
spaces — `[Tooltip("Damage per shot")]` reads back as `"              "`. Split
on `code` (so a comma inside a literal cannot break the arg list) and slice
values out of `text`. Blanking preserves length, so offsets agree by
construction.

**Never commit a CRLF fixture.** The repo root's `.gitattributes` is
`* text=auto eol=lf`, so a committed CRLF fixture is normalised in the index and
checked out as LF — the test then passes forever without ever seeing a `\r`.
CRLF and no-trailing-newline variants are **synthesized in the test**.

**The GUID index needs two triggers, not one.** `indexRevision` is bumped only
on the incremental delta path; a full rebuild leaves it untouched and moves
`status` instead. Watch both, or the view goes stale until restart.

**Tell the usage caches about your own writes.** Call `noteSelfWrittenAsset(path)`
*before* writing, or the watcher event your own save produces invalidates the
caches and blanks the panel you are looking at.

**A feature barrel is not import-safe in tests.** Importing one pulls React and
the theme store, which touch `document` at module load; the runner has no DOM.
Pure services take `import type` only, and their tests build fixtures as
literals. `so-inspector-gate` takes its `isRuntimeScript` classifier as a
parameter for exactly this reason.

**`check-invoke-args.mjs` cannot see inside `edits`.** It validates only
top-level invoke arguments, so a `fileId` → `file_id` drift passes CI silently.
Guarded instead by Rust tests that deserialise JSON literals copied verbatim
from `asset-fields-client.ts`.

**A rename is insert + delete in ONE write.** Two writes lose the value if the
process dies between them. The insertion point lands *inside* the removal span,
which the planner merges into a single replacement — and note that removing the
file's **last** line consumes the *preceding* newline rather than a trailing
one, so the merged text mirrors the removed span's own shape.

---

## Where the schema lives, and why not here

`so-schema.ts` is in **`unity-analyzers`**, not in this feature.

`unity-analyzers` already imports `unity-context`, so `unity-context` can never
import it back — a mutual barrel import is what broke app startup before
(`editor/CLAUDE.md`). The Inspector panel needs both the scanner and the usage
store, so **the panel moved up** rather than the scanner moving down: this
feature sits above both and depends on each.

```
csharp <- unity-context <- unity-analyzers <- ai-panel <- unity-asset-viewer
                 ^                ^                             ^
                 +----------------+---- unity-scriptable-objects (here)
                                              ^            ^
                                          app-shell      editor
```

Nothing may import this feature except `app-shell` and `editor`.

Moving the scanner instead would have meant refactoring a 606-line untested
module with 17 dependents. It is still the tidier end state — but as its own
test-first change, never bundled with a feature.

## The browser lists your types, not the packages'

A Unity project is full of `.asset` files owned by packages — input actions, TMP
settings, render-pipeline assets. Their `m_Script` points into
`Library/PackageCache`, which the GUID index does not walk, so the guid never
resolves. Those are excluded: they are not your data model and are not editable
as one.

`Assets/` and `Packages/` count as yours (the latter holds *embedded* packages,
which are project-local source). One consequence: an asset whose script was
genuinely deleted also disappears from the browser. That is the right trade here
— it still opens in the structured viewer, and the reference map reports
unresolvable guids as broken references explicitly.

## Deliberately not done

- **Per-field stat lenses** (`6.8 – 88.0 · median 12.8`). Needs every instance
  read, and `provideCodeLenses` re-runs on every model change —
  `usage-codelens.ts` documents that exact trap. Wants a Rust aggregate command,
  not a TypeScript fan-out that would then be replaced.
- **Project-wide validation** — orphan instances, duplicate `[CreateAssetMenu]`
  names. Same fan-out reason. Per-asset broken references *are* covered.
- **Editing arrays, `AnimationCurve`, `Gradient`, nested structs.**
  Insert/remove/reorder is where byte-exactness dies.
- **`[SerializeReference]`** — permanently read-only. Its type discriminator
  lives in a separate `references:` block at the file foot; writing the value
  without it corrupts the asset.
- **Multi-instance bulk edit** — one bad write becomes twelve.
- **Creating an instance** — needs `.meta` guid generation.
- **Migrating `lib.rs::write_file` onto `write_atomic`** — blast radius is every
  editor save; its own change.

## Verifying

```
cd editor && bun run verify
```

A `SKIPPED` IntelliSense or ACP result is **not** a pass.

Focused:

```
bun test src/features/unity-scriptable-objects src/features/unity-analyzers
cd src-tauri && cargo test --lib unity_asset_edit fs_atomic unity_yaml
```

End to end, against a real Unity project: open a `ScriptableObject` class →
Instances + Usages; edit a cell → `git diff` shows exactly one changed line;
open an instance → typed form, no side panel; rename a serialized field → the
Drift tab offers to move the value.
