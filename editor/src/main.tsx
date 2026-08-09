import '@fontsource-variable/geist/index.css';
import '@fontsource-variable/geist-mono/index.css';
import './App.css';
import React from "react";
import ReactDOM from "react-dom/client";
import ErrorBoundary from './components/ErrorBoundary';
import { notify } from './stores/notifications';
import { hydratePersistence } from './utils/persistence';
import { isMac, isWindows } from './utils/platform';

// Apply theme before React renders to prevent FOUC
import { getTheme, DEFAULT_THEME_ID, applyTheme, ensureMonacoTheme } from './features/theme';

const params = new URLSearchParams(location.search);
const view = params.get('view');
const isWelcomeView = view === 'welcome';

// Stamp the platform so CSS can branch on it. The title bar in particular
// reserves space for macOS's traffic lights, which do not exist elsewhere —
// `isWindows()` had been sitting in utils/platform.ts with zero callers for
// exactly this reason. Set before render so the first paint is already
// correct rather than reflowing.
document.documentElement.dataset.os = isMac()
  ? 'macos'
  : isWindows()
    ? 'windows'
    : 'linux';

// Global error handlers
//
// LSP servers and Monaco produce a steady trickle of *benign* rejections
// during normal use (cancelled requests, content-modified, transient
// model-not-found during cross-file navigation). They were surfacing as
// alarming "Unexpected error" toasts even though no user action failed.
// Filter the known-benign ones to console-info; everything else still
// reaches the user.
function isBenignBackgroundError(reason: unknown): boolean {
  const msg = reason instanceof Error ? reason.message : String(reason ?? '');
  // LSP cancellation / content-modified codes (LSP spec §3.13).
  if (msg.includes('-32800') || msg.includes('-32801') || msg.includes('-32802')) return true;
  if (/\bCanceled\b/i.test(msg)) return true;
  if (/\bContentModified\b/i.test(msg)) return true;
  // Monaco transient — model not yet created for a URI it just asked us
  // to open via registerEditorOpener.
  if (msg === 'Model not found' || msg.endsWith(': Model not found')) return true;
  // Tauri event-listener teardown race (dev/StrictMode and rapid remounts).
  if (msg.includes('listeners[eventId].handlerId')) return true;
  if (/Cannot read (properties|property) of undefined.*handlerId/i.test(msg)) return true;
  return false;
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (isBenignBackgroundError(reason)) {
    console.info('[main] benign rejection ignored:', reason);
    event.preventDefault();
    return;
  }
  console.error('[main] unhandled promise rejection:', reason);
  const msg = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : String(reason);
  notify.error(`Unexpected error: ${msg}`);
});
window.addEventListener('error', (event) => {
  console.error('[main] uncaught error:', event.error ?? event.message);
});

const storedThemeId = (() => {
  try {
    const id = localStorage.getItem('editor-theme-id-v2');
    if (id && getTheme(id)) return id;
  } catch { /* ignore */ }
  return DEFAULT_THEME_ID;
})();
const initialTheme = getTheme(storedThemeId);
if (initialTheme) {
  applyTheme(initialTheme);
}

async function bootEditor() {
  const { initMonaco, loadMonacoWorkers } = await import('./features/editor');
  await loadMonacoWorkers();
  const App = (await import('./App')).default;
  initMonaco()
    .then(() => {
      if (initialTheme) ensureMonacoTheme(initialTheme);
    })
    .catch(() => { /* swallow; beforeMount will recover */ });
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

async function bootWelcome() {
  const WelcomeApp = (await import('./WelcomeApp')).default;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <WelcomeApp />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

(async () => {
  try { await hydratePersistence(); } catch { /* ignore */ }
  if (isWelcomeView) {
    await bootWelcome();
  } else {
    await bootEditor();
  }
})();
