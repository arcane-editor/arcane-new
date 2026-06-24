import { useEffect, useMemo, useState } from 'react';
import { FileCode, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useAsmdefStore } from '../../../stores/asmdef';
import type { AsmdefNode } from '../../../stores/asmdef';
import {
  SCRIPT_TEMPLATES,
  renderTemplate,
  validateClassName,
  suggestPascalCase,
  type ScriptTemplateKind,
} from '../data/templates';

interface Props {
  /** Folder the new script is created in. */
  targetDir: string;
  onClose: () => void;
}

/** Nearest-ancestor asmdef rootNamespace for a folder (Unity namespace default). */
function resolveNamespace(targetDir: string, graph: AsmdefNode[]): string {
  let best: AsmdefNode | null = null;
  for (const n of graph) {
    if (targetDir === n.root_folder || targetDir.startsWith(n.root_folder + '/')) {
      if (!best || n.root_folder.length > best.root_folder.length) best = n;
    }
  }
  return best?.root_namespace ?? '';
}

export function NewScriptModal({ targetDir, onClose }: Props) {
  const graph = useAsmdefStore((s) => s.graph);
  const [kind, setKind] = useState<ScriptTemplateKind>('monobehaviour');
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('');
  const [targetType, setTargetType] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNamespace(resolveNamespace(targetDir, graph));
  }, [targetDir, graph]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta = useMemo(() => SCRIPT_TEMPLATES.find((t) => t.kind === kind), [kind]);
  const nameError = name ? validateClassName(name) : null;
  const needsTarget = meta?.needsTargetType ?? false;
  const canCreate =
    !!name && !nameError && (!needsTarget || targetType.trim().length > 0) && !busy;

  async function create() {
    if (!canCreate) return;
    setBusy(true);
    const className = name;
    const path = `${targetDir}/${className}.cs`;
    const content = renderTemplate(kind, className, namespace.trim() || undefined, {
      targetType: targetType.trim() || undefined,
    });
    try {
      await invoke('write_file', { path, contents: content });
      await useWorkspaceStore.getState().refreshTree();
      await useWorkspaceStore.getState().openFile(path, `${className}.cs`);
      onClose();
    } catch (err) {
      console.error('[NewScript] create failed:', err);
      setBusy(false);
    }
  }

  return (
    <div className="app-modal-root" onMouseDown={onClose}>
      <div
        className="app-modal-card"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ minWidth: 420 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <FileCode size={18} />
          <span className="app-modal-title" style={{ flex: 1 }}>New C# Script</span>
          <button
            className="explorer-action-btn"
            onClick={onClose}
            title="Close"
            style={{ marginLeft: 'auto' }}
          >
            <X size={14} />
          </button>
        </div>

        <label style={labelStyle}>Template</label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ScriptTemplateKind)}
          style={inputStyle}
        >
          {SCRIPT_TEMPLATES.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
        {meta?.description && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '2px 0 8px' }}>
            {meta.description}
          </div>
        )}

        <label style={labelStyle}>Class name</label>
        <input
          autoFocus
          value={name}
          placeholder="MyBehaviour"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name && setName(suggestPascalCase(name))}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
          style={inputStyle}
        />
        {nameError && (
          <div style={{ fontSize: 11, color: 'var(--error-text)', marginTop: 2 }}>{nameError}</div>
        )}

        {needsTarget && (
          <>
            <label style={labelStyle}>Target type (the class this {meta?.label} is for)</label>
            <input
              value={targetType}
              placeholder="PlayerController"
              spellCheck={false}
              onChange={(e) => setTargetType(e.target.value)}
              style={inputStyle}
            />
          </>
        )}

        <label style={labelStyle}>Namespace (from owning asmdef)</label>
        <input
          value={namespace}
          placeholder="(none)"
          spellCheck={false}
          onChange={(e) => setNamespace(e.target.value)}
          style={inputStyle}
        />

        <div style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '8px 0' }}>
          Creates <code>{name || 'ClassName'}.cs</code> in {targetDir.split('/').pop()}/
        </div>

        <div className="app-modal-actions">
          <button className="app-modal-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="app-modal-primary"
            disabled={!canCreate}
            onClick={() => void create()}
            style={{ opacity: canCreate ? 1 : 0.5 }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: 'var(--text-secondary)',
  margin: '6px 0 2px',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  background: 'var(--bg-input, var(--bg-sidebar))',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  fontSize: 13,
};

export default NewScriptModal;
