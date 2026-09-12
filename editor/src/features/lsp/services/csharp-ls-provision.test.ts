import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { CsharpLsStatus } from './csharp-ls-provision';

// What these protect: provisioning sits directly in the C# start path, so a
// mistake here does not produce a bad message — it produces an editor that
// hangs on project open, installs the server repeatedly, or reports success
// for a machine that cannot run it. Every test below is one of those.

let invokeCalls: string[] = [];
let statusImpl: () => Promise<unknown> = async () => ready;
let installImpl: () => Promise<unknown> = async () => '/managed/csharp-ls';

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    invokeCalls.push(cmd);
    if (cmd === 'csharp_ls_status') return statusImpl();
    if (cmd === 'csharp_ls_install') return installImpl();
    return undefined;
  },
}));

const {
  ensureCsharpLs,
  resetCsharpLsProvisioning,
  describeProvisionFailure,
  describeDotnetBlock,
} = await import('./csharp-ls-provision');

function status(overrides: Partial<CsharpLsStatus> = {}): CsharpLsStatus {
  return {
    found: false,
    source: null,
    path: null,
    dotnet: { present: true, has_sdk: true, runtime_major: 10 },
    can_install: true,
    required_runtime_major: 10,
    ...overrides,
  };
}

const ready: CsharpLsStatus = status({ found: true, source: 'user', path: '/usr/bin/csharp-ls' });

beforeEach(() => {
  invokeCalls = [];
  statusImpl = async () => status();
  installImpl = async () => '/managed/csharp-ls';
  resetCsharpLsProvisioning();
});

describe('describeDotnetBlock', () => {
  it('passes a machine that has everything', () => {
    expect(describeDotnetBlock(status())).toBeNull();
  });

  it('reports a missing .NET', () => {
    const block = describeDotnetBlock(
      status({ dotnet: { present: false, has_sdk: false, runtime_major: null } }),
    );
    expect(block?.reason).toBe('missing');
  });

  it('separates a runtime-only install from a missing one', () => {
    const block = describeDotnetBlock(
      status({ dotnet: { present: true, has_sdk: false, runtime_major: 10 } }),
    );
    expect(block?.reason).toBe('sdk-missing');
    expect(block?.detail).toContain('SDK');
  });

  // The failure this whole check exists for: `dotnet` is present, so a naive
  // "is dotnet installed?" probe passes, the tool installs successfully, and
  // then it cannot launch because it targets a newer runtime.
  it('catches a .NET that is present but too old, and names both versions', () => {
    const block = describeDotnetBlock(
      status({ dotnet: { present: true, has_sdk: true, runtime_major: 8 } }),
    );
    expect(block?.reason).toBe('runtime-too-old');
    expect(block?.detail).toContain('.NET 10');
    expect(block?.detail).toContain('.NET 8');
  });

  it('treats an unreadable runtime list as too old rather than as fine', () => {
    const block = describeDotnetBlock(
      status({ dotnet: { present: true, has_sdk: true, runtime_major: null } }),
    );
    expect(block?.reason).toBe('runtime-too-old');
  });

  // The required version is reported by the backend so bumping the pin cannot
  // leave the UI telling users to install the wrong .NET.
  it('uses the required version the backend reported', () => {
    const block = describeDotnetBlock(
      status({
        dotnet: { present: true, has_sdk: true, runtime_major: 10 },
        required_runtime_major: 12,
      }),
    );
    expect(block?.detail).toContain('.NET 12');
  });
});

describe('describeProvisionFailure', () => {
  // Suggesting the manual command to someone whose machine cannot run the
  // tool sends them to do work that will fail the same way.
  it('leaves prerequisite messages alone', () => {
    const message = describeProvisionFailure({
      code: 'runtime-too-old',
      message: 'Needs .NET 10.',
    });
    expect(message).toBe('Needs .NET 10.');
    expect(message).not.toContain('dotnet tool install');
  });

  it('offers the manual command for failures the user could work around', () => {
    const message = describeProvisionFailure({ code: 'timeout', message: 'Timed out.' });
    expect(message).toContain('Timed out.');
    expect(message).toContain('dotnet tool install -g csharp-ls');
  });

  it('survives an error that is not the expected shape', () => {
    expect(describeProvisionFailure(new Error('boom'))).toContain('boom');
    expect(describeProvisionFailure('plain string')).toContain('plain string');
    expect(describeProvisionFailure(null)).toContain('null');
  });
});

