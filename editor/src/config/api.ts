// Single source of truth for every backend endpoint the editor talks to.
// Values come from Vite env files (.env.development / .env.production,
// overridable via .env.development.local or shell env at build time).
// Fallbacks are the PRODUCTION endpoints so a build with missing env vars
// fails safe.
export const API_URL: string =
  import.meta.env.VITE_API_URL ?? 'https://api.arcaneai.org';

export const WEB_URL: string =
  import.meta.env.VITE_WEB_URL ?? 'https://arcaneai.org';

/**
 * Assert that the endpoints this build targets match the channel the Rust side
 * derived from the bundle identifier — which is what picks the config dir
 * (`~/.unityide` vs `~/.unityide-dev`) and the deep-link scheme.
 *
 * These two are set by different tooling: Vite's mode picks the URLs above, the
 * Tauri config file picks the identifier. A plain `tauri dev` took the dev
 * endpoints with the PRODUCTION identifier, so a token minted against the dev
 * API landed in `~/.unityide` and the real app then presented it to the
 * production API. Nothing surfaced that, which is the whole reason this exists.
 *
 * Resolves to an error message on mismatch, or null when consistent.
 */
export async function checkReleaseChannel(
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<string | null> {
  try {
    await invoke('auth_check_channel', { apiUrl: API_URL });
    return null;
  } catch (err) {
    return String(err);
  }
}
