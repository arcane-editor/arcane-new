import { useDeferredValue, useMemo, useState } from 'react';
import { Search, LoaderCircle, Boxes } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import type { SoSchema } from '../../unity-analyzers';
import type { AssetUsageEntry } from '../../unity-context';
import { cellValue, formatCell, pickColumns } from '../services/so-instance-columns';

interface SoInstancesTabProps {
  schema: SoSchema | null;
  instances: AssetUsageEntry[];
  isLoading: boolean;
  /** Set when the class derives from a base declared in another file. */
  unresolvedBase: string | null;
}

/**
 * Every `.asset` instance of the open ScriptableObject class, as a table.
 *
 * Values come from the cheap YAML skim that already backs the usage panel, so
 * this is explicitly a PREVIEW: a field the skim dropped renders as an em dash
 * rather than a guess, and the footer says so. Opening an instance reads it
 * properly.
 */
function SoInstancesTab({ schema, instances, isLoading, unresolvedBase }: SoInstancesTabProps) {
  const openFile = useWorkspaceStore((s) => s.openFile);
  const [filter, setFilter] = useState('');
  const deferred = useDeferredValue(filter);

  const columns = useMemo(() => pickColumns(schema), [schema]);

  const rows = useMemo(() => {
    const q = deferred.trim().toLowerCase();
    if (!q) return instances;
    return instances.filter((e) => e.assetName.toLowerCase().includes(q));
  }, [instances, deferred]);

  if (isLoading && instances.length === 0) {
    return (
      <div className="so-instances-empty">
        <LoaderCircle size={20} className="so-spin" strokeWidth={1.5} />
        <span>Scanning for instances…</span>
      </div>
    );
  }

  if (instances.length === 0) {
    return (
      <div className="so-instances-empty">
        <Boxes size={26} strokeWidth={1.25} style={{ opacity: 0.5 }} />
        <div className="so-instances-empty-title">No instances yet</div>
        <div className="so-instances-empty-hint">
          {schema?.menuPath
            ? `Create one from Unity's Assets ▸ Create ▸ ${schema.menuPath} menu.`
            : 'Add a [CreateAssetMenu] attribute to create instances from Unity.'}
        </div>
      </div>
    );
  }

  return (
    <div className="so-instances">
      {unresolvedBase && (
        <div className="so-instances-note">
          Inherited fields from <code>{unresolvedBase}</code> are not shown.
        </div>
      )}

      <div className="scene-usage-search">
        <Search size={14} className="scene-usage-search-icon" />
        <input
          type="text"
          className="scene-usage-search-input"
          placeholder="Filter instances..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      <div className="so-instances-scroll">
        <table className="so-instances-table">
          <thead>
            <tr>
              <th>Asset</th>
              {columns.map((c) => (
                <th key={c.name} title={c.tooltip ?? c.csharpType}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.assetPath}
                onClick={() => openFile(row.assetPath, row.assetName)}
                title={row.assetPath}
              >
                <td className="so-instances-name">{row.assetName}</td>
                {columns.map((c) => {
                  const raw = cellValue(row, c);
                  return (
                    <td
                      key={c.name}
                      className={raw === null ? 'so-instances-missing' : undefined}
                    >
                      {formatCell(raw, c)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="so-instances-foot">
        {rows.length === instances.length
          ? `${instances.length} ${instances.length === 1 ? 'instance' : 'instances'}`
          : `${rows.length} of ${instances.length}`}
        <span className="so-instances-foot-note">
          Preview values — open an instance for full detail.
        </span>
      </div>
    </div>
  );
}

export default SoInstancesTab;
