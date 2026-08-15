// ─── Task-aware model routing (spec §2) ────
//
// The effort tier is a CEILING and billing gate, not a model pin. This layer
// picks the concrete model per send:
//
//   - side-task lane: harness-internal calls (memory distillation) always run
//     on the cheap inline model, flag or no flag;
//   - simple-ask downgrade (flag-gated ROUTING_V2="on"): a short, attachment-
//     free, non-code ask-mode question runs on the low-tier model even when
//     the user's effort selector sits higher — same answer, fraction of the
//     price;
//   - everything else: the tier's static model (identical to the old
//     resolveModelForTier behavior).
//
// Routing only ever moves DOWN from the requested tier, so the tier
// entitlement gate (isTierAllowed, checked by the route before routing) stays
// authoritative. Billing always uses the model actually served (usage.ts is
// keyed by model id), so a downgraded send bills at the cheaper rate.
//
// Cache interaction: model choice must be sticky per conversation — provider
// prompt caches are per-model. All routing signals are stable for the life of
// a conversation's sends EXCEPT promptChars/codeIntent, which describe the
// FIRST user prompt semantics; the editor sends signals derived from the
// conversation's first user message so repeat sends route identically.

import { getIntensityConfig, DEFAULT_INTENSITY, INLINE_MODEL, type Intensity } from './plans.ts';

export interface RoutingSignals {
    taskType?: string;
    mode?: string;
    /** Chars of the conversation's FIRST user message (stable across sends). */
    promptChars?: number;
    codeIntent?: boolean;
    hasAttachments?: boolean;
}

export interface RoutingDecision {
    model: string;
    /** The tier whose model was actually served (for logs; billing keys off `model`). */
    routedTier: Intensity;
    reason: 'static' | 'side-task' | 'simple-ask-downgrade' | 'routing-off';
}

/** Short, attachment-free, non-code ask prompts are downgrade candidates. */
const SIMPLE_ASK_MAX_CHARS = 600;

function tierOf(level: string | undefined): Intensity {
    const cfg = getIntensityConfig(level ?? DEFAULT_INTENSITY);
    if (!cfg) return DEFAULT_INTENSITY;
    return (level === 'super' ? 'high' : (level as Intensity)) ?? DEFAULT_INTENSITY;
}

export function resolveModelForSend(
    requestedTier: string,
    signals: RoutingSignals,
    routingFlag: string | undefined,
): RoutingDecision {
    const tier = tierOf(requestedTier);
    const tierModel = getIntensityConfig(tier)!.model;

    // Side-task lane is NOT flag-gated: 'memory' is only ever sent by the
    // harness's own distiller (memory-request.ts), which must never burn
    // tier-model rates regardless of rollout state.
    if (signals.taskType === 'memory') {
        return { model: INLINE_MODEL, routedTier: 'low', reason: 'side-task' };
    }

    if (routingFlag !== 'on') {
        return { model: tierModel, routedTier: tier, reason: 'routing-off' };
    }

    if (
        tier !== 'low' &&
        signals.mode === 'ask' &&
        (signals.promptChars ?? Number.POSITIVE_INFINITY) < SIMPLE_ASK_MAX_CHARS &&
        !signals.hasAttachments &&
        !signals.codeIntent
    ) {
        return { model: getIntensityConfig('low')!.model, routedTier: 'low', reason: 'simple-ask-downgrade' };
    }

    return { model: tierModel, routedTier: tier, reason: 'static' };
}
