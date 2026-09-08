/**
 * Whether the Unity Roslyn analyzers are actually running.
 *
 * Three things must all be true, and each of them fails silently on its own:
 * the pinned csharp-ls must be new enough to run analyzers at all (0.24+), the
 * analyzer assembly must have unpacked and been named in the generated csproj
 * (`unity_analyzers.rs`, reported back by `unity_setup_lsp`), and the user must
 * not have turned them off.
 *
 * This is not a status display. The TypeScript rule engine
 * (`features/unity-analyzers`) stands down for the rules Roslyn covers better —
 * it has type information and a real parser, so its verdict is worth more than
 * a regex's — and standing down is only safe if Roslyn is definitely covering
 * them. On a machine where the analyzer package failed to unpack, deferring
 * blindly would lose those inspections from BOTH engines at once, with nothing
 * reported anywhere. So the fallback engine asks this first.
 *
 * Module-level state rather than a store: it is read from rule code that must
 * stay importable without Zustand or Tauri, and it changes once per workspace
 * load.
 */

let injected = false;

/**
 * Record what `unity_setup_lsp` reported: whether the generated csproj names
 * the analyzer assembly. Reset to false whenever that becomes unknown —
 * a different workspace, a failed setup, a dead server.
 */
export function setRoslynAnalyzersInjected(value: boolean): void {
  injected = value;
}

/**
 * True when the generated project references the Unity analyzer assembly.
 *
 * This is ONE of the conditions for the analyzers actually reporting, not all
 * of them — the user can switch them off and the server can die, neither of
 * which touches the csproj. Callers deciding whether a local rule may stand
 * down must use `roslynAnalyzersReporting()` instead.
 *
 * Deliberately conservative: it starts false and only becomes true on a
 * positive report, so the fallback rules run until the Roslyn ones are known
 * to be live rather than the other way round.
 */
export function roslynAnalyzersInjected(): boolean {
  return injected;
}

/**
 * Is Roslyn actually reporting UNT diagnostics right now?
 *
 * Three independent things have to hold, and each of them can stop holding
 * without the others noticing:
 *
 *   1. the csproj names the analyzer (`injected`);
 *   2. the user has not switched the analyzers off — the setting is pushed to
 *      the server as `analyzersEnabled`, and with it false csharp-ls runs no
 *      analyzer pipeline at all;
 *   3. the C# server is running — it can exhaust its restart budget.
 *
 * Only (1) used to be checked, and the consequence was specific and silent:
 * unticking "Roslyn Analyzers (Unity)" made every UNT marker disappear while
 * the local rules those markers had superseded stayed switched off. Three
 * inspections vanished from both engines at once, with nothing reported
 * anywhere.
 *
 * The dependency is injected because this module is imported by rule code that
 * must stay loadable without Zustand or Tauri.
 */
export function roslynAnalyzersReporting(deps: {
  analyzersEnabled: boolean;
  serverRunning: boolean;
}): boolean {
  return injected && deps.analyzersEnabled && deps.serverRunning;
}
