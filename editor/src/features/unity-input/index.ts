/**
 * Unity New Input System support -- the Input Hub.
 *
 * Every surface here is gated on the project actually running the New Input
 * System (`isNewInputSystemActive`); a project on the legacy Input Manager sees
 * none of it. The detection itself lives in `utils/input-system.ts` so stores
 * can reach it without importing this barrel's React components -- it is
 * re-exported below purely for callers who already depend on the feature.
 */

export { InputActionsEditor, isInputActionsFile } from './components/InputActionsEditor';
export { InputHubPanel } from './components/InputHubPanel';

export {
  parseInputActions,
  serializeInputActions,
  listActions,
  findBindingConflicts,
  setBindingPath,
  addAction,
  addBinding,
  newInputId,
  qualifiedActionName,
  type InputActionsDocument,
  type InputActionMap,
  type InputAction,
  type InputBinding,
  type ControlScheme,
  type ParsedInputActions,
  type ResolvedAction,
  type BindingConflict,
  type AddActionInput,
  type MutationResult,
} from '../../utils/inputactions-model';

export {
  findActionReferencesInText,
  buildActionReferenceIndex,
  type ActionReference,
  type ActionRefKind,
  type ActionReferenceIndex,
} from './services/action-refs';

export { listInputActionAssets, type InputAssetSummary } from './services/input-assets';
export { gotoActionReference } from './services/goto-usage';

export {
  detectInputSystem,
  isNewInputSystemActive,
  inputSystemLabel,
  readInputSystem,
  type InputSystemMode,
} from '../../utils/input-system';

// ── The input graph ──────────────────────────────────────────────────────────
//
// Exported for the AI harness's `unity_input_actions` tool. The tool used to
// answer from `InputActionsIndex` alone, which is the asset's half of the
// chain; the graph is the join with the C# that reads it. Without it the agent
// cannot tell a `wired` action from an `unread` one, cannot see that a project
// generates a wrapper class (so it writes `FindAction("Jump")` into a codebase
// whose idiom is `controls.Player.Jump.performed +=`), and cannot see a control
// scheme with no binding.
export {
  buildInputGraph,
  deriveActionStatus,
  explainStatus,
  controlCountOf,
  byControl,
  coverageMatrix,
  graphSummary,
  NO_SUPPRESSORS,
} from './services/input-graph';
export type {
  ActionStatus,
  ActionNode,
  MapNode,
  InputGraph,
  GraphInput,
  Suppressors,
  WrapperInfo,
  ControlRow,
  CoverageRow,
  CoverageCell,
} from './services/input-graph';

export {
  loadInputAssetContext,
  parseInputMeta,
  referencedByScene,
  assetStem,
} from './services/input-context';
export type { InputAssetContext, InputAssetMeta } from './services/input-context';

export { buildWrapperCatalog, makeIdentifier, BEHAVIOUR_KINDS } from './services/action-refs';
export type { WrapperCatalog } from './services/action-refs';
