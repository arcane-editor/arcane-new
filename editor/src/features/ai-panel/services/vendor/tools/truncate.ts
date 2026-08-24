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
 * Slice a string to at most `maxBytes` of UTF-8 **without splitting a
 * character**. A naive byte slice can land inside a multi-byte sequence and
 * decode to U+FFFD, which the model cannot distinguish from real content. UTF-8
 * continuation bytes are `0b10xxxxxx`, so walking to the nearest lead byte
 * keeps every sequence (including 4-byte astral chars) whole.
 */
function sliceBytesFromStart(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Tail counterpart of `sliceBytesFromStart` — keeps the END of the string. */
function sliceBytesFromEnd(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
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
    // No whole line fits (one line longer than the cap — a minified bundle, a
    // one-line JSON dump). Keeping `Math.max(lineCount, 1)` lines returned that
    // WHOLE oversized line, sailing straight past the byte cap this branch
    // exists to enforce; keeping zero lines would hand the model an empty
    // result. Slice the single line to the cap instead.
    const truncated =
      lineCount === 0
        ? sliceBytesFromStart(lines[0], maxBytes)
        : lines.slice(0, lineCount).join('\n');
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
    // `startLine === lines.length` means not even the LAST line fits, so this
    // slice used to be `[]`: the bash tool handed the model an empty string
    // flagged `truncated: true`, which reads as "the command printed nothing"
    // on exactly the runs that printed the most. Slice that line's tail — the
    // end is what the bash tool exists to show (the exit message, the last
    // stack frame, the final compiler error).
    const truncated =
      startLine === lines.length
        ? sliceBytesFromEnd(lines[lines.length - 1], maxBytes)
        : lines.slice(startLine).join('\n');
    return {
      content: truncated,
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: Math.max(lines.length - startLine, 1),
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
