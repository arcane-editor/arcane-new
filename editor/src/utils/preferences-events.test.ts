import { expect, it } from 'bun:test';
import { createPreferencesBus } from './preferences-events';
import type { EditorPreferences } from '../types/editor-experience';

it('ignores stale snapshots and duplicate event/invoke delivery without losing the newest revision', () => {
  const bus = createPreferencesBus();
  const delivered: number[] = [];
  const unsubscribe = bus.subscribe((preferences) => delivered.push(preferences.revision));
  for (const revision of [0, 2, 1, 2, 3]) bus.publish({ revision } as EditorPreferences);
  expect(delivered).toEqual([0, 2, 3]);
  unsubscribe();
  bus.publish({ revision: 4 } as EditorPreferences);
  expect(delivered).toEqual([0, 2, 3]);
});
