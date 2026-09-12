import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Gamepad2,
  ChevronRight,
  AlertTriangle,
  Keyboard,
  Mouse,
  Smartphone,
  Glasses,
  Joystick,
  Asterisk,
  Search,
  CornerDownRight,
} from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import {
  parseInputActions,
  listActions,
  listControlSchemes,
  findBindingConflicts,
  setBindingPath,
  serializeInputActions,
  type ResolvedAction,
  type BindingNode,
  type InputBinding,
} from '../../../utils/inputactions-model';
import {
  buildActionReferenceIndex,
  buildWrapperCatalog,
  type ActionReference,
} from '../services/action-refs';
import { gotoActionReference } from '../services/goto-usage';
import { buildInputGraph, graphSummary } from '../services/input-graph';
import { loadInputAssetContext, type InputAssetContext } from '../services/input-context';
import { ControlsView, CoverageView } from './InputMapViews';

/** Which question the panel is answering. One graph, three pivots. */
type Pivot = 'actions' | 'controls' | 'coverage';

interface Props {
  name: string;
  /** Raw `.inputactions` JSON, from the live Monaco buffer rather than disk. */
  content: string;
  /**
   * Escape hatch for an unparseable file ONLY.
   *
   * The header's View Raw / Edit Raw buttons are deliberately gone: this view
   * is the editor for `.inputactions`, and hand-editing the JSON is how GUIDs
   * and binding ids get broken. When the JSON does not parse there is nothing
   * to show, so raw stays reachable there and nowhere else.
   */
  onViewRaw: () => void;
}

export function isInputActionsFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.inputactions');
}

/** Sentinel filter value meaning "every scheme". */
const ALL_SCHEMES = ' all';

const DEVICE_ICONS: Array<[RegExp, typeof Keyboard]> = [
  [/^Keyboard$/, Keyboard],
  [/^(Mouse|Pointer|Pen)$/, Mouse],
  [/^(Gamepad|DualShock|DualSense|XInput)/, Gamepad2],
  [/^(Touchscreen|Touch)/, Smartphone],
  [/^(XR|Oculus|WMR|Vive)/, Glasses],
  [/^Joystick$/, Joystick],
];

function DeviceIcon({ device, size = 11 }: { device: string; size?: number }) {
  const entry = DEVICE_ICONS.find(([re]) => re.test(device));
  const Icon = entry?.[1] ?? Asterisk;
  return <Icon size={size} />;
}

interface EditState {
  id: string;
  value: string;
}

/**
 * Structured editor for `.inputactions` assets.
 *
 * Two decisions shape this screen, both forced by real Unity assets rather
 * than by taste:
 *
 * 1. **A composite is one binding, not eight.** Unity stores `WASD` as a
 *    parent row plus eight part rows. Rendering the parts as peers of
 *    `<Gamepad>/leftStick` turned Unity's own default asset into 69 loose
 *    chips; grouping them is 45 rows, and it matches what the user actually
 *    configured.
 * 2. **A control scheme is the primary filter.** Even grouped, showing every
 *    device at once is unreadable -- `UI/Navigate` alone binds 21 controls.
 *    Filtered to one scheme it is a single row. "What does the gamepad do?"
 *    is the question a game developer actually asks, and the one Unity's own
 *    Input Actions window answers worst.
 *
 * Clicking a binding navigates to the C# that handles it. A binding path has
 * no call site of its own -- C# resolves an action by NAME -- so the click
 * resolves to the ACTION's references. See `services/goto-usage.ts`.
 */
