import { useMemo, useState } from 'react';
import { useCommandsStore } from '../../../stores/commands';
import { useEditorExperienceStore } from '../../../stores/editor-experience';
import { normalizeBinding, isProtectedStroke } from '../../../utils/editor-keybindings';
import { isMac } from '../../../utils/platform';
import { formatKeybinding } from '../../../utils/format-keybinding';
import type { BindingContext, KeyBinding } from '../../../types/editor-experience';
import { MONACO_ACTION_LABELS } from '../services/keymaps';

export function KeyboardOverrides() {
  const commands = useCommandsStore((state) => state.baseCommands);
  const preferences = useEditorExperienceStore((state) => state.preferences);
  const setUserBinding = useEditorExperienceStore((state) => state.setUserBinding);
  const [commandId, setCommandId] = useState('file.save');
  const [chord, setChord] = useState('');
  const [context, setContext] = useState<BindingContext>('global');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const monacoAction = commandId.startsWith('monaco:');
  const effectiveContext: BindingContext = monacoAction ? 'editor' : context;
  const options = useMemo(() => [
    ...Array.from(commands.values(), (command) => ({ id: command.id, label: command.label })),
    ...Object.entries(MONACO_ACTION_LABELS).map(([id, label]) => ({ id: `monaco:${id}`, label })),
  ].sort((a, b) => a.label.localeCompare(b.label)), [commands]);

  async function change(binding: KeyBinding | null, id = commandId) {
    setBusy(true); setNotice(null);
    try { await setUserBinding(id, binding); setChord(''); setNotice('Shortcut preferences saved.'); }
    catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }
  function save() {
    const binding = normalizeBinding({ commandId, strokes: chord.trim().split(/\s+/), context: effectiveContext }, isMac());
    if (!binding || binding.strokes.some((stroke) => isProtectedStroke(stroke, isMac()))) {
      setNotice('Enter one or two supported key combinations. Standard editing and operating-system shortcuts stay reserved.');
      return;
    }
    void change(binding);
  }

  return <details className="experience-report experience-shortcut-overrides">
    <summary>Customize keyboard shortcuts</summary>
    <p className="experience-support-note">Your custom shortcuts take priority over the profile and imported shortcuts.</p>
    <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label>Action<select value={commandId} disabled={busy} onChange={(event) => {
        setCommandId(event.target.value); setContext(event.target.value.startsWith('monaco:') ? 'editor' : 'global');
      }}>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label>Shortcut<input value={chord} disabled={busy} onChange={(event) => setChord(event.target.value)} placeholder={isMac() ? 'cmd+k cmd+d' : 'ctrl+k ctrl+d'} /></label>
      <label>Where<select value={effectiveContext} disabled={busy || monacoAction} onChange={(event) => setContext(event.target.value as BindingContext)}>
        {!monacoAction && <option value="global">Throughout UnityIDE</option>}<option value="editor">Code editor</option>
        {!monacoAction && <><option value="terminal">Terminal</option><option value="input">Text fields</option></>}
      </select></label>
      <div className="experience-actions"><button type="button" className="experience-secondary" disabled={busy} onClick={() => void change({ commandId, strokes: [], removed: true, context: effectiveContext })}>Disable shortcut</button>
        <button className="experience-primary" disabled={busy || !chord.trim()}>Save shortcut</button></div>
    </form>
    {notice && <p role="status" className="experience-support-note">{notice}</p>}
    {(preferences?.experience.userBindings ?? []).map((binding) => <div className="experience-override-row" key={binding.commandId}>
      <span>{options.find((option) => option.id === binding.commandId)?.label ?? binding.commandId}</span>
      <span>{binding.removed ? 'Disabled' : formatKeybinding(binding.strokes.join(' '))}</span>
      <button type="button" className="experience-keep" disabled={busy} onClick={() => void change(null, binding.commandId)}>Reset</button>
    </div>)}
  </details>;
}
