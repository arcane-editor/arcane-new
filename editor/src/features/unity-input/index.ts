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
  qualifiedActionName,
  type InputActionsDocument,
  type InputActionMap,
  type InputAction,
  type InputBinding,
  type ControlScheme,
  type ParsedInputActions,
  type ResolvedAction,
  type BindingConflict,
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
