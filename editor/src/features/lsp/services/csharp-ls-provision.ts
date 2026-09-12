import { invoke } from '@tauri-apps/api/core';

/**
 * Provisioning the C# language server on the user's behalf.
 *
 * **The problem this removes.** C# features used to require the user to run
 * `dotnet tool install -g csharp-ls` themselves — a step nobody discovers.
 * The Rust side (`csharp_ls.rs`) can now install a pinned copy from a package
 * bundled in the app; this module decides *when* to ask it to, and turns its
 * failures into sentences a user can act on.
 *
 * **The rule that keeps a broken install from breaking the editor.** Every
 * path here degrades to "no C# language features", never to a blocked or
 * failed workspace. Monaco, the file tree, the terminal and the AI panel have
 * no dependency on the LSP, and nothing in this module may change that.
 */

/** Where a located csharp-ls came from. Mirrors `csharp_ls::Source`. */
export type CsharpLsSource = 'override' | 'user' | 'path' | 'managed';

export interface CsharpLsDotnet {
  present: boolean;
  has_sdk: boolean;
  runtime_major: number | null;
}

/** Payload of the `csharp_ls_status` command. */
export interface CsharpLsStatus {
  found: boolean;
  source: CsharpLsSource | null;
  path: string | null;
  dotnet: CsharpLsDotnet;
  can_install: boolean;
  required_runtime_major: number;
}

/** Error shape rejected by `csharp_ls_install`. Mirrors `InstallError`. */
export interface CsharpLsInstallError {
  code: string;
  message: string;
}

export type EnsureResult = { ok: true } | { ok: false; message: string };

/**
 * Prerequisite failures. For these the message is already complete and
 * self-contained — telling someone to run the install command by hand when
 * the machine cannot run the tool at all would just waste their time.
 */
const PREREQUISITE_CODES = new Set(['dotnet-missing', 'sdk-missing', 'runtime-too-old']);

const MANUAL_FALLBACK = 'You can also install it yourself: dotnet tool install -g csharp-ls';

function asInstallError(err: unknown): CsharpLsInstallError | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as Partial<CsharpLsInstallError>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
  return { code: candidate.code, message: candidate.message };
}

/**
 * Turn a rejected install into the sentence the user sees.
 *
 * The distinction that matters: a missing .NET 10 runtime and a failed
 * download are different problems with different fixes, and collapsing them
 * into "install failed" is how someone ends up stuck with no idea what to do.
 */
export function describeProvisionFailure(err: unknown): string {
  const failure = asInstallError(err);
  if (!failure) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Could not install the C# language server: ${detail}. ${MANUAL_FALLBACK}`;
  }
  if (PREREQUISITE_CODES.has(failure.code)) return failure.message;
  return `${failure.message} ${MANUAL_FALLBACK}`;
}

/** Why the ".NET required" modal is up. */
export type DotnetBlockReason = 'missing' | 'sdk-missing' | 'runtime-too-old';

export interface DotnetBlock {
  reason: DotnetBlockReason;
  detail: string;
}

/**
 * Decide whether .NET itself blocks C# support, before any install is tried.
 *
 * Returns `null` when the machine is fine. The `runtime-too-old` case is the
 * one worth having: `dotnet` is present, so a naive "is dotnet installed?"
 * check passes, the install then succeeds, and the server dies on launch.
 */
export function describeDotnetBlock(status: CsharpLsStatus): DotnetBlock | null {
  const { dotnet, required_runtime_major: required } = status;
  if (!dotnet.present) {
    return {
      reason: 'missing',
      detail: `C# IntelliSense, diagnostics and navigation need the .NET ${required} SDK.`,
    };
  }
  if (!dotnet.has_sdk) {
    return {
      reason: 'sdk-missing',
      detail:
        'Only the .NET runtime is installed. The C# language server needs the SDK to load your project.',
    };
  }
  if (dotnet.runtime_major === null || dotnet.runtime_major < required) {
    const found =
      dotnet.runtime_major === null
        ? 'no .NET runtime was found'
        : `the newest installed is .NET ${dotnet.runtime_major}`;
    return {
      reason: 'runtime-too-old',
      detail: `The C# language server needs the .NET ${required} runtime, but ${found}.`,
    };
  }
  return null;
}

/**
 * Cached outcome of this session's provisioning attempt.
 *
 * Held as a resolved promise on *failure* too. One attempt per workspace
 * session is deliberate: without it, every `.cs` file opened after a failed
 * install would kick off another one — the same retry storm
 * `lspFailedLanguages` exists to prevent for server spawns.
 */
let pending: Promise<EnsureResult> | null = null;

/**
 * Allow one fresh attempt. Called when the workspace changes, alongside
 * `lspFailedLanguages.clear()`, so someone who installs .NET and reopens
 * their project is not told to restart the app.
 */
export function resetCsharpLsProvisioning(): void {
  pending = null;
}

export interface EnsureOptions {
  /** Surfaced in the status bar; called with `null` when the work is done. */
  onProgress?: (message: string | null) => void;
}

async function provision(options: EnsureOptions): Promise<EnsureResult> {
  let status: CsharpLsStatus;
  try {
    status = await invoke<CsharpLsStatus>('csharp_ls_status');
  } catch (err) {
    // The probe itself failing must not block a start that might still work.
    // Fall through to the normal spawn, which produces the same "not
    // installed" toast this editor has always shown.
    console.warn('[csharp-ls] status probe failed, continuing without provisioning:', err);
    return { ok: true };
  }

  if (status.found) return { ok: true };

  options.onProgress?.('Setting up the C# language server (one-time)…');
  try {
    await invoke<string>('csharp_ls_install');
    return { ok: true };
  } catch (err) {
    console.warn('[csharp-ls] provisioning failed:', err);
    return { ok: false, message: describeProvisionFailure(err) };
  } finally {
    options.onProgress?.(null);
  }
}

/**
 * Make sure a csharp-ls exists, installing one if not.
 *
 * Concurrent callers share a single attempt: two `.cs` files opened at once,
 * or an eager Unity start racing a lazy file open, must not run two installs
 * into the same directory.
 */
export function ensureCsharpLs(options: EnsureOptions = {}): Promise<EnsureResult> {
  if (!pending) pending = provision(options);
  return pending;
}
