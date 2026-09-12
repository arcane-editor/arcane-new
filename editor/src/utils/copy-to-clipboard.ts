/**
 * Clipboard write that reports whether it worked.
 *
 * `navigator.clipboard.writeText` rejects for reasons the user can actually hit
 * — an unfocused window, a non-secure context, a denied permission — and the
 * two copy sites that predate this one (`TabBar.tsx`, the explorer context
 * menu) swallow the rejection into `console.error`, which in a packaged build
 * means the failure does not exist: the button looks like it worked and the
 * paste is stale. Returning a boolean lets a caller say so on the button.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
