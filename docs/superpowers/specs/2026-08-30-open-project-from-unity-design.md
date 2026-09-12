# Opening a Unity project (and a script) directly in UnityIDE

Date: 2026-08-30
Status: implemented

## Problem

A user with `com.unityide.editor` installed still had to open their project in
UnityIDE by hand — launch the app, pick the folder. Double-clicking a `.cs` file
in Unity's Project window was supposed to work and did not, reliably.

The plumbing was about two-thirds built and broken at the seams:

| Piece | State before |
|---|---|
| `UnityIDEEditor : IExternalCodeEditor` | Registered, launched `UnityIDE --goto "<file>:<line>:<col>" "<project>"` |
| `cli.rs` → `PendingGoto` → `App.tsx` / `WelcomeApp.tsx` | Parsed `--goto`, routed it, opened the file at the line |
| Project-only launch | **Broken.** `UnityIDE "<project>"` parsed to nothing — and that is exactly what Unity's `Assets ▸ Open C# Project` produces (`OpenProject("")`). |
| Focus | **Missing.** Nothing raised the window, and the single-instance handler unconditionally raised the 720×480 *welcome* window — in front of the project window that was opening the file. |
| Warm path | **Half-wired.** `open_file` was a declared bridge message, routed by `unity_ipc.rs` and consumed by `stores/unity.ts`, but C# never sent it and it carried no position. `"focus_window"` was a dead stub. |
| Install discovery | Windows probed `%LOCALAPPDATA%\Programs\UnityIDE\` — Electron's convention. Tauri's NSIS installs to `%LOCALAPPDATA%\<productName>`. |
| Unity-side UI | None. Zero `[MenuItem]` in the package. |

## Decisions

- **Menu items, not a new `EditorWindow`.** Status and diagnostics go into
  `IExternalCodeEditor.OnGUI()`, which Unity already renders in
  *Preferences ▸ External Tools*.
- **The script-editor claim is opt-in, asked once.** Silently hijacking the
  setting is faster to write and worse to live with — it is per-machine, so it
  would be re-hijacked on every machine that opens the project.
- **The warm path goes over the existing bridge**, not a process relaunch.
- **The cold-start welcome flash is fixed**, not accepted.

## Design

### One decision point in C#

`UnityIDELauncher.Open(filePath, line, column)`. Every entry point funnels
through it — the menu item, `Assets ▸ Open C# Project`, and
`IExternalCodeEditor.OpenProject` — and they differ only in whether they name a
file.

```
1. IDE already up on THIS project (BridgeBootstrap.IsConnected)?
     → send open_file (+ line/col) and focus_window over the journal.
       No process spawn, no dock bounce, no dependence on the install path.
2. unityide://open?project=…&file=…&line=…&column=…
     → hand the URL to the OS, which already knows where the app is and how to
       bring it forward.
3. Resolve an install path and launch with --goto / --project.
     → the app's single-instance lock relays argv to a running instance over a
       unix socket (macOS) or named pipe (Windows), or cold-starts one.
```

"Connected" is the client's live handshake state, deliberately **not** "does
`Library/UnityIDE/bridge.json` exist" — a crashed IDE leaves that file behind,
and trusting it would write into a journal nobody reads.

### The deep link is the primary route

Step 2 exists because step 3 requires somebody to know where the app is
installed, and the OS already does. It also gets LaunchServices activation on
macOS for free, instead of `open -n` spawning a second instance whose only job
is to relay argv and exit.

It does **not** replace step 3, because three cases the OS cannot serve are all
real:

| | macOS | Windows |
|---|---|---|
| Registered by | the `.app` bundle's Info.plist, at install — no launch needed | `register_all()` at **runtime** — only after the app has run once |
| `tauri dev` | never registered (LaunchServices has no runtime API) | registered fine |
| Cold delivery | `RunEvent::Opened`, *after* `setup()` | argv as the single argument, parsed *before* `setup()` |
| Warm delivery | `RunEvent::Opened` | single-instance forwards argv → `handle_cli_arguments` |

So the Unity side only fires a deep link when it has evidence of a handler:

- **macOS** — always (bar a dev launcher), since the bundle registers at install.
- **Windows/Linux** — only when `~/.unityide/install.json` exists, which proves
  the app has run and therefore that `register_all()` has. Firing at an
  unregistered scheme on Windows does not fail quietly; it raises a "you'll need
  a new app to open this" dialog.
- **Never** when `.unityide-dev-path` names a dev launcher: that is a request to
  run *that* binary, and a URL would start whichever build owns the scheme.

Failure is detected, not assumed: `open`/`xdg-open` exit non-zero when nothing
handles the scheme, and Windows' ShellExecute throws. Either falls through to
step 3.

