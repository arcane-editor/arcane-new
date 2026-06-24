export interface FuzzyResult {
  score: number;
  matches: number[]; // indices of matched characters in target
}

export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // Quick check: all query chars must exist in target in order
  let qi = 0;
  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
    if (targetLower[ti] === queryLower[qi]) qi++;
  }
  if (qi < queryLower.length) return null;

  // Find best match with scoring
  const matches: number[] = [];
  let score = 0;
  let lastMatchIndex = -1;
  let consecutiveBonus = 0;

  qi = 0;
  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
    if (targetLower[ti] === queryLower[qi]) {
      matches.push(ti);

      // Consecutive match bonus
      if (lastMatchIndex === ti - 1) {
        consecutiveBonus += 5;
        score += consecutiveBonus;
      } else {
        consecutiveBonus = 0;
        score += 1;
      }

      // Start of word bonus
      if (ti === 0 || /[/.\-_\s]/.test(target[ti - 1])) {
        score += 10;
      }

      // Camel case boundary bonus
      if (ti > 0 && target[ti] === target[ti].toUpperCase() && target[ti - 1] === target[ti - 1].toLowerCase() && target[ti - 1] !== target[ti - 1].toUpperCase()) {
        score += 8;
      }

      // Penalty for gap
      if (lastMatchIndex >= 0 && ti - lastMatchIndex > 1) {
        score -= (ti - lastMatchIndex - 1);
      }

      lastMatchIndex = ti;
      qi++;
    }
  }

  // Prefer shorter targets (more relevant)
  score -= Math.floor(target.length / 10);

  return { score, matches };
}
