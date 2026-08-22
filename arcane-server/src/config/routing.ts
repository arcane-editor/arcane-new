// ─── Task-aware model routing ────
//
// The effort tier is a CEILING and billing gate, not a model pin: the tier
// entitlement gate (isTierAllowed, checked by the route BEFORE this module
// runs) stays authoritative for what a user may REQUEST. This layer picks
// the concrete model per send from the runtime routing doc (app_config's
// `model_routing`, see lib/app-config.ts) for that already-gated tier.
//
// Billing keys off the model actually SERVED (usage.ts is keyed by model
// id), so any upward routing driven by request metadata only ever burns the
// caller's OWN credits — it can't be used to reach a model the entitlement
// gate would otherwise block.
//
// Model stickiness (provider prompt caches are per-model) now holds per
// DIFFICULTY SEGMENT on the high tier: 'hard' sends stay on executorHard,
// everything else stays on executor — not per-conversation like the old
// simple-ask/plan-on-deepthink downgrades, which moved model mid-conversation.
import type { ModelRoutingDoc } from '../lib/app-config.ts';
import { getIntensityConfig, DEFAULT_INTENSITY, type Intensity } from './plans.ts';

export interface RoutingSignals {
    taskType?: string;
    /** 'preplanning' | 'planning' | 'executing' (editor-reported phase). */
    planPhase?: string;
    /** 'easy' | 'hard' — meaningful only for high-tier execution. */
    difficulty?: string;
}

export interface RoutingDecision {
    model: string;
    routedTier: Intensity;
    reason: 'side-task' | 'planner' | 'executor' | 'executor-hard';
}

function tierOf(level: string | undefined): Intensity {
    const cfg = getIntensityConfig(level ?? DEFAULT_INTENSITY);
    if (!cfg) return DEFAULT_INTENSITY;
    return (level === 'super' ? 'high' : (level as Intensity)) ?? DEFAULT_INTENSITY;
}

export function resolveModelForSend(
    requestedTier: string,
    signals: RoutingSignals,
    routing: ModelRoutingDoc,
): RoutingDecision {
    const tier = tierOf(requestedTier);

    // Side-task lane: harness-internal calls (memory distillation) always run
    // on the cheap inline model — this must never burn tier-model rates.
    if (signals.taskType === 'memory') {
        return { model: routing.inline, routedTier: 'low', reason: 'side-task' };
    }

    if (signals.planPhase === 'planning' || signals.planPhase === 'preplanning') {
        return { model: routing.tiers[tier].planner, routedTier: tier, reason: 'planner' };
    }

    if (tier === 'high' && signals.difficulty === 'hard' && routing.tiers.high.executorHard) {
        return { model: routing.tiers.high.executorHard, routedTier: tier, reason: 'executor-hard' };
    }

    return { model: routing.tiers[tier].executor, routedTier: tier, reason: 'executor' };
}
