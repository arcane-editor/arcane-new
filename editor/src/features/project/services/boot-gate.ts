/**
 * What an editor window should render between its first paint and the moment
 * its initial workspace restore settles.
 *
 * `openProjectInNewWindow` spawns the window with `?path=<project>`, but
 * App's restore lives in a mount effect — so the first paint happens with
 * `workspacePath` still `null`. Rendering the "no folder open" WelcomeScreen
 * there means every folder-open shows: blank webview → "Open a folder to get
 * started" → the actual project. That middle frame is a wrong state the user
 * never asked for, and it is what the Windows feedback described as the IDE
 * "flickering or blinking whenever I opened or navigated folders".
 *
 * `'restoring'` lets App render a quiet shell for that gap instead.
 */
export type BootSurface = 'restoring' | 'welcome';

/**
 * Decide the pre-restore surface from the same two inputs App's restore
 * effect uses. Must stay in sync with App.tsx's
 * `urlPath ?? persisted?.workspacePath ?? null` — if this says `'restoring'`
 * but that expression is falsy, no `setWorkspace` runs and the shell would
 * never resolve.
 *
 * Empty strings count as "nothing to restore" for exactly that reason: they
 * are falsy in App's expression too.
 */
export function initialBootSurface(
  urlPath: string | null | undefined,
  persistedWorkspacePath: string | null | undefined,
): BootSurface {
  const willRestore = urlPath || persistedWorkspacePath;
  return willRestore ? 'restoring' : 'welcome';
}
