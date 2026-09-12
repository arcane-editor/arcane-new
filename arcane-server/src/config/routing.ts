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
    /** Reasoning effort to serve this send at, or undefined to send none.
     *  Consumed by services/llm-router.ts, which maps it onto each provider
     *  wire's own scale. */
    effort?: EffortLevel;
}

/** How hard the model is asked to think. Two levels, both above every
 *  provider's default: 'max' is the top of the ladder and is SPARK-ONLY (see
 *  `clampEffort`); 'xhigh' is what everything else runs at. */
export type EffortLevel = 'max' | 'xhigh';

/** The role a send is served in — RoutingDecision.reason minus the side-task
 *  lane, which is deliberately effort-free. */
type EffortRole = Exclude<RoutingDecision['reason'], 'side-task'>;

/** Intended effort per (tier, role), BEFORE the spark clamp below.
 *
 *  Standard and Deep Think spend their thinking on the PLAN — planning is
 *  where a wrong turn costs the most, and execution against an already-good
 *  plan is mostly mechanical. Max inverts it: by then the plan is settled and
 *  the executor is the one doing hard work, so that is where the top level
 *  goes. `executor-hard` stays at xhigh because the model serving it (the
 *  high tier's executorHard slot) is not spark, so the clamp would take a
 *  'max' away again anyway — stating it here keeps the table honest about
 *  what is intent and what is capability. */
const ROLE_EFFORT: Record<Intensity, Record<EffortRole, EffortLevel>> = {
    low:  { planner: 'max',   executor: 'xhigh', 'executor-hard': 'xhigh' },
    mid:  { planner: 'max',   executor: 'xhigh', 'executor-hard': 'xhigh' },
    high: { planner: 'xhigh', executor: 'max',   'executor-hard': 'xhigh' },
};

const SPARK_PREFIX = 'spark/';

/** 'max' is a level only the owner's Spark endpoint implements. Every other
 *  provider is pinned to 'xhigh' — the ceiling published on their own scales
 *  (llm-router translates it per wire). Clamping HERE, against the model
 *  actually resolved, means the ROLE_EFFORT table can state intent freely: a
 *  slot that later moves to spark starts serving 'max' with no edit here. */
function clampEffort(effort: EffortLevel, model: string): EffortLevel {
    return effort === 'max' && !model.startsWith(SPARK_PREFIX) ? 'xhigh' : effort;
}

function decide(model: string, routedTier: Intensity, reason: EffortRole): RoutingDecision {
    return { model, routedTier, reason, effort: clampEffort(ROLE_EFFORT[routedTier][reason], model) };
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
        return decide(routing.tiers[tier].planner, tier, 'planner');
    }

    if (tier === 'high' && signals.difficulty === 'hard' && routing.tiers.high.executorHard) {
        return decide(routing.tiers.high.executorHard, tier, 'executor-hard');
    }

    return decide(routing.tiers[tier].executor, tier, 'executor');
}
