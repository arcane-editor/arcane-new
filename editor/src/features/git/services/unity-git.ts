import { invoke } from '@tauri-apps/api/core';
import { useGitStore, type GitFileStatus } from '../../../stores/git';
import { useSettingsStore } from '../../../stores/settings';
import { notify, useNotificationsStore } from '../../../stores/notifications';

// ── Meta-pairing commit checks (F-9) ─────────────────────────────────────────

function pairPath(path: string): string {
  return path.toLowerCase().endsWith('.meta') ? path.slice(0, -'.meta'.length) : path + '.meta';
}

function underAssetsOrPackages(path: string): boolean {
  return /(^|\/)(Assets|Packages)\//.test(path);
}

export interface MetaPairingViolation {
  staged: string;
  missingPair: string;
}

/**
 * Find staged files whose paired asset/.meta also changed but was NOT staged —
 * the classic "committed Foo.cs without Foo.cs.meta" footgun that breaks
 * references. Only considers files under Assets/ or Packages/.
 */
export function findMetaPairingViolations(
  staged: GitFileStatus[],
  unstaged: GitFileStatus[],
): MetaPairingViolation[] {
  const unstagedPaths = new Set(unstaged.map((f) => f.path));
  const out: MetaPairingViolation[] = [];
  for (const f of staged) {
    if (!underAssetsOrPackages(f.path)) continue;
    const pair = pairPath(f.path);
    if (unstagedPaths.has(pair)) out.push({ staged: f.path, missingPair: pair });
  }
  return out;
}

/** Whether meta-pairing checks are active (Unity setting). */
export function metaPairingChecksEnabled(): boolean {
  return useSettingsStore.getState().getSetting('unity.git.metaPairingChecks') === true;
}

// ── .gitignore doctor (F-9) ──────────────────────────────────────────────────

interface IgnoreEntry {
  line: string;
  /** Loose token used to detect that the dir/pattern is already covered. */
  token: RegExp;
}

const UNITY_GITIGNORE: IgnoreEntry[] = [
  { line: '[Ll]ibrary/', token: /library\//i },
  { line: '[Tt]emp/', token: /temp\//i },
  { line: '[Oo]bj/', token: /(^|\/)obj\//i },
  { line: '[Ll]ogs/', token: /logs\//i },
  { line: '[Uu]serSettings/', token: /usersettings\//i },
  { line: '[Bb]uild/', token: /(^|\/)build\//i },
  { line: '[Bb]uilds/', token: /builds\//i },
  { line: '[Mm]emoryCaptures/', token: /memorycaptures\//i },
  { line: '.vs/', token: /\.vs\//i },
  { line: '*.csproj', token: /\*\.csproj/i },
  { line: '*.sln', token: /\*\.sln/i },
];

/** Canonical Unity ignore lines not already covered by the given content. */
export function missingGitignoreLines(content: string): string[] {
  return UNITY_GITIGNORE.filter((e) => !e.token.test(content)).map((e) => e.line);
}

const prompted = new Set<string>();

/**
 * On first open of a Unity git repo, validate .gitignore against the canonical
 * Unity rules and, if important entries (Library/Temp/etc.) are missing, offer a
 * one-click fix. One-shot per workspace per session; non-nagging.
 */
export async function runGitignoreDoctor(workspacePath: string): Promise<void> {
  if (prompted.has(workspacePath)) return;
  prompted.add(workspacePath);

  let content = '';
  try {
    content = await invoke<string>('read_file', { path: `${workspacePath}/.gitignore` });
  } catch {
    content = ''; // no .gitignore yet → everything missing
  }

  const missing = missingGitignoreLines(content);
  // Only prompt when a high-signal runtime dir is unignored (avoids nagging over
  // cosmetic entries).
  const critical = missing.some((l) => /library|temp|logs/i.test(l));
  if (!critical) return;

  useNotificationsStore.getState().addNotification({
    type: 'warning',
    message: `This Unity repo's .gitignore is missing ${missing.length} recommended entr${missing.length === 1 ? 'y' : 'ies'} (Library/, Temp/, …).`,
    persistent: true,
    actions: [
      {
        label: 'Fix .gitignore',
        run: () => {
          void useGitStore
            .getState()
            .appendGitignore(workspacePath, missing)
            .then((added) => {
              if (added.length > 0) {
                notify.success(`Added ${added.length} entries to .gitignore`);
              }
            });
        },
      },
    ],
  });
}
