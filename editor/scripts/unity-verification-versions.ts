/** Prefer the release contract's stable Unity versions over installed betas. */
export function compareVerificationVersions(a: string, b: string): number {
  const parts = (version: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)([abfp])(\d+)$/.exec(version);
    if (!m) return [9, 0, 0, 0, 0];
    const major = Number(m[1]), minor = Number(m[2]);
    const family = !['f', 'p'].includes(m[4]) ? 8 : major === 6000 && minor === 3 ? 0 : major === 6000 && minor === 0 ? 1 : major === 2022 && minor === 3 ? 2 : 3;
    return [family, -major, -minor, -Number(m[3]), -Number(m[5])];
  };
  const aa = parts(a), bb = parts(b);
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return a.localeCompare(b);
}
