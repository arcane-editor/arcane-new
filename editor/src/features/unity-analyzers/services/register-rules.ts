import { registerRule } from './analyzer-engine';
import { ALL_RULES } from '../rules';

let registered = false;

/**
 * Register every analyzer rule with the engine exactly once.
 *
 * The list itself lives in `rules/index.ts`, which imports no store and no
 * engine — so a test can read it without loading Tauri. This module is only
 * the wiring.
 */
export function registerAllRules(): void {
  if (registered) return;
  registered = true;
  for (const rule of ALL_RULES) registerRule(rule);
}
