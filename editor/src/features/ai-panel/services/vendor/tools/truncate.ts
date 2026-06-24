/**
 * Output truncation utilities - adapted from PI coding agent
 * packages/coding-agent/src/core/tools/truncate.ts
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

/**
 * Truncate from the head (beginning) — used for read tool (show first N lines).
 */
export function truncateHead(
  content: string,
  options?: TruncationOptions,
): TruncationResult {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = new TextEncoder().encode(content).length;
  const lines = content.split('\n');
  const totalLines = lines.length;

  // Check byte limit first
  if (totalBytes > maxBytes) {
    let accumulated = 0;
    let lineCount = 0;
    for (const line of lines) {
      const lineBytes = new TextEncoder().encode(line + '\n').length;
      if (accumulated + lineBytes > maxBytes) break;
      accumulated += lineBytes;
      lineCount++;
    }
    const truncated = lines.slice(0, Math.max(lineCount, 1)).join('\n');
    return {
      content: truncated,
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: Math.max(lineCount, 1),
      outputBytes: new TextEncoder().encode(truncated).length,
    };
  }

  // Check line limit
  if (totalLines > maxLines) {
    const truncated = lines.slice(0, maxLines).join('\n');
    return {
      content: truncated,
      truncated: true,
      truncatedBy: 'lines',
      totalLines,
      totalBytes,
      outputLines: maxLines,
      outputBytes: new TextEncoder().encode(truncated).length,
    };
  }

  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines,
    totalBytes,
    outputLines: totalLines,
    outputBytes: totalBytes,
  };
}

/**
 * Truncate from the tail (end) — used for bash tool (show last N lines).
 */
export function truncateTail(
  content: string,
  options?: TruncationOptions,
): TruncationResult {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = new TextEncoder().encode(content).length;
  const lines = content.split('\n');
  const totalLines = lines.length;

  // Check byte limit
  if (totalBytes > maxBytes) {
    let accumulated = 0;
    let startLine = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = new TextEncoder().encode(lines[i] + '\n').length;
      if (accumulated + lineBytes > maxBytes) break;
      accumulated += lineBytes;
      startLine = i;
    }
    const truncated = lines.slice(startLine).join('\n');
    return {
      content: truncated,
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: lines.length - startLine,
      outputBytes: new TextEncoder().encode(truncated).length,
    };
  }

  // Check line limit
  if (totalLines > maxLines) {
    const truncated = lines.slice(-maxLines).join('\n');
    return {
      content: truncated,
      truncated: true,
      truncatedBy: 'lines',
      totalLines,
      totalBytes,
      outputLines: maxLines,
      outputBytes: new TextEncoder().encode(truncated).length,
    };
  }

  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines,
    totalBytes,
    outputLines: totalLines,
    outputBytes: totalBytes,
  };
}
