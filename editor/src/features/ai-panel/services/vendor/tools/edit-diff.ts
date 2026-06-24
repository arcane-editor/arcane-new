/**
 * Edit diff utilities - adapted from PI coding agent
 * packages/coding-agent/src/core/tools/edit-diff.ts
 *
 * Handles search-and-replace with fuzzy matching and unified diff generation.
 */

import { createTwoFilesPatch } from 'diff';

export interface Edit {
  oldText: string;
  newText: string;
}

export interface FuzzyMatchResult {
  found: boolean;
  startIndex: number;
  endIndex: number;
  matchedText: string;
}

export interface AppliedEditsResult {
  content: string;
  applied: boolean;
  error?: string;
}

/**
 * Find text in content with exact matching.
 * Falls back to normalized matching (trimmed whitespace).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  // Try exact match first
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      startIndex: exactIndex,
      endIndex: exactIndex + oldText.length,
      matchedText: oldText,
    };
  }

  // Try normalized match (collapse whitespace differences)
  const normalizedContent = normalizeWhitespace(content);
  const normalizedOld = normalizeWhitespace(oldText);
  const normalizedIndex = normalizedContent.indexOf(normalizedOld);

  if (normalizedIndex !== -1) {
    // Map back to original content positions
    const originalStart = mapNormalizedIndexToOriginal(content, normalizedIndex);
    const originalEnd = mapNormalizedIndexToOriginal(
      content,
      normalizedIndex + normalizedOld.length,
    );
    return {
      found: true,
      startIndex: originalStart,
      endIndex: originalEnd,
      matchedText: content.slice(originalStart, originalEnd),
    };
  }

  return { found: false, startIndex: -1, endIndex: -1, matchedText: '' };
}

/**
 * Apply multiple edits to content. All edits are matched against the original
 * content (not cascading). Validates no overlaps before applying.
 */
export function applyEdits(content: string, edits: Edit[]): AppliedEditsResult {
  if (edits.length === 0) {
    return { content, applied: true };
  }

  // Find all matches
  const matches: Array<{ edit: Edit; start: number; end: number }> = [];

  for (let i = 0; i < edits.length; i++) {
    const match = fuzzyFindText(content, edits[i].oldText);
    if (!match.found) {
      return {
        content,
        applied: false,
        error: `Edit ${i + 1}: Could not find text to replace:\n"${edits[i].oldText.slice(0, 100)}${edits[i].oldText.length > 100 ? '...' : ''}"`,
      };
    }
    matches.push({ edit: edits[i], start: match.startIndex, end: match.endIndex });
  }

  // Sort by position (descending) to apply from end to start
  matches.sort((a, b) => b.start - a.start);

  // Check for overlaps
  for (let i = 0; i < matches.length - 1; i++) {
    if (matches[i].start < matches[i + 1].end) {
      return {
        content,
        applied: false,
        error: `Edits overlap at position ${matches[i].start}`,
      };
    }
  }

  // Apply edits from end to start (preserves earlier positions)
  let result = content;
  for (const match of matches) {
    result = result.slice(0, match.start) + match.edit.newText + result.slice(match.end);
  }

  return { content: result, applied: true };
}

/**
 * Generate a unified diff string between old and new content.
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  contextLines: number = 3,
): { diff: string; firstChangedLine?: number } {
  const patch = createTwoFilesPatch(
    filePath,
    filePath,
    oldContent,
    newContent,
    'original',
    'modified',
    { context: contextLines },
  );

  // Find first changed line
  let firstChangedLine: number | undefined;
  const lines = patch.split('\n');
  for (const line of lines) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (match) {
      firstChangedLine = parseInt(match[1], 10);
      break;
    }
  }

  return { diff: patch, firstChangedLine };
}

// ---- Helpers ----

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
}

function mapNormalizedIndexToOriginal(original: string, normalizedIndex: number): number {
  let origIdx = 0;
  let normIdx = 0;
  const normalized = normalizeWhitespace(original);

  while (normIdx < normalizedIndex && origIdx < original.length) {
    if (normalized[normIdx] === original[origIdx]) {
      normIdx++;
      origIdx++;
    } else {
      origIdx++;
    }
  }

  return origIdx;
}
