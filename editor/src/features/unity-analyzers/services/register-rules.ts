import { registerRule } from './analyzer-engine';

// Part B
import { nearMissMessagesRule } from '../rules/near-miss-messages';
// Part C
import { nonSerializableTypesRule } from '../rules/non-serializable-types';
// Part D — performance
import { getComponentInUpdateRule } from '../rules/getcomponent-in-update';
import { cameraMainRule } from '../rules/camera-main';
import { stringApisRule } from '../rules/string-apis';
import { allocInUpdateRule } from '../rules/alloc-in-update';
import { emptyMessagesRule } from '../rules/empty-messages';
import { waitForSecondsInLoopRule } from '../rules/waitforseconds-in-loop';
// Part E — correctness
import { nullPropagationUnityObjectRule } from '../rules/null-propagation-unity-object';
import { destroyThisRule } from '../rules/destroy-this';
import { deltaTimeInFixedUpdateRule } from '../rules/deltatime-in-fixedupdate';
import { transformPositionPerAxisRule } from '../rules/transform-position-per-axis';
import { editorApiInRuntimeRule } from '../rules/editor-api-in-runtime';

let registered = false;

/**
 * Register every analyzer rule with the engine exactly once. Order here is the
 * order findings are produced in (cosmetic only — the Problems panel sorts).
 */
export function registerAllRules(): void {
  if (registered) return;
  registered = true;

  registerRule(nearMissMessagesRule);
  registerRule(nonSerializableTypesRule);

  registerRule(getComponentInUpdateRule);
  registerRule(cameraMainRule);
  registerRule(stringApisRule);
  registerRule(allocInUpdateRule);
  registerRule(emptyMessagesRule);
  registerRule(waitForSecondsInLoopRule);

  registerRule(nullPropagationUnityObjectRule);
  registerRule(destroyThisRule);
  registerRule(deltaTimeInFixedUpdateRule);
  registerRule(transformPositionPerAxisRule);
  registerRule(editorApiInRuntimeRule);
}
