import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildAskPrompt } from './ask';
import { buildAgentPrompt } from './agent';
import { buildPlanPlanningPrompt } from './plan-planning';
import { buildPlanExecutionPrompt, buildPlanSendPrefix } from './plan-execution';
import { buildPreplanningPrompt } from './preplanning';

describe('prompt personas (anti-terseness regression)', () => {
  const ask = buildAskPrompt('/proj');
  const agent = buildAgentPrompt('/proj');

  it('ask prompt teaches root causes and adapts depth', () => {
    expect(ask).toContain('root cause');
    expect(ask).toContain('Match depth to the question');
    expect(ask).not.toContain('Keep examples small and self-contained');
  });

  it('agent prompt reports verification, not brevity', () => {
    expect(agent).toContain('what was verified');
    expect(agent).not.toContain('Keep prose tight');
    expect(agent).not.toContain('a brief summary');
  });

  it('both keep the grounding instructions and Unity context', () => {
    expect(ask).toContain('Investigate before answering');
    expect(agent).toContain('unity_api_search');
    expect(agent).toContain('Read before you edit');
  });
});

describe('todo_update instructions (T9)', () => {
  const agent = buildAgentPrompt('/proj');
  const planExecution = buildPlanExecutionPrompt({
    workspacePath: '/proj',
    planPath: '/proj/.unityide/plans/plan.md',
  });

  it('agent prompt has a Task tracking section requiring todo_update for multi-step work', () => {
    expect(agent).toContain('## Task tracking');
    expect(agent).toContain('todo_update');
    expect(agent).toContain('in_progress');
  });

  it('plan-execution prompt ties todo_update to plan steps', () => {
    expect(planExecution).toContain('todo_update');
    expect(planExecution).toContain('mirror the plan');
  });
});

describe('ask_user instructions (Task 2 — agent/plan-planning/plan-execution only, not ask)', () => {
  const agent = buildAgentPrompt('/proj');
  const planPlanning = buildPlanPlanningPrompt('/proj', { difficultyTags: false });
  const planExecution = buildPlanExecutionPrompt({
    workspacePath: '/proj',
    planPath: '/proj/.unityide/plans/plan.md',
  });

  it('agent, plan-planning, and plan-execution prompts all document ask_user', () => {
    expect(agent).toContain('ask_user');
    expect(planPlanning).toContain('ask_user');
    expect(planExecution).toContain('ask_user');
  });

  it('plan-planning prompt prefers asking before writing the plan', () => {
    expect(planPlanning).toContain('BEFORE writing the plan');
  });
});

describe('plan-execution prompt is cache-stable (cache activation §1)', () => {
  const planPath = '/proj/.unityide/plans/plan.md';
  const planContent = '## Steps\n\n- [ ] Step 1: Add ZebraQuantumPickup component';
  const prompt = buildPlanExecutionPrompt({ workspacePath: '/proj', planPath });

  it('references the plan file path but never embeds the plan body', () => {
    expect(prompt).toContain(planPath);
    expect(prompt).not.toContain('ZebraQuantumPickup');
  });

  it('buildPlanSendPrefix carries the full plan only on the first send', () => {
    const first = buildPlanSendPrefix(false, planPath, planContent);
    expect(first).toContain(`## Approved plan (${planPath})`);
    expect(first).toContain('ZebraQuantumPickup');

    const later = buildPlanSendPrefix(true, planPath, planContent);
    expect(later).toContain(planPath);
    expect(later).not.toContain('ZebraQuantumPickup');
    expect(later).toContain('re-read');
  });
});

// ---------------------------------------------------------------------------
// Bridge loss during recompiles is NOT a step failure. Real transcripts: the
// execution prompt's stop-on-failure rule made the model stop and "wait for
// the user" whenever a compile-verification note said the bridge was
// unavailable — which is the EXPECTED state during every domain reload the
// agent's own writes trigger. Script work never needs the live editor.
// ---------------------------------------------------------------------------
import { buildPlanPlanningPrompt as planningPromptFor } from './plan-planning';
import { buildPlanExecutionPrompt as executionPromptFor } from './plan-execution';