describe('ensureCsharpLs', () => {
  it('installs nothing when the user already has a server', async () => {
    statusImpl = async () => ready;
    expect(await ensureCsharpLs()).toEqual({ ok: true });
    expect(invokeCalls).toEqual(['csharp_ls_status']);
  });

  it('installs when nothing was found', async () => {
    expect(await ensureCsharpLs()).toEqual({ ok: true });
    expect(invokeCalls).toEqual(['csharp_ls_status', 'csharp_ls_install']);
  });

  // Two `.cs` files opened at once, or an eager Unity start racing a lazy file
  // open, must not run two `dotnet tool install` processes into one directory.
  it('runs one install for concurrent callers', async () => {
    const [a, b, c] = await Promise.all([ensureCsharpLs(), ensureCsharpLs(), ensureCsharpLs()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(c).toEqual({ ok: true });
    expect(invokeCalls.filter((c) => c === 'csharp_ls_install')).toHaveLength(1);
  });

  it('maps a failed install to an actionable message', async () => {
    installImpl = async () => {
      throw { code: 'runtime-too-old', message: 'Needs .NET 10.' };
    };
    expect(await ensureCsharpLs()).toEqual({ ok: false, message: 'Needs .NET 10.' });
  });

  // The retry storm this prevents: without the cached outcome, every `.cs`
  // file opened after a failure would start another install.
  it('does not retry after a failure within the same session', async () => {
    installImpl = async () => {
      throw { code: 'timeout', message: 'Timed out.' };
    };
    const first = await ensureCsharpLs();
    const second = await ensureCsharpLs();
    expect(first.ok).toBe(false);
    expect(second).toEqual(first);
    expect(invokeCalls.filter((c) => c === 'csharp_ls_install')).toHaveLength(1);
  });

  // A user who installs .NET and reopens the project should not have to
  // restart the app, which is why the workspace switch resets this.
  it('tries again after a reset', async () => {
    installImpl = async () => {
      throw { code: 'timeout', message: 'Timed out.' };
    };
    expect((await ensureCsharpLs()).ok).toBe(false);

    resetCsharpLsProvisioning();
    installImpl = async () => '/managed/csharp-ls';
    expect(await ensureCsharpLs()).toEqual({ ok: true });
    expect(invokeCalls.filter((c) => c === 'csharp_ls_install')).toHaveLength(2);
  });

  // Provisioning is an enhancement to the start path, not a gate on it: if the
  // probe itself breaks, the start proceeds and fails the way it always did.
  it('does not block the start when the probe fails', async () => {
    statusImpl = async () => {
      throw new Error('command not found');
    };
    expect(await ensureCsharpLs()).toEqual({ ok: true });
    expect(invokeCalls).toEqual(['csharp_ls_status']);
  });

  it('reports progress and always clears it', async () => {
    const messages: (string | null)[] = [];
    await ensureCsharpLs({ onProgress: (m) => messages.push(m) });
    expect(messages[0]).toContain('C# language server');
    expect(messages[messages.length - 1]).toBeNull();
  });

  it('clears progress even when the install fails', async () => {
    installImpl = async () => {
      throw { code: 'install-failed', message: 'nope' };
    };
    const messages: (string | null)[] = [];
    await ensureCsharpLs({ onProgress: (m) => messages.push(m) });
    expect(messages[messages.length - 1]).toBeNull();
  });

  it('shows no progress when a server already exists', async () => {
    statusImpl = async () => ready;
    const messages: (string | null)[] = [];
    await ensureCsharpLs({ onProgress: (m) => messages.push(m) });
    expect(messages).toEqual([]);
  });
});
