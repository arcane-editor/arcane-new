/**
 * Jump from a binding to the C# that handles it.
 *
 * A binding path has no call site of its own — C# resolves an action by NAME,
 * never by path — so "go to where this binding is used" means "go to where its
 * ACTION is used". Every entry point (a binding row, a peek result, the
 * reference list in the properties panel) funnels through here so they cannot
 * drift apart on which file they open or where the caret lands.
 *
 * The navigation itself is `openExcerptAt`, the same path the search results
 * use. Reusing it is not just DRY: it sets the pending navigation BEFORE
 * `openFile` so `EditorPanel`'s effect consumes it once the tab is actually
 * mounted. Dispatching after the open races the mount and silently drops the
 * scroll — a bug that already shipped once in search.
 */

import { openExcerptAt } from '../../search';
import type { ActionReference } from './action-refs';

/**
 * Open the file as a tab, scroll the reference into view, focus it, and flash
 * the line.
 *
 * The highlight is not decoration here: the jump starts in a different panel
 * and often lands in a file the user has never seen, so without it there is no
 * signal that anything happened, let alone which of forty similar lines was
 * meant.
 */
export async function gotoActionReference(ref: ActionReference): Promise<void> {
  await openExcerptAt(ref.filePath, ref.line, ref.column, { highlight: true });
}