describe('bridge-independence + step ordering (plan prompts)', () => {
  const planning = planningPromptFor('/proj', { difficultyTags: false });
  const execution = executionPromptFor({ workspacePath: '/proj', planPath: '/proj/.unityide/plans/p.md' });

  it('planning orders all script todos before any editor-side todos', () => {
    expect(planning).toContain('scripts first, editor last');
    expect(planning.toLowerCase()).toContain('before any todo that drives the unity editor');
  });

  it('execution says bridge loss is not a failure and script work continues', () => {
    expect(execution.toLowerCase()).toContain('not required');
    expect(execution).toContain('NOT a todo failure');
    expect(execution.toLowerCase()).toContain('reconnects automatically');
  });

  it('execution prefers remaining script todos while the editor is unavailable', () => {
    expect(execution.toLowerCase()).toContain('script todos first');
  });
});

// ---------------------------------------------------------------------------
// Progress must survive a re-plan. A regenerated plan used to come back with
// every step unchecked, and execution mirrored todos as ALL pending — so one
// regenerate wiped the visible progress of everything already completed.
// ---------------------------------------------------------------------------
describe('plan progress carry-over (regenerate edge case)', () => {
  const planning = planningPromptFor('/proj', { difficultyTags: false });
  const execution = executionPromptFor({ workspacePath: '/proj', planPath: '/proj/.unityide/plans/p.md' });

  it('planning carries completed steps forward pre-checked, never resetting them', () => {
    expect(planning).toContain('Never reset completed work');
    expect(planning).toContain('- [x]');
  });

  it('execution mirrors todo state from the plan checkboxes, not all-pending', () => {
    expect(execution).toContain('mirror the plan');
    expect(execution).not.toContain('all `pending`');
    expect(execution.toLowerCase()).toContain('already checked');
  });
});

