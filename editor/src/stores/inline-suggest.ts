import { create } from 'zustand';

// Status surfaced by the status-bar item. Failures are SILENT (no toasts) —
// this store is the only user-visible signal for the inline-suggest pipeline.
export type InlineSuggestStatus =
    | 'active' | 'disabled' | 'signed-out' | 'offline' | 'quota' | 'backoff';

interface InlineSuggestState {
    status: InlineSuggestStatus;
    /** ISO time when the daily quota resets; non-null only while status='quota'. */
    quotaResetAt: string | null;
    setStatus: (status: InlineSuggestStatus, quotaResetAt?: string | null) => void;
    /** True while the quota pause is still in force. */
    quotaActive: (now?: number) => boolean;
}

export const useInlineSuggestStore = create<InlineSuggestState>((set, get) => ({
    status: 'active',
    quotaResetAt: null,
    setStatus: (status, quotaResetAt) =>
        set({ status, quotaResetAt: status === 'quota' ? (quotaResetAt ?? null) : null }),
    quotaActive: (now = Date.now()) => {
        const { status, quotaResetAt } = get();
        return status === 'quota' && quotaResetAt !== null && Date.parse(quotaResetAt) > now;
    },
}));
