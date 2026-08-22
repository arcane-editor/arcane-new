// Pure routing decision for an agent-mode composer send (Task 11). Separate
// from preplan-controller.ts (which imports stores and agent-service.ts —
// not Bun-importable, see that file's header) so the decision itself stays
// tested, mirroring plan-route.ts / plan-controller.ts's split.
//
// 'preplan'  → run a read-only context-gathering pass first (preplanning
//              prompt + todo tool only), then chain into execution.
// 'execute'  → send straight through with today's agent-mode toolset, no
//              preplanning pass.
//
// Effort gating (whether THIS tier preplans at all) lives in the caller via
// `shouldPreplanTier` (stores/server-config.ts) — this function only decides,
// given that the tier is eligible, whether there's already a live todo list
// to just keep executing instead of re-preplanning from scratch.

export function routeAgentSend(
  preplanEnabledForTier: boolean,
  plan: ReadonlyArray<{ status: string }> | null,
): 'preplan' | 'execute' {
  if (!preplanEnabledForTier) return 'execute';
  const noRemainingWork = !plan || plan.length === 0 || plan.every((item) => item.status === 'done');
  return noRemainingWork ? 'preplan' : 'execute';
}
