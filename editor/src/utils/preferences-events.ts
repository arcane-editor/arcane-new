import type { EditorPreferences } from '../types/editor-experience';

type Listener = (preferences: EditorPreferences) => void;
export function createPreferencesBus() {
  const listeners = new Set<Listener>();
  let latestRevision = -1;
  return {
    /** Native events and invoke responses may arrive in either order. */
    publish(preferences: EditorPreferences): void {
      if (!preferences || typeof preferences.revision !== 'number' || preferences.revision <= latestRevision) return;
      latestRevision = preferences.revision;
      for (const listener of listeners) listener(preferences);
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const bus = createPreferencesBus();
export const publishPreferences = bus.publish;
export const subscribePreferences = bus.subscribe;