// ---------------------------------------------------------------------------
// Plan template v2 (Task 12) — Goal/Context/Todos/Guide/Risks with optional
// `[easy]`/`[hard]` difficulty tags on high tier, and the execution prompt's
// matching tag-preservation instruction for ticking checkboxes.
// ---------------------------------------------------------------------------
describe('plan-planning template v2 (Task 12)', () => {
  const withoutTags = planningPromptFor('/proj', { difficultyTags: false });
  const withTags = planningPromptFor('/proj', { difficultyTags: true });

  it('template contains all five required sections', () => {
    for (const heading of ['## Goal', '## Context', '## Todos', '## Guide', '## Risks']) {
      expect(withoutTags).toContain(heading);
      expect(withTags).toContain(heading);
    }
  });

  it('shows untagged Todos example lines when difficultyTags is false', () => {
    expect(withoutTags).toContain('- [ ] T1 <verb-led title>');
    expect(withoutTags).not.toContain('[easy]');
    expect(withoutTags).not.toContain('[hard]');
  });

  it('shows tagged Todos example lines and tagging guidance when difficultyTags is true', () => {
    expect(withTags).toContain('- [ ] T1 [easy] <verb-led title>');
    expect(withTags).toContain('- [ ] T2 [hard] <verb-led title>');
    expect(withTags.toLowerCase()).toContain('tag every todo');
    expect(withTags.toLowerCase()).toContain('same-difficulty');
  });

  it('keeps the checkbox grammar (`- [ ] ` / `- [x] ` at line start) either way', () => {
    expect(withoutTags).toMatch(/- \[ \] T1/);
    expect(withTags).toMatch(/- \[ \] T1/);
  });

  it('index.ts wires buildSystemPrompt\'s "plan-planning" case to difficultyTags: effort === "high"', () => {
    const src = readFileSync(path.resolve(import.meta.dir, './index.ts'), 'utf8');
    const match = src.match(/case 'plan-planning':\s*\n\s*return decorate\(\s*\n\s*buildPlanPlanningPrompt\(workspacePath, \{ difficultyTags: effort === 'high' \}\)/);
    expect(match).not.toBeNull();
  });
});

describe('plan-execution tag-preservation instruction (Task 12)', () => {
  const execution = executionPromptFor({ workspacePath: '/proj', planPath: '/proj/.unityide/plans/p.md' });

  it('instructs mirroring each plan todo\'s difficulty into todo_update', () => {
    expect(execution.toLowerCase()).toContain('difficulty');
    expect(execution).toContain('todo_update');
  });

  it('instructs preserving the T<n> [easy|hard] prefix verbatim when ticking a checkbox', () => {
    expect(execution).toContain('T<n>');
    expect(execution.toLowerCase()).toContain('verbatim');
    expect(execution).toContain('T2 [hard] Refactor NavMeshAgent wiring');
  });
});

// ---------------------------------------------------------------------------
// Preplanning prompt (Task 11) — the read-only context-gathering pass that
// runs automatically ahead of agent-mode execution on tiers that have it.
// ---------------------------------------------------------------------------
describe('preplanning prompt (Task 11)', () => {
  const preplanning = buildPreplanningPrompt('/proj', { difficultyTags: false });
  const withDifficulty = buildPreplanningPrompt('/proj', { difficultyTags: true });

  it('requires exactly one todo_update call as the final action', () => {
    expect(preplanning).toContain('todo_update');
    expect(preplanning).toContain('required, not optional');
  });

  it('cannot write, edit, or run anything', () => {
    expect(preplanning).toContain('cannot');
    expect(preplanning).toContain('unavailable');
    expect(preplanning).toContain('write');
    expect(preplanning).toContain('edit');
    expect(preplanning).toContain('bash');
  });

  it('carries over the scripts-first/editor-last ordering rule from the old auto-plan.ts heuristic', () => {
    expect(preplanning).toContain('scripts first, editor last');
    expect(preplanning.toLowerCase()).toContain('before any step that drives the unity editor');
  });

  it('documents ask_user with the same batching/limit rules as plan-planning', () => {
    expect(preplanning).toContain('ask_user');
    expect(preplanning).toContain('never ask more than twice');
  });

  it('ends with a short summary of intended approach, not a plan document', () => {
    expect(preplanning).toContain('2-3 sentence summary');
    expect(preplanning).toContain('no plan document');
  });

  it('omits the difficulty-tagging instruction when difficultyTags is false', () => {
    expect(preplanning).not.toContain('difficulty');
  });

  it('includes the easy/hard difficulty instruction when difficultyTags is true', () => {
    expect(withDifficulty).toContain('difficulty');
    expect(withDifficulty).toContain('`easy`');
    expect(withDifficulty).toContain('`hard`');
    expect(withDifficulty.toLowerCase()).toContain('same-difficulty');
  });

  // `buildSystemPrompt` itself can't be exercised here: `prompts/index.ts`
  // statically imports `stores/workspace.ts` (for the frozen-decoration
  // capture), which transitively touches `document` at module-eval time —
  // fatal under plain `bun test`, same constraint `hosted-stream.test.ts`'s
  // header documents for `stores/ai`. A source-text assertion sidesteps that
  // (same technique `session-persistence.test.ts`'s `AI_STORE_SRC` uses) and
  // is exactly as precise: it fails the instant the wiring changes.
  it('index.ts wires buildSystemPrompt\'s "preplanning" case to difficultyTags: effort === "high"', () => {
    const src = readFileSync(path.resolve(import.meta.dir, './index.ts'), 'utf8');
    const match = src.match(/case 'preplanning':\s*\n\s*return decorate\(\s*\n\s*buildPreplanningPrompt\(workspacePath, \{ difficultyTags: effort === 'high' \}\)/);
    expect(match).not.toBeNull();
  });
});
