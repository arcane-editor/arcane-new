import { useEffect, useId, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, Check, ChevronRight, FolderOpen, Keyboard, LoaderCircle, Palette, RotateCcw, Settings2 } from 'lucide-react';
import { useEditorExperienceStore } from '../../../stores/editor-experience';
import type { EditorProfile, ImportCategory, ImportPreview, ImportReportItem, ImportSource, RiderKeymap } from '../../../types/editor-experience';
import { isMac } from '../../../utils/platform';
import { getPresetKeybindingReport } from '../services/keymaps';
import { KeyboardOverrides } from './KeyboardOverrides';
import '../experience.css';

const CATEGORIES: Array<{ id: ImportCategory; label: string; description: string; icon: typeof Palette }> = [
  { id: 'appearance', label: 'Appearance', description: 'Theme, fonts and text size', icon: Palette },
  { id: 'editor', label: 'Editor settings', description: 'Indentation, wrapping and saving', icon: Settings2 },
  { id: 'shortcuts', label: 'Keyboard shortcuts', description: 'Keymap and supported custom bindings', icon: Keyboard },
];
const ALL_CATEGORIES = CATEGORIES.map((category) => category.id);
const KEYMAPS: Array<{ id: RiderKeymap; label: string }> = [
  { id: 'intellij', label: 'IntelliJ' },
  { id: 'visual-studio', label: 'Visual Studio' },
  { id: 'visual-studio-2022', label: 'Visual Studio 2022' },
  { id: 'resharper', label: 'ReSharper' },
  { id: 'vscode', label: 'Visual Studio Code' },
];
const PROFILE_NAMES: Record<EditorProfile, string> = { unityide: 'UnityIDE', rider: 'Rider', vscode: 'Visual Studio Code' };
const STATUS_NAMES = { imported: 'Imported', approximated: 'Closest match', unsupported: 'Unavailable', conflicting: 'Conflict' };

