/** Check both fallback metrics: missing names silently fall back in CSS. */
export function localFontAvailable(family: string): boolean | null {
  if (typeof document === 'undefined') return null;
  const name = family.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
  if (!name || /^(monospace|serif|sans-serif|ui-monospace)$/i.test(name)) return true;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const sample = 'mmmmmmmmwwwwwwwwiiiiiiiiWWWW0123456789';
  return ['monospace', 'sans-serif'].some((fallback) => {
    ctx.font = `32px ${fallback}`;
    const baseline = ctx.measureText(sample).width;
    ctx.font = `32px ${JSON.stringify(name)}, ${fallback}`;
    return Math.abs(ctx.measureText(sample).width - baseline) > 0.01;
  });
}
