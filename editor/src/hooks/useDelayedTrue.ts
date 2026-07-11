import { useEffect, useState } from 'react';

/**
 * Gates a boolean behind a minimum continuous-`true` duration: `value` must
 * stay `true` for `delayMs` before this flips `true`, and it snaps back to
 * `false` the instant `value` does. Used to keep brief/instant async work
 * (e.g. searches) from flashing an indeterminate loading indicator.
 */
export function useDelayedTrue(value: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!value) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return delayed;
}
