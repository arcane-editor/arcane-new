import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, FileWarning, LoaderCircle } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUnityIndexStore } from '../../../stores/unity-index';
import { readAssetMetaGuid } from '../../unity-context';
import type { SoRow } from '../services/so-value-model';

interface SoReferenceMapProps {
  /** Absolute path of the open `.asset`. */
  path: string;
  /** Rows of the open asset, whose object references form the outgoing links. */
  rows: SoRow[];
}

interface Link {
  guid: string;
  /** Resolved asset path, or null when the guid points at nothing. */
  target: string | null;
  /** The field the reference lives in, for the outgoing direction. */
  via: string;
}

const GUID_RE = /guid:\s*([0-9a-fA-F]{32})/;

/**
 * Where this asset sits in the project: what points at it, and what it points
 * at.
 *
 * A single asset is a form, not a table, so there is no side panel for it —
 * this lives at the foot of the form instead. An outgoing reference whose guid
 * resolves to nothing is a BROKEN reference: the asset it named was deleted, and
 * Unity will silently show "None" in its own Inspector.
 */
function SoReferenceMap({ path, rows }: SoReferenceMapProps) {
  const openFile = useWorkspaceStore((s) => s.openFile);
  const [incoming, setIncoming] = useState<Array<{ path: string; count: number }> | null>(null);
  const [outgoing, setOutgoing] = useState<Link[]>([]);
  const [loading, setLoading] = useState(true);

  // Two triggers, not one — a full rebuild leaves `indexRevision` untouched.
  const indexStatus = useUnityIndexStore((s) => s.status);
  const indexRevision = useUnityIndexStore((s) => s.indexRevision);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const run = async () => {
      // Outgoing: every object-reference value in the form.
      const links: Link[] = [];
      for (const row of rows) {
        const raw = row.value?.raw;
        if (!raw) continue;
        const guid = GUID_RE.exec(raw)?.[1];
        if (!guid) continue;
        const target = await useUnityIndexStore.getState().resolveGuid(guid);
        links.push({ guid, target, via: row.yamlKey });
      }
      if (cancelled) return;
      setOutgoing(links);

      // Incoming: who references THIS asset, by its own .meta guid.
      const ownGuid = await readAssetMetaGuid(path);
      if (cancelled) return;
      if (!ownGuid) {
        setIncoming([]);
        setLoading(false);
        return;
      }
      const hits = await useUnityIndexStore.getState().findReferences(ownGuid);
      if (cancelled) return;
      setIncoming(hits);
      setLoading(false);
    };

    void run().catch(() => {
      if (!cancelled) {
        setIncoming([]);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [path, rows, indexStatus, indexRevision]);

  const broken = outgoing.filter((l) => l.target === null);

  return (
    <div className="so-refmap">
      <div className="so-editor-group-header">References</div>

      {loading && (
        <div className="so-refmap-loading">
          <LoaderCircle size={13} className="so-spin" /> Resolving…
        </div>
      )}

      {broken.length > 0 && (
        <div className="so-refmap-broken">
          <FileWarning size={13} />
          <span>
            {broken.length} broken {broken.length === 1 ? 'reference' : 'references'} — the target
            asset was deleted, so Unity shows None.
          </span>
        </div>
      )}

      <div className="so-refmap-cols">
        <div className="so-refmap-col">
          <h4>
            <ArrowDownLeft size={11} /> Referenced by
            {incoming !== null && <span className="so-refmap-count">{incoming.length}</span>}
          </h4>
          {incoming !== null && incoming.length === 0 && (
            <div className="so-refmap-empty">Nothing points here yet.</div>
          )}
          {(incoming ?? []).map((hit) => (
            <div
              key={hit.path}
              className="so-refmap-row"
              title={hit.path}
              onClick={() => openFile(hit.path, hit.path.split('/').pop() ?? hit.path)}
            >
              <span className="scene-usage-scene-name">{hit.path.split('/').pop()}</span>
              {hit.count > 1 && <span className="so-refmap-count">{hit.count}</span>}
            </div>
          ))}
        </div>

        <div className="so-refmap-col">
          <h4>
            <ArrowUpRight size={11} /> References out
            <span className="so-refmap-count">{outgoing.length}</span>
          </h4>
          {outgoing.length === 0 && !loading && (
            <div className="so-refmap-empty">References nothing.</div>
          )}
          {outgoing.map((link) => (
            <div
              key={`${link.via}-${link.guid}`}
              className={`so-refmap-row${link.target ? '' : ' so-refmap-row-broken'}`}
              title={link.target ?? `Unresolved guid ${link.guid}`}
              onClick={() =>
                link.target && openFile(link.target, link.target.split('/').pop() ?? link.target)
              }
            >
              <span className="scene-usage-scene-name">
                {link.target ? link.target.split('/').pop() : `missing · ${link.guid.slice(0, 8)}…`}
              </span>
              <span className="so-refmap-via">{link.via}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default SoReferenceMap;
