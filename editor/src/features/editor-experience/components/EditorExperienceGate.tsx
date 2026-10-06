import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEditorExperienceStore } from '../../../stores/editor-experience';
import { isMac, isLinux } from '../../../utils/platform';
import WindowControls from '../../../components/WindowControls';
import { EditorExperienceSetup } from './EditorExperienceSetup';
import { createSetupLease } from '../services/setup-lease';
import { initializeEditorExperience } from '../services/runtime';
import './startup.css';

/** Hold pending Unity/project navigation until the owner finishes first-run setup. */
export function EditorExperienceGate({ children }: { children: ReactNode }) {
  const preferences = useEditorExperienceStore((state) => state.preferences);
  const error = useEditorExperienceStore((state) => state.error);
  const status = preferences?.experience.setupStatus;
  const needsSetup = !isLinux() && (status === 'fresh' || status === 'invited');
  const [owner, setOwner] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const dismiss = useEditorExperienceStore((state) => state.dismissSetup);

  useEffect(() => {
    if (!needsSetup) { setOwner(false); setConfiguring(false); return; }
    const window = getCurrentWindow();
    const lease = createSetupLease(window.label, crypto.randomUUID(), invoke);
    let cancelled = false;
    let claiming = false;
    let claimed = false;
    async function claim() {
      if (claiming || claimed || cancelled) return;
      claiming = true;
      try {
        const allowed = await lease.claim();
        if (cancelled) return;
        if (allowed) {
          claimed = true;
          setOwner(true);
          // Unity-launched welcome windows normally start hidden for routing.
          await window.show();
        }
      } catch (failure) { if (!cancelled) setLocalError(String(failure)); }
      finally { claiming = false; }
    }
    void claim();
    // A closed owner is reclaimable, even if its webview never ran cleanup.
    const interval = globalThis.setInterval(() => void claim(), 1000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(interval);
      void lease.release().catch(() => {});
    };
  }, [needsSetup]);

  const modal = owner && (status === 'fresh' || configuring);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    function trap(event: KeyboardEvent) {
      if (event.key === 'Escape' && status === 'invited') {
        event.preventDefault(); setConfiguring(false); return;
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', trap, true);
    return () => { document.removeEventListener('keydown', trap, true); previous?.focus(); };
  }, [modal, status]);

  async function keepPreferences() {
    try { await dismiss(); } catch (failure) { setLocalError(String(failure)); }
  }

  if (!preferences) {
    return (
      <div className="experience-startup">
        <div className="experience-startup-titlebar" data-tauri-drag-region>{!isMac() && <WindowControls />}</div>
        <div className="experience-startup-wait" role={error ? 'alert' : 'status'}>
          {error ? <><p>Preferences could not be loaded. {error}</p><button className="experience-secondary" onClick={() => void initializeEditorExperience().catch(() => {})}>Retry</button></> : 'Loading your editor preferences…'}
        </div>
      </div>
    );
  }

  if (status === 'fresh' && needsSetup) {
    return (
      <div className="experience-startup" ref={dialog}>
        <div className="experience-startup-titlebar" data-tauri-drag-region>{!isMac() && <WindowControls />}</div>
        {(localError || error) && <p className="experience-gate-error" role="alert">{localError || error}</p>}
        {owner ? <EditorExperienceSetup /> : <div className="experience-startup-wait" role="status">Finish setup in the other UnityIDE window.</div>}
      </div>
    );
  }

  return (
    <>
      {children}
      {owner && status === 'invited' && !configuring && <div className="experience-invitation" role="region" aria-label="Editor experience setup">
        <span>Bring your Rider or VS Code preferences into UnityIDE.</span>
        <button onClick={() => setConfiguring(true)}>Set up</button>
        <button onClick={() => void keepPreferences()}>Keep preferences</button>
        {localError && <span role="alert">{localError}</span>}
      </div>}
      {owner && status === 'invited' && configuring && <div className="experience-overlay">
        <div className="experience-setup-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label="Editor experience">
          <EditorExperienceSetup onComplete={() => setConfiguring(false)} />
        </div>
      </div>}
    </>
  );
}
