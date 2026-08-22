import { create } from 'zustand';

// Status surfaced by the status-bar item. Failures are SILENT (no toasts) —
// this store is the only user-visible signal for the inline-suggest pipeline.
// 'quota' = the 429 daily request-count cap; 'budget-exhausted' = the 402
// monthly spend ceiling — two independent server-side pause conditions with
// the same resetAt-tracking/gating shape but different (daily vs monthly)
// status-bar copy. 'upgrade-required' = the account's plan doesn't include
// inline completions at all (client-side `planAllows` gate, or the server's
// 403 `inline_not_available` backstop) — distinct from 'signed-out' (no
// session) and from the quota/budget pauses (a paid plan temporarily spent
// out), since only this one is fixed by upgrading, not by waiting or logging
// in.
export type InlineSuggestStatus =
    | 'active' | 'disabled' | 'signed-out' | 'offline' | 'quota' | 'budget-exhausted' | 'backoff' | 'upgrade-required';

const RESET_TRACKED_STATUSES: readonly InlineSuggestStatus[] = ['quota', 'budget-exhausted'];

interface InlineSuggestState {
    status: InlineSuggestStatus;
    /** ISO time the daily quota or monthly budget resets; non-null only while status is 'quota' or 'budget-exhausted'. */
    quotaResetAt: string | null;
    setStatus: (status: InlineSuggestStatus, quotaResetAt?: string | null) => void;
    /** True while a quota or monthly-budget pause is still in force. */
    quotaActive: (now?: number) => boolean;
}

export const useInlineSuggestStore = create<InlineSuggestState>((set, get) => ({
    status: 'active',
    quotaResetAt: null,
    setStatus: (status, quotaResetAt) =>
        set({ status, quotaResetAt: RESET_TRACKED_STATUSES.includes(status) ? (quotaResetAt ?? null) : null }),
    quotaActive: (now = Date.now()) => {
        const { status, quotaResetAt } = get();
        return RESET_TRACKED_STATUSES.includes(status) && quotaResetAt !== null && Date.parse(quotaResetAt) > now;
    },
}));