function ImportReport({ items, preview = false, categories = ALL_CATEGORIES }: { items: ImportReportItem[]; preview?: boolean; categories?: ImportCategory[] }) {
  if (items.length === 0) return null;
  return (
    <details className="experience-report">
      <summary>{preview ? 'Review settings' : 'Last import report'} <span>{items.length}</span></summary>
      <ul>
        {items.map((item, index) => {
          const selected = categories.includes(item.category);
          return (
            <li key={`${item.category}-${item.label}-${index}`}>
              <div className="experience-report-row">
                <strong>{item.label}</strong>
                <span className={`experience-status experience-status-${selected ? item.status : 'excluded'}`}>
                  {!selected ? 'Not selected' : preview && item.status === 'imported' ? 'Will import' : STATUS_NAMES[item.status]}
                </span>
              </div>
              <p>{item.detail}</p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Shared first-launch and Settings surface; the importer never changes the source editor. */
export function EditorExperienceSetup({ onComplete, embedded = false }: { onComplete?: () => void; embedded?: boolean }) {
  const preferences = useEditorExperienceStore((state) => state.preferences);
  const storeError = useEditorExperienceStore((state) => state.error);
  const refresh = useEditorExperienceStore((state) => state.refresh);
  const discover = useEditorExperienceStore((state) => state.discover);
  const previewSource = useEditorExperienceStore((state) => state.preview);
  const applyProfile = useEditorExperienceStore((state) => state.applyProfile);
  const dismissSetup = useEditorExperienceStore((state) => state.dismissSetup);
  const restore = useEditorExperienceStore((state) => state.restore);
  const [profile, setProfile] = useState<'rider' | 'vscode' | null>(null);
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [categories, setCategories] = useState<ImportCategory[]>(ALL_CATEGORIES);
  const [keymap, setKeymap] = useState<RiderKeymap>('intellij');
  const [busy, setBusy] = useState<'discovering' | 'previewing' | 'applying' | 'restoring' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const locked = busy !== null;
  const reviewReport = [...(preview?.report ?? []), ...(profile ? getPresetKeybindingReport(profile, keymap, isMac()) : [])];

  useEffect(() => {
    if (!preferences) void refresh().catch(() => {});
  }, [preferences, refresh]);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { headingRef.current?.focus(); }, [profile]);

  async function readPreview(source: ImportSource, ticket: number) {
    setSourceId(source.id);
    setPreview(null);
    setBusy('previewing');
    try {
      const next = await previewSource(source);
      if (request.current !== ticket) return;
      setPreview(next);
      setKeymap(next.keymap ?? (source.editor === 'vscode' ? 'vscode' : 'intellij'));
    } catch (reason) {
      if (request.current === ticket) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request.current === ticket) setBusy(null);
    }
  }

  async function findSources(editor: 'rider' | 'vscode', customPath?: string) {
    const ticket = ++request.current;
    setProfile(editor);
    setSources([]);
    setSourceId('');
    setPreview(null);
    setCategories(ALL_CATEGORIES);
    setKeymap(editor === 'vscode' ? 'vscode' : 'intellij');
    setError(null);
    setNotice(null);
    setBusy('discovering');
    try {
      const found = await discover(editor, customPath);
      if (request.current !== ticket) return;
      setSources(found);
      const recommended = found.find((source) => source.recommended) ?? found[0];
      if (recommended) await readPreview(recommended, ticket);
      else setBusy(null);
    } catch (reason) {
      if (request.current === ticket) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setBusy(null);
      }
    }
  }

  async function browse() {
    if (!profile || locked) return;
    setError(null);
    try {
      const path = await open({ directory: true, multiple: false, title: `Choose ${PROFILE_NAMES[profile]} settings folder` });
      if (typeof path === 'string') await findSources(profile, path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function apply(usePreset = false) {
    if (!profile || locked) return;
    setError(null);
    setBusy('applying');
    try {
      await applyProfile(profile, keymap, usePreset ? null : preview, usePreset ? ALL_CATEGORIES : categories);
      setProfile(null);
      setNotice(`${PROFILE_NAMES[profile]} preferences applied.`);
      onComplete?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(null); }
  }

  async function keepCurrent() {
    if (locked) return;
    setError(null);
    setBusy('applying');
    try {
      await dismissSetup();
      onComplete?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(null); }
  }

  async function restorePrevious() {
    if (locked) return;
    setError(null);
    setBusy('restoring');
    try {
      await restore();
      setProfile(null);
      setNotice('Previous preferences restored.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(null); }
  }

  return (
    <section className={`editor-experience${embedded ? ' editor-experience-embedded' : ''}`} aria-labelledby={headingId} aria-busy={locked}>
      <header className="experience-header">
        {!embedded && <span className="experience-wordmark">UNITYIDE</span>}
        {profile && <button className="experience-back" disabled={locked} onClick={() => { request.current++; setProfile(null); setError(null); }}><ArrowLeft size={14} /> Back</button>}
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>
          {profile ? `Bring your ${PROFILE_NAMES[profile]} preferences` : embedded ? 'Editor experience' : 'Which editor do you use most?'}
        </h2>
        <p>{profile ? 'Choose what to bring into UnityIDE. Your original settings stay in place.' : 'Use familiar shortcuts and appearance with the same UnityIDE tools.'}</p>
      </header>

      {(error ?? storeError) && <p className="experience-error" role="alert">{error ?? storeError}</p>}
      {notice && <p className="experience-notice" role="status"><Check size={14} /> {notice}</p>}

      {!profile ? (
        <>
          {embedded && preferences && (
            <div className="experience-current">
              <div><span>Current experience</span><strong>{PROFILE_NAMES[preferences.experience.profile]}</strong>{preferences.experience.sourceLabel && <small>{preferences.experience.sourceLabel}</small>}</div>
              {preferences.canRestore && <button className="experience-secondary" onClick={restorePrevious} disabled={locked}><RotateCcw size={13} /> {busy === 'restoring' ? 'Restoring…' : 'Restore previous'}</button>}
            </div>
          )}
          <div className="experience-choices">
            {(['rider', 'vscode'] as const).map((editor) => (
              <button key={editor} className={`experience-choice experience-choice-${editor}`} disabled={locked} onClick={() => { void findSources(editor); }}>
                <span className="experience-choice-mark" aria-hidden>{editor === 'rider' ? 'RD' : '</>'}</span>
                <strong>{PROFILE_NAMES[editor]}</strong>
                <span>{editor === 'rider' ? 'Rider appearance and keymaps' : 'VS Code appearance and shortcuts'}</span>
                <span className="experience-choice-action">Set up <ChevronRight size={14} /></span>
              </button>
            ))}
          </div>
          {!embedded && <button className="experience-keep" disabled={locked} onClick={keepCurrent}>{busy === 'applying' ? 'Saving…' : 'Keep UnityIDE defaults'}</button>}
          {embedded && preferences && <ImportReport items={preferences.experience.lastReport} />}
          {embedded && preferences && <KeyboardOverrides />}
        </>
      ) : (
        <>
          <div className="experience-source">
            <label htmlFor={`${headingId}-source`}>Local settings</label>
            <div className="experience-source-controls">
              <select id={`${headingId}-source`} value={sourceId} disabled={locked || sources.length === 0} onChange={(event) => {
                const source = sources.find((candidate) => candidate.id === event.target.value);
                if (source) { setError(null); void readPreview(source, ++request.current); }
              }}>
                {sources.length === 0 ? <option>{busy === 'discovering' ? 'Looking for settings…' : 'No local settings found'}</option> : sources.map((source) => <option key={source.id} value={source.id}>{source.label}{source.recommended ? ' (recommended)' : ''}</option>)}
              </select>
              <button className="experience-secondary" onClick={browse} disabled={locked}><FolderOpen size={14} /> Browse</button>
            </div>
            {sources.find((source) => source.id === sourceId)?.path && <small className="experience-source-path">{sources.find((source) => source.id === sourceId)!.path}</small>}
          </div>

          {busy === 'discovering' || busy === 'previewing' ? (
            <div className="experience-loading" role="status"><LoaderCircle size={16} /> {busy === 'discovering' ? 'Finding local preferences…' : 'Preparing import preview…'}</div>
          ) : preview ? (
            <>
              <fieldset className="experience-categories">
                <legend>Import</legend>
                {CATEGORIES.map(({ id, label, description, icon: Icon }) => (
                  <label key={id} className="experience-category">
                    <input type="checkbox" checked={categories.includes(id)} disabled={locked} onChange={(event) => setCategories((current) => event.target.checked ? [...current, id] : current.filter((category) => category !== id))} />
                    <Icon size={15} aria-hidden />
                    <span><strong>{label}</strong><small>{description}</small></span>
                  </label>
                ))}
              </fieldset>
              <p className="experience-support-note">Supported preferences will be imported. Themes may use a close match; unavailable settings are listed below. Fonts use a system fallback when needed.</p>
            </>
          ) : <p className="experience-empty">Choose a settings folder, or use defaults and import later. Defaults use the {profile === 'rider' ? keymap === 'intellij' ? 'IntelliJ-style Rider' : KEYMAPS.find((item) => item.id === keymap)?.label : 'VS Code'} keymap for your operating system.</p>}

          {profile === 'rider' && (
            <div className="experience-keymap">
              <label htmlFor={`${headingId}-keymap`}>Rider keymap</label>
              <select id={`${headingId}-keymap`} value={keymap} disabled={locked} onChange={(event) => setKeymap(event.target.value as RiderKeymap)}>{KEYMAPS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
            </div>
          )}
          {busy !== 'discovering' && busy !== 'previewing' && <ImportReport items={reviewReport} preview categories={preview ? categories : ALL_CATEGORIES} />}
          <footer className="experience-actions">
            {preview && <button className="experience-secondary" disabled={locked} onClick={() => { void apply(true); }}>Use defaults</button>}
            <button className="experience-primary" disabled={locked || (preview !== null && categories.length === 0)} onClick={() => { void apply(preview === null); }}>
              {busy === 'applying' ? 'Applying…' : preview ? 'Import and continue' : 'Use defaults'} <ChevronRight size={14} />
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