export function InputActionsEditor({ name, content, onViewRaw }: Props) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const filePath = useWorkspaceStore((s) => s.activeFilePath);
  const [refs, setRefs] = useState<Map<string, ActionReference[]>>(new Map());
  const [refsState, setRefsState] = useState<'loading' | 'ready'>('loading');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scheme, setScheme] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EditState | null>(null);
  const [pivot, setPivot] = useState<Pivot>('actions');
  const [usesActionRefs, setUsesActionRefs] = useState(false);
  const [context, setContext] = useState<InputAssetContext>({
    wrapper: null,
    assetReferencedByScene: false,
  });

  // Wrapper settings and scene references both live outside the asset, and both
  // change what the panel is allowed to CLAIM -- see `input-context.ts`.
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    void loadInputAssetContext(filePath, workspacePath).then((next) => {
      if (!cancelled) setContext(next);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, workspacePath]);

  const parsed = useMemo(() => parseInputActions(content), [content]);
  const actions = useMemo(() => (parsed.doc ? listActions(parsed.doc) : []), [parsed.doc]);
  const schemes = useMemo(() => (parsed.doc ? listControlSchemes(parsed.doc) : []), [parsed.doc]);
  const conflicts = useMemo(
    () => (parsed.doc ? findBindingConflicts(parsed.doc) : []),
    [parsed.doc],
  );

  // Default to the asset's first scheme rather than to everything: that is the
  // difference between 20 rows and 69, and the pill row keeps the filter and
  // what it left out both visible.
  const activeScheme = scheme ?? schemes[0] ?? ALL_SCHEMES;

  const starved = useMemo(() => {
    const set = new Set<string>();
    for (const conflict of conflicts) for (const q of conflict.starved) set.add(q);
    return set;
  }, [conflicts]);

  /** A binding with no groups belongs to every scheme, so it always shows. */
  const inScheme = useCallback(
    (node: BindingNode) =>
      activeScheme === ALL_SCHEMES ||
      node.schemes.length === 0 ||
      node.schemes.includes(activeScheme),
    [activeScheme],
  );

  const schemeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let all = 0;
    for (const action of actions) {
      for (const node of action.bindings) {
        all++;
        const reach = node.schemes.length === 0 ? schemes : node.schemes;
        for (const s of reach) counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
    counts.set(ALL_SCHEMES, all);
    return counts;
  }, [actions, schemes]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      actions.filter(
        (a) =>
          needle === '' ||
          a.name.toLowerCase().includes(needle) ||
          a.mapName.toLowerCase().includes(needle) ||
          a.bindings.some((b) => b.label.toLowerCase().includes(needle)),
      ),
    [actions, needle],
  );

  // Walking the project's C# is the expensive part, so this keys on the action
  // identities: retyping a binding path must not re-scan thousands of files.
  //
  // Newline-separated, not space-separated. Action names may contain spaces
  // ("Move Camera"), and the previous `join(' ')`/`split(' ')` round trip turned
  // one such action into two bogus names -- so the scan looked for "Move" and
  // "Camera" and found neither. Map name is carried too, because the generated
  // wrapper is addressed as `controls.<Map>.<Action>`.
  const catalogKey = useMemo(
    () => [...new Set(actions.map((a) => `${a.mapName}\n${a.name}`))].sort().join('\u0000'),
    [actions],
  );

  useEffect(() => {
    if (!workspacePath || catalogKey === '') {
      setRefsState('ready');
      return;
    }
    const pairs = catalogKey.split('\u0000').map((entry) => {
      const nl = entry.indexOf('\n');
      return { mapName: entry.slice(0, nl), name: entry.slice(nl + 1) };
    });
    const names = [...new Set(pairs.map((p) => p.name))];
    let cancelled = false;
    setRefsState('loading');
    buildActionReferenceIndex(workspacePath, names, buildWrapperCatalog(pairs))
      .then((index) => {
        if (cancelled) return;
        setRefs(index.byActionName);
        setUsesActionRefs(index.usesInputActionReference);
        setRefsState('ready');
      })
      .catch(() => {
        if (!cancelled) setRefsState('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, catalogKey]);

  const totalRefs = useMemo(() => {
    let n = 0;
    for (const list of refs.values()) n += list.length;
    return n;
  }, [refs]);

  /**
   * Point one binding at a different control.
   *
   * Goes through `setBindingPath` + `serializeInputActions`, which preserve the
   * binding's GUID, the file's key order, and its exact indent and
   * trailing-newline habit -- so this lands as a ONE LINE git diff rather than
   * a reformat of the whole asset. The result is handed to `updateFileContent`
   * rather than written straight to disk, which puts it in the normal
   * dirty-tab flow: visible, undoable, saved with the same Cmd+S as any other
   * edit.
   */
  const commitRebind = useCallback(() => {
    if (!editing || !filePath || !parsed.doc) {
      setEditing(null);
      return;
    }
    const next = setBindingPath(parsed, editing.id, editing.value.trim());
    const text = serializeInputActions(next);
    if (text && text !== content) {
      useWorkspaceStore.getState().updateFileContent(filePath, text);
    }
    setEditing(null);
  }, [editing, filePath, parsed, content]);

  const openReferences = useCallback(
    (action: ResolvedAction) => {
      const hits = refs.get(action.name) ?? [];
      // "Go to usage" almost always means "show me what runs", so a single
      // unambiguous handler wins over a lookup site. Anything less clear-cut
      // opens the list and lets the user choose.
      const handlers = hits.filter((h) => h.kind === 'handler');
      if (handlers.length === 1) {
        void gotoActionReference(handlers[0]);
        return;
      }
      if (hits.length === 1) {
        void gotoActionReference(hits[0]);
        return;
      }
      setExpanded((cur) => (cur === action.qualifiedName ? null : action.qualifiedName));
    },
    [refs],
  );

  const toggle = useCallback((qualifiedName: string) => {
    setExpanded((cur) => (cur === qualifiedName ? null : qualifiedName));
  }, []);

  if (parsed.error) {
    return (
      <div className="editor-container" style={SHELL}>
        <Header name={name} subtitle="input actions" />
        <div style={{ padding: 14, color: 'var(--error-text)', fontSize: 13, lineHeight: 1.5 }}>
          This file is not valid JSON, so it cannot be shown as actions.
          <div
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, marginTop: 6, opacity: 0.85 }}
          >
            {parsed.error}
          </div>
          <button className="asset-viewer-btn" style={{ marginTop: 10 }} onClick={onViewRaw}>
            View Raw
          </button>
        </div>
      </div>
    );
  }

  const maps = parsed.doc?.maps ?? [];

  // One model, three pivots. Assembled here because everything it needs -- the
  // asset, the C# reference index and the out-of-asset context -- converges in
  // this component and nowhere else.
  const graph = useMemo(
    () =>
      buildInputGraph({
        asset: filePath ?? name,
        actions,
        conflicts,
        schemes,
        refs,
        suppressors: {
          assetReferencedByScene: context.assetReferencedByScene,
          usesInputActionReference: usesActionRefs,
        },
        // Until the walk finishes, "no reference" means "not looked yet".
        scanned: refsState === 'ready',
        wrapper: context.wrapper,
      }),
    [filePath, name, actions, conflicts, schemes, refs, context, usesActionRefs, refsState],
  );
  const summary = useMemo(() => graphSummary(graph), [graph]);

  return (
    <div className="editor-container" style={SHELL}>
      <Header
        name={name}
        subtitle={`${maps.length} ${maps.length === 1 ? 'map' : 'maps'}, ${actions.length} actions`}
        unread={summary.unread}
        wrapper={graph.wrapper?.className ?? null}
        conflicts={conflicts.length}
      />

      <div style={TOOLBAR}>
        <div style={PILL_ROW} role="group" aria-label="View">
          {(
            [
              ['actions', 'Actions'],
              ['controls', 'Controls'],
              ['coverage', 'Coverage'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={pivot === id}
              onClick={() => setPivot(id)}
              style={{ ...PILL, ...(pivot === id ? PILL_ON : null) }}
            >
              {label}
            </button>
          ))}
        </div>

        <label style={SEARCH_WRAP}>
          <Search size={12} style={{ opacity: 0.6, flexShrink: 0 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter actions and bindings"
            style={SEARCH_INPUT}
          />
        </label>

        {schemes.length > 0 && (
          <div style={PILL_ROW} role="group" aria-label="Control scheme">
            {[...schemes, ALL_SCHEMES].map((s) => {
              const on = activeScheme === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScheme(s)}
                  aria-pressed={on}
                  style={{ ...PILL, ...(on ? PILL_ON : null) }}
                >
                  {s === ALL_SCHEMES ? 'All devices' : s}
                  <span style={{ opacity: 0.55, marginLeft: 5 }}>{schemeCounts.get(s) ?? 0}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {refsState === 'ready' && totalRefs === 0 && actions.length > 0 && (
        <p style={NOTICE}>
          No script reaches these actions. <code>FindAction("...")</code>,{' '}
          <code>actions["..."]</code>, <code>OnX</code> handlers and generated-wrapper access like{' '}
          <code>controls.Player.Jump</code> are all tracked. Actions built in code with{' '}
          <code>new InputAction(...)</code>, or wired through an{' '}
          <code>InputActionReference</code> in the Inspector, leave no trace here — those show as{' '}
          <em>may be wired in the Inspector</em> rather than as unread.
        </p>
      )}

      {pivot === 'controls' && <ControlsView graph={graph} />}
      {pivot === 'coverage' && <CoverageView graph={graph} />}

      {pivot === 'actions' && (
      <div style={{ overflow: 'auto', flex: 1 }}>
        {maps.map((map) => {
          const rows = visible.filter((a) => a.mapName === map.name);
          if (rows.length === 0) return null;
          return (
            <section key={map.id || map.name}>
              <h3 style={MAP_HEADING}>
                {map.name}
                <span style={{ color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 7 }}>
                  {rows.length}
                </span>
              </h3>

              {rows.map((action) => {
                const hits = refs.get(action.name) ?? [];
                const shown = action.bindings.filter(inScheme);
                const isOpen = expanded === action.qualifiedName;
                const isStarved = starved.has(action.qualifiedName);
                return (
                  <div key={action.id || action.qualifiedName}>
                    <div
                      style={{ ...ROW, ...(isOpen ? ROW_OPEN : null) }}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggle(action.qualifiedName)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle(action.qualifiedName);
                        }
                      }}
                    >
                      <ChevronRight
                        size={12}
                        style={{
                          opacity: 0.45,
                          transform: isOpen ? 'rotate(90deg)' : 'none',
                          transition: 'transform 120ms ease',
                        }}
                      />
                      <span
                        style={{
                          ...ACTION_NAME,
                          color: isStarved ? 'var(--error-text)' : 'var(--accent)',
                        }}
                        title={action.qualifiedName}
                      >
                        {action.name}
                      </span>
                      <span
                        style={TYPE_CELL}
                        title={`${action.type}${
                          action.expectedControlType
                            ? ` control type ${action.expectedControlType}`
                            : ''
                        }`}
                      >
                        {action.type}
                        {action.expectedControlType && action.expectedControlType !== action.type
                          ? ` / ${action.expectedControlType}`
                          : ''}
                      </span>
                      <span style={BINDING_CELL}>
                        {shown.length === 0 ? (
                          <span style={{ ...META, fontStyle: 'italic' }}>not bound here</span>
                        ) : (
                          <>
                            <BindingToken node={shown[0]} starved={isStarved} />
                            {shown.length > 1 && <span style={MORE}>+{shown.length - 1}</span>}
                          </>
                        )}
                      </span>
                      <span style={ROW_TAIL}>
                        {isStarved && (
                          <span
                            style={CONFLICT_CHIP}
                            title="Another action in this map claims the same control"
                          >
                            <AlertTriangle size={9} /> never fires
                          </span>
                        )}
                        {hits.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openReferences(action);
                            }}
                            style={REF_BADGE}
                            title={`Go to the ${hits.length} C# reference${
                              hits.length === 1 ? '' : 's'
                            } to ${action.qualifiedName}`}
                          >
                            {hits.length} in code
                          </button>
                        )}
                      </span>
                    </div>

                    {isOpen && (
                      <BindingDetail
                        action={action}
                        nodes={shown}
                        hits={hits}
                        refsLoading={refsState === 'loading'}
                        onGoto={gotoActionReference}
                        editing={editing}
                        onEdit={setEditing}
                        onCommit={commitRebind}
                        canEdit={Boolean(filePath)}
                      />
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}

        {visible.length === 0 && (
          <p style={NOTICE}>
            Nothing matches that filter. Try an action name like <code>Jump</code>, or part of a
            binding path like <code>buttonSouth</code>.
          </p>
        )}
      </div>
      )}
    </div>
  );
}

// -- Pieces -------------------------------------------------------------------

function Header({
  name,
  subtitle,
  conflicts = 0,
  unread = 0,
  wrapper = null,
}: {
  name: string;
  subtitle: string;
  conflicts?: number;
  unread?: number;
  wrapper?: string | null;
}) {
  return (
    <div style={HEADER}>
      <Gamepad2 size={14} style={{ color: 'var(--accent)' }} />
      <span style={{ color: 'var(--text-primary)' }}>{name}</span>
      <span style={{ opacity: 0.7 }}>{subtitle}</span>
      {conflicts > 0 && (
        <span style={CONFLICT_CHIP}>
          <AlertTriangle size={9} /> {conflicts} conflict{conflicts === 1 ? '' : 's'}
        </span>
      )}
      {unread > 0 && (
        <span style={CONFLICT_CHIP} title="No C# reads these actions, and nothing suggests they are wired elsewhere">
          {unread} unread
        </span>
      )}
      {wrapper && (
        <span
          style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
          title="This asset generates a C# wrapper class, so access through it is tracked"
        >
          wrapper: {wrapper}
        </span>
      )}
    </div>
  );
}

/** One binding as a token: the composite's name, or the control path. */
function BindingToken({ node, starved }: { node: BindingNode; starved: boolean }) {
  return (
    <span
      style={{
        ...TOKEN,
        ...(starved ? { borderColor: 'var(--error-border)', color: 'var(--error-text)' } : null),
      }}
      title={node.isComposite ? `${node.label} composite, ${node.parts.length} parts` : node.label}
    >
      {node.devices[0] && <DeviceIcon device={node.devices[0]} />}
      {node.label}
      {node.isComposite && <span style={{ opacity: 0.5 }}>{node.parts.length}</span>}
    </span>
  );
}

/** One editable control path. Enter commits, Escape abandons. */
function PathField({
  binding,
  editing,
  onEdit,
  onCommit,
  canEdit,
  children,
}: {
  binding: InputBinding;
  editing: EditState | null;
  onEdit: (next: EditState | null) => void;
  onCommit: () => void;
  canEdit: boolean;
  children: React.ReactNode;
}) {
  if (editing?.id === binding.id) {
    return (
      <input
        autoFocus
        value={editing.value}
        onChange={(e) => onEdit({ id: binding.id, value: e.target.value })}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onEdit(null);
          }
        }}
        spellCheck={false}
        style={PATH_INPUT}
        aria-label="Control path"
      />
    );
  }
  if (!canEdit) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={() => onEdit({ id: binding.id, value: binding.path ?? '' })}
      title={`Rebind ${binding.path}`}
      style={PATH_BUTTON}
    >
      {children}
    </button>
  );
}

function BindingDetail({
  action,
  nodes,
  hits,
  refsLoading,
  onGoto,
  editing,
  onEdit,
  onCommit,
  canEdit,
}: {
  action: ResolvedAction;
  nodes: BindingNode[];
  hits: ActionReference[];
  refsLoading: boolean;
  onGoto: (ref: ActionReference) => void;
  editing: EditState | null;
  onEdit: (next: EditState | null) => void;
  onCommit: () => void;
  canEdit: boolean;
}) {
  return (
    <div style={DETAIL}>
      {nodes.length === 0 ? (
        <p style={{ ...META, margin: 0 }}>
          {action.name} has no binding for this control scheme. Switch to All devices to see its
          other bindings.
        </p>
      ) : (
        nodes.map((node) => (
          <div key={node.binding.id} style={{ marginBottom: node.isComposite ? 6 : 2 }}>
            <div style={DETAIL_ROW}>
              {/* A composite parent holds no control of its own; its PARTS are
                  what you rebind, so only they get an editable field. */}
              {node.isComposite ? (
                <BindingToken node={node} starved={false} />
              ) : (
                <PathField
                  binding={node.binding}
                  editing={editing}
                  onEdit={onEdit}
                  onCommit={onCommit}
                  canEdit={canEdit}
                >
                  <BindingToken node={node} starved={false} />
                </PathField>
              )}
              {node.schemes.length > 0 && <span style={META}>{node.schemes.join(', ')}</span>}
            </div>
            {node.parts.length > 0 && (
              <div style={PART_LIST}>
                {node.parts.map((part) => (
                  <div key={part.id} style={PART_ROW}>
                    <span style={PART_NAME}>{part.name}</span>
                    <PathField
                      binding={part}
                      editing={editing}
                      onEdit={onEdit}
                      onCommit={onCommit}
                      canEdit={canEdit}
                    >
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                        {part.path}
                      </span>
                    </PathField>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}

      {(action.interactions || action.processors) && (
        <div style={{ ...META, marginTop: 6 }}>
          {action.interactions ? `Interactions: ${action.interactions}. ` : ''}
          {action.processors ? `Processors: ${action.processors}.` : ''}
        </div>
      )}

      {hits.length > 0 && (
        <div style={REF_BLOCK}>
          <RefGroup
            label="Runs when it fires"
            hint="The method the action invokes. This is the behaviour, not the lookup."
            hits={hits.filter((h) => h.kind === 'handler')}
            onGoto={onGoto}
            emphasis
          />
          <RefGroup
            label="Referenced in"
            hint={`Bindings resolve by action name, so every binding on ${action.qualifiedName} reaches these.`}
            hits={hits.filter((h) => h.kind !== 'handler')}
            onGoto={onGoto}
          />
        </div>
      )}

      {refsLoading && (
        <div style={{ ...META, marginTop: 6 }}>Scanning the project for references.</div>
      )}
    </div>
  );
}

/**
 * One labelled group of references.
 *
 * The split is the point: a handler and a lookup are different answers to
 * different questions, and flattening them into one list is what made "where
 * is this used?" land on a `FindAction` line rather than on the code that
 * actually runs.
 */
function RefGroup({
  label,
  hint,
  hits,
  onGoto,
  emphasis = false,
}: {
  label: string;
  hint: string;
  hits: ActionReference[];
  onGoto: (ref: ActionReference) => void;
  emphasis?: boolean;
}) {
  if (hits.length === 0) return null;
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ ...GROUP_LABEL, color: emphasis ? 'var(--accent-secondary)' : undefined }}>
        {label}
        <span style={{ opacity: 0.6, marginLeft: 5 }}>{hits.length}</span>
      </div>
      <div style={{ ...META, marginBottom: 3 }}>{hint}</div>
      {hits.map((hit) => (
        <button
          key={`${hit.kind}:${hit.filePath}:${hit.line}:${hit.column}`}
          type="button"
          onClick={() => void onGoto(hit)}
          style={REF_ROW}
        >
          <CornerDownRight size={10} style={{ opacity: 0.45, flexShrink: 0 }} />
          <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {hit.filePath.split('/').pop()}:{hit.line}
          </span>
          {hit.phase && (
            <span style={PHASE_TAG} title={`Fires on ${hit.phase}`}>
              {hit.phase}
            </span>
          )}
          <span style={REF_SNIPPET}>{hit.snippet}</span>
        </button>
      ))}
    </div>
  );
}

// -- Styles. Chrome uses global classes; content uses theme tokens inline,
//    matching the other structured asset viewers. ----------------------------

const SHELL: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%' };

const HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 10px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
  color: 'var(--text-secondary)',
  flexShrink: 0,
};

const TOOLBAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  flexWrap: 'wrap',
  flexShrink: 0,
};

const SEARCH_WRAP: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  minWidth: 170,
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
};

const SEARCH_INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'none',
  border: 0,
  outline: 'none',
  color: 'var(--text-primary)',
  font: 'inherit',
  fontSize: 11.5,
};

const PILL_ROW: React.CSSProperties = { display: 'flex', gap: 3, flexWrap: 'wrap' };

const PILL: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 'var(--radius-full)',
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
};

const PILL_ON: React.CSSProperties = {
  background: 'var(--badge-bg)',
  borderColor: 'var(--ghost-border)',
  color: 'var(--accent-secondary)',
};

const NOTICE: React.CSSProperties = {
  margin: 0,
  padding: '9px 12px',
  fontSize: 11.5,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border)',
};

const MAP_HEADING: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  margin: 0,
  padding: '7px 12px 5px',
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  color: 'var(--text-primary)',
  background: 'var(--bg-primary)',
  borderBottom: '1px solid var(--border)',
};

const ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '14px minmax(96px, 168px) 136px minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 10,
  padding: '4px 12px',
  cursor: 'pointer',
  borderBottom: '1px solid rgba(255,255,255,0.025)',
};

const ROW_OPEN: React.CSSProperties = { background: 'var(--hover)' };

const ACTION_NAME: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const META: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: 11 };

const TYPE_CELL: React.CSSProperties = {
  ...META,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const BINDING_CELL: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
};

const TOKEN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: '100%',
  padding: '1px 6px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-container-high)',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const MORE: React.CSSProperties = { ...META, fontSize: 10, flexShrink: 0 };

const ROW_TAIL: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  justifySelf: 'end',
};

const CONFLICT_CHIP: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--error-bg)',
  border: '1px solid var(--error-border)',
  color: 'var(--error-text)',
  whiteSpace: 'nowrap',
};

const REF_BADGE: React.CSSProperties = {
  padding: '1px 7px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--badge-bg)',
  border: '1px solid var(--ghost-border)',
  color: 'var(--accent-secondary)',
  fontSize: 10,
  fontFamily: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const DETAIL: React.CSSProperties = {
  padding: '8px 12px 10px 36px',
  background: 'rgba(0,0,0,0.16)',
  borderBottom: '1px solid var(--border)',
};

const DETAIL_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };

const PART_LIST: React.CSSProperties = {
  marginTop: 3,
  marginLeft: 10,
  paddingLeft: 9,
  borderLeft: '1px solid var(--border)',
};

const PART_ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '52px 1fr',
  gap: 8,
  padding: '1px 0',
  alignItems: 'center',
  color: 'var(--text-secondary)',
};

const PART_NAME: React.CSSProperties = { fontSize: 10.5, color: 'var(--text-secondary)' };

const PATH_BUTTON: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 0,
  background: 'none',
  border: 0,
  cursor: 'text',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  maxWidth: '100%',
};

const PATH_INPUT: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  padding: '1px 6px',
  minWidth: 220,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)',
  border: '1px solid var(--accent)',
  color: 'var(--text-primary)',
  outline: 'none',
};

const REF_BLOCK: React.CSSProperties = {
  marginTop: 8,
  paddingTop: 7,
  borderTop: '1px solid var(--border)',
};

const GROUP_LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
  marginBottom: 2,
};

const PHASE_TAG: React.CSSProperties = {
  fontSize: 9.5,
  padding: '0 4px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--surface-container-high)',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  flexShrink: 0,
};

const REF_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '2px 4px',
  background: 'none',
  border: 0,
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  textAlign: 'left',
  color: 'var(--text-primary)',
};

const REF_SNIPPET: React.CSSProperties = {
  color: 'var(--text-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export default InputActionsEditor;
