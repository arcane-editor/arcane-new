import { useThemeStore } from '../../stores/theme';
import type { UiColors } from './types';

/**
 * Resolve a UI token to a concrete color string from the active theme.
 * Use this from non-CSS contexts (e.g. Monaco decoration data) where a
 * `var(--token)` reference can't be passed through.
 */
export function getThemeColor(token: keyof UiColors): string {
  const theme = useThemeStore.getState().getActiveTheme();
  return theme.ui[token];
}

/**
 * Subscribe to theme changes. The callback fires after the new theme is
 * applied. Returns an unsubscribe function.
 */
export function onThemeChange(callback: () => void): () => void {
  let lastId = useThemeStore.getState().activeThemeId;
  return useThemeStore.subscribe((state) => {
    if (state.activeThemeId !== lastId) {
      lastId = state.activeThemeId;
      callback();
    }
  });
}