**App side.** `cli::parse_deep_link` turns the URL into the same `OpenRequest`
the argv path produces, so everything downstream is unchanged. One
`deep_link().on_open_url` handler covers every warm case on every platform — the
plugin emits `deep-link://new-url` from both macOS's `RunEvent::Opened` and the
argv handed to it by the single-instance plugin. Cold Windows/Linux needs a
`get_current()` read in `setup()`, because the plugin parses argv during *its*
setup, before that handler exists. `dispatch_open_request` is shared by all three
entry points.

Auth callbacks (`unityide://auth/callback?…`) are untouched: `parse_deep_link`
discriminates on the URL host, so an `open` link never reaches the auth handler
and an `auth` link never reaches this one.

**A note on exposure.** A deep link is remotely triggerable — any web page can
fire `unityide://open?project=…`. The worst it can do is open a directory of the
attacker's choosing as a workspace; it executes nothing, and
`openProjectInNewWindow` already refuses a path that is not an existing
directory. This is the same bargain `vscode://file/…` and Rider's handler make,
and the app already registers the scheme for auth, which is the more valuable
target. Worth knowing about; not worth a confirmation prompt that would defeat
the feature.

### One package per release channel

The two channels are separate applications end to end — product name
(`UnityIDE` / `UnityIDE Dev`), deep-link scheme, config home, updater feed — so
the package is generated twice rather than deciding at runtime which one the
user meant. Runtime resolution was tried first and got it wrong in the only case
that mattered: it always resolved to release, so anyone testing a dev build had
their double-clicks answered by the release app, silently.

`Editor/UnityIDEChannel.cs` holds the constants; everything else reads them. The
checked-in source IS the release package, and
`scripts/unity-extension-channel.mjs` rewrites a **copy** into the dev one. Four
things change, and all four have to:

1. the channel constants,
2. the UPM id — so Unity sees two packages, not two versions of one,
3. the assembly names — Unity refuses two assemblies with the same name, and
   `InternalsVisibleTo` names the test assembly literally, so it moves too,
4. every asset GUID. This is the one that looks optional: two packages
   declaring the same GUIDs is a conflict Unity resolves by picking a winner
   arbitrarily. GUIDs are derived (`md5(original + ":" + channel)`), never
   random — a build must reproduce the last build's GUIDs or every upgrade
   breaks the asmdef references pointing at them.

Consumers follow: `sync-unity-bridge.mjs --channel dev` (wired into
`tauri.dev.conf.json`'s `beforeBuildCommand`) makes the dev app bundle the dev
package; `unity_install_bridge` installs under the bundled package's **own** id
and evicts the other channel's, because two embedded packages each registering
an `IExternalCodeEditor` would leave Unity deciding which application a
double-click opens; `deploy.sh dev` and a `unity-extension-dev` job in
`dev-build.yml` publish it.

Keeping the values in step with `tauri.dev.conf.json` and `auth::config_dir_name`
is a hand-maintained invariant. `CHANNELS` in the transform script is the single
place they are written down.

### Nothing installed is a dead end, so say so

The package being installed without the application is indistinguishable, from
inside Unity, from the integration being broken: double-click a script, nothing
happens. It used to write a console error and stop. It now also opens the
download page — once per session (`SessionState`), because re-opening it on
every double-click stacks tabs on someone already looking at it.

### The app states its own location

`unity::write_install_record` writes `~/.unityide/install.json` on every launch:
`launchPath` (the `.app` bundle on macOS, the executable elsewhere), `exePath`,
version, identifier. `~/.unityide` is already the per-user config home
(`auth::config_home_dir`), keyed off the bundle identifier so the dev build lands
in `~/.unityide-dev`.

C# derives the same path from `$HOME` — no registry read (Unity's .NET Standard
profile has no `Microsoft.Win32`) and no `SpecialFolder` mapping, which differs
between Mono and .NET on macOS. Skipped under `debug_assertions` so `tauri dev`
cannot point every project on a developer's machine at `target/debug/editor`.

Resolution order: `.unityide-dev-path` → Unity's selected installation →
`EditorPrefs` override → install records → static probes.

### Launching, per platform

- **macOS:** `open -n -a "<bundle>.app" --args …`. Cold, LaunchServices launches
  it properly — correct Gatekeeper handling, no inheritance of Unity's
  environment, not in Unity's process group. Warm, the throwaway instance relays
  argv and `exit(0)`s. One branch for both.
- **Windows:** `Process.Start(exe, args)`, preceded by
  `user32!AllowSetForegroundWindow`. Without it, Windows downgrades the
  background IDE's `SetForegroundWindow` to a taskbar flash — the "it opened but
  I can't see it" failure. Unity owns the foreground at that moment, which is
  what the API is for.
- **Quoting:** trailing `\` and `/` are trimmed before quoting. A Windows path
  ending in a separator escapes its own closing quote (`"C:\Proj\"`) and
  swallows every argument after it.

### CLI accepts a project, not just a goto

`cli.rs`: `GotoTarget` → `OpenRequest` with `file: Option<String>`. Accepts
`--project <path>`, a bare positional (a file if it is one, a project
otherwise), and `--goto` unchanged — an already-installed extension keeps
launching us the old way until the user updates it.

