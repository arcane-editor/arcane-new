/**
 * Per-server behavioural quirks, in one table.
 *
 * Language servers disagree about the parts of the protocol that are worded
 * loosely, and the disagreements are not bugs to route around at each call
 * site — they are facts about a specific server. Scattering
 * `languageId === 'csharp'` through the providers is how the last integration
 * in this codebase became too expensive to keep (see the `getChatBackend()`
 * rule in CLAUDE.md); this is the completion-side equivalent.
 *
 * Anything added here needs a citation to the server's source or its
 * documentation, so the next person can tell a deliberate accommodation from
 * a guess.
 */

export interface ServerProfile {
  /**
   * The server sets `isIncomplete: true` on lists that are, in fact, complete.
   *
   * csharp-ls hardcodes `IsIncomplete = true` on every completion response
   * (`Handlers/Completion.fs`) and applies no filtering, limit or prefix match
   * of its own — the probe sees the full member set in one answer (50 items for
   * `Camera.`, 84 for `transform.`). Honouring the flag would make Monaco
   * re-request on every keystroke, and each of those re-runs Roslyn's
   * completion service over the whole document and re-ships thousands of items
   * at an identifier position. Monaco filters a complete list locally instead,
   * which is both correct and free.
   *
   * Only set this for a server whose source has been read. A server that
   * genuinely truncates and is marked complete here silently loses items.
   */
  completionListsAreComplete: boolean;

  /**
   * Per-request timeouts, in ms. Interactive requests are worth abandoning
   * long before the client's global ceiling: a suggest widget that resolves
   * after five seconds is not a feature, and the request is superseded by the
   * next keystroke anyway.
   */
  timeouts: {
    completion: number;
    completionResolve: number;
    hover: number;
    signatureHelp: number;
    /**
     * A diagnostics pull. Not interactive, but bounded for a different
     * reason: pulls are serialised, so one that hangs stops every open
     * document's diagnostics until it gives up. At the client's global
     * ceiling that is three minutes of nothing.
     */
    diagnostics: number;
  };
}

const DEFAULT_PROFILE: ServerProfile = {
  completionListsAreComplete: false,
  timeouts: {
    completion: 5_000,
    completionResolve: 1_500,
    hover: 3_000,
    signatureHelp: 3_000,
    // Generous, because with the Unity analyzers on this runs every analyzer
    // over the whole compilation — but finite, because it holds the queue.
    diagnostics: 30_000,
  },
};

const PROFILES: Record<string, Partial<ServerProfile>> = {
  csharp: {
    completionListsAreComplete: true,
  },
};

/** The profile for a language-server key (`csharp`, `typescript`, …). */
export function serverProfile(languageId: string): ServerProfile {
  const overrides = PROFILES[languageId];
  if (!overrides) return DEFAULT_PROFILE;
  return {
    ...DEFAULT_PROFILE,
    ...overrides,
    timeouts: { ...DEFAULT_PROFILE.timeouts, ...(overrides.timeouts ?? {}) },
  };
}