`same_path` now falls back to `canonicalize` on both sides. The window's path
went through `canonicalize_path`; Unity's `Path.GetFullPath` does not resolve
symlinks, which on macOS is `/var` vs `/private/var`. Without it the request sat
unclaimed and the welcome window opened a *second* window for the same project.

### Focus: a window↔workspace registry

`window_registry.rs` holds `label → canonical workspace`, populated by each
project window after `setWorkspace` resolves. Rust cannot derive it: the label is
`hashLabel(path)` in TypeScript, and the Rust `hash_workspace` was deliberately
retired so the two could not drift.

The single-instance handler becomes:

```
parse argv → set_pending
  ├─ a registered window owns this project → emit_to(it) + raise it, done
  └─ otherwise → ensure the welcome window exists (hidden when a project was
                 named — it is only routing) + emit to everyone
```

Raising is unminimize → show → `set_focus`, in that order: tao's macOS
`set_focus` returns early on a miniaturized or hidden window, so focusing alone
did nothing to a minimized one. `open_or_focus_welcome` had this bug.

### Cold start

The welcome window is declared `"visible": false`. Two independent paths show it,
so a failure in either still leaves the user with a window: Rust shows it in
`setup()` when argv carried no project; `WelcomeApp` shows itself when it was
handed one and could not route it.

A hidden welcome window closes itself once it has routed. Lingering hidden would
be worse than the flash it avoids: an invisible window still counts as a window,
so on Windows and Linux it would hold the process open after the user closes the
project window, with nothing on screen and no way back. (Doing this from the
`Destroyed` handler instead — show the welcome window when nothing visible
remains — looks equivalent and is not: it also fires while the app is quitting,
and resurrects a window that blocks the exit.)

The window-state plugin had to be told to stop restoring visibility
(`StateFlags::all() - VISIBLE`). Its VISIBLE flag `show()`s and `set_focus()`es a
window on creation whenever the last session left it visible — which for the
welcome window is always — and it runs during `build()`, before `setup()` gets a
say.

## Incidental fixes

Three latent bugs surfaced while building this and are fixed here:

- **`[assembly: InternalsVisibleTo("UnityIDE.Editor.Tests")]` was missing.** The
  Unity test assembly could not compile — `Discovery`, `Journal`, `BridgeClient`
  and `StopReason` are all internal. `using System.Runtime.CompilerServices` sat
  unused at the top of `AssemblyInfo.cs`, which is where the attribute belonged.
  Nothing caught it: CI does not compile the C# package, and `Tests/` is stripped
  from the shipped UPM package.
- **`LegacyAppName` was `"UnityIDE"`.** The rebrand's bulk rename reached the
  constant that named the *pre*-rename app, so every "legacy" probe was a
  duplicate of the current one and a pre-rename install was never found. It is
  `"Arcane"` again, matching the Linux entries that were spelled out literally
  and so survived.
- **`open_or_focus_welcome` never unminimized.**

## Verification

`cd editor && bun run verify`.

The two sides' URL encoders are pinned to each other by
`decodes_what_the_unity_package_actually_encodes` (`cli.rs`), whose inputs are
the literal output of `UnityIDELauncher.BuildDeepLink` — captured by running that
.NET code, not by reasoning about it. A disagreement over a space, an `&`, a
backslash or a non-ASCII byte would open the wrong path and nothing else in
either suite would notice.

The C# package has no CI compile step, so it was compiled directly against
Unity 6000.3.5f2's assemblies (`Contents/Resources/Scripting/Managed/UnityEngine/*.dll`
plus `NetStandard/ref/2.1.0/netstandard.dll`, and the `netfx/mscorlib.dll` shim
for the NUnit assembly). Both `UnityIDE.Editor` and `UnityIDE.Editor.Tests`
build clean. **This is worth wiring into CI** — it needs only a Unity install,
not a license, and it is the only thing standing between a typo in this package
and a user's console.

Still owner-gated, because every remaining failure mode is environmental:

| | IDE closed | IDE open, this project | IDE open, other project |
|---|---|---|---|
| `Window ▸ UnityIDE ▸ Open Project` | cold start, no welcome flash | raises, no new process | new window + raise |
| Double-click a `.cs` file | opens at the right line | tab opens focused, no flash | new window at the line |

on **macOS and Windows**, plus `Assets ▸ Open C# Project`, the first-run prompt
appearing once and honouring "Never ask again", and *Preferences ▸ External
Tools* reporting install path and bridge state when UnityIDE is **not** the
selected editor.

Each cell should be run twice — once with the deep link live, once with it
unavailable — since the two routes are independent. The cheapest way to force
the fallback is to delete `~/.unityide/install.json` on Windows, or to point
`.unityide-dev-path` at a launcher on macOS. Worth confirming specifically:
**a Windows install that has never been launched must not raise the "you'll need
a new app to open this" dialog** — that is the case the `install.json` gate
exists to prevent.
