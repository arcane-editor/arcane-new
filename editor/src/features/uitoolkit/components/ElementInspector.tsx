import { useMemo, useState } from 'react';
import { openExcerptAt } from '../../search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { describeUsage, type ElementUsage } from '../../../utils/uxml-usage';
import { propertyEntries, type CascadeRule, type PropertyEntry, type PropertySource }
  from '../services/cascade';
import { USS_PROPERTY_GROUP_ORDER } from '../../../utils/uss-properties';
import type { RenderNode } from '../services/render-plan';

/**
 * What this element ends up looking like, and what happens when you click it.
 *
 * Two tabs rather than two stacked sections: they answer different questions on
 * different occasions, and stacking them pushed the behaviour below the fold —
 * the half no other tool can show at all.
 *
 * Within Styles, `Applied` leads and the matched rules follow: the resolved
 * value is the answer and the cascade is the working. That is the order browser
 * devtools settled on and it is the right one.
 *
 * Styling lives in `App.css` under `.uxi-*` rather than in module-scope consts,
 * because nearly every row here is clickable and inline styles cannot express
 * `:hover` or `:focus-visible`.
 */

type TabId = 'styles' | 'refs';

export function ElementInspector({
  node,
  usages,
  cascade,
  usagesLoaded,
}: {
  node: RenderNode | null;
  usages: ElementUsage[];
  cascade: CascadeRule[];
  usagesLoaded: boolean;
}) {
  const [tab, setTab] = useState<TabId>('refs');

  const entries = useMemo(
    () => propertyEntries(node?.inlineStyle ?? null, cascade),
    [node?.inlineStyle, cascade],
  );

  const behaviours = usages.filter((u) => u.kind !== 'query');
  const lookups = usages.filter((u) => u.kind === 'query');

  if (!node) {
    return (
      <aside className="uxi">
        <p className="uxi-empty uxi-empty--start">
          Pick an element in the preview to see the rules that style it and the C# that drives it.
        </p>
      </aside>
    );
  }

  /**
   * Open the file, scroll the line into view and flash it.
   *
   * `openExcerptAt` rather than a `navigate-to-line` event: it sets the pending
   * navigation BEFORE the open, so `EditorPanel` consumes it once the tab has
   * actually mounted. Dispatching after the open races the mount and silently
   * drops the scroll — the bug `open-excerpt.ts` documents, and this panel had
   * inherited it. The flash is what makes the landing legible: every jump from
   * here lands in a file the user was not reading, usually among lines that
   * look alike.
   */
  const open = (path: string, line: number, column = 1) => {
    const workspace = useWorkspaceStore.getState().workspacePath;
    const full = path.startsWith('/') || !workspace ? path : `${workspace}/${path}`;
    void openExcerptAt(full, line, column, { highlight: true });
  };

  const authored = node.classes.filter((c) => !/^u-(el|t-|i-)/.test(c) && !c.startsWith('unity-'));
  const generated = node.classes.filter((c) => c.startsWith('unity-'));

  return (
    <aside className="uxi">
      <header className="uxi-head">
        <div className="uxi-identity">
          <span className="uxi-name">{node.name ? `#${node.name}` : `<${node.tag}>`}</span>
          <span className="uxi-type">{node.tag}</span>
        </div>
        {(authored.length > 0 || generated.length > 0) && (
          <div className="uxi-chips">
            {authored.map((c) => (
              <span key={c} className="uxi-chip">.{c}</span>
            ))}
            {/* Added by the control itself. Dimmed so the classes you can go and
                edit are the ones that read first. */}
            {generated.map((c) => (
              <span
                key={c}
                className="uxi-chip uxi-chip--generated"
                title="Added by the control itself"
              >
                .{c}
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="uxi-tabs" role="tablist" aria-label="Element">
        <Tab
          id="refs"
          active={tab}
          onSelect={setTab}
          count={usagesLoaded ? usages.length : null}
        >
          C# references
        </Tab>
        <Tab id="styles" active={tab} onSelect={setTab} count={entries.length}>
          Styles
        </Tab>
      </div>

      <div className="uxi-body" role="tabpanel">
        {tab === 'styles' ? (
          <StylesTab entries={entries} open={open} />
        ) : (
          <RefsTab
            behaviours={behaviours}
            lookups={lookups}
            loaded={usagesLoaded}
            named={node.name !== null}
            open={open}
          />
        )}
      </div>
    </aside>
  );
}

function Tab({
  id,
  active,
  count,
  onSelect,
  children,
}: {
  id: TabId;
  active: TabId;
  count: number | null;
  onSelect: (t: TabId) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={id === active}
      className={`uxi-tab${id === active ? ' active' : ''}`}
      onClick={() => onSelect(id)}
    >
      {children}
      {count !== null && count > 0 && <span className="uxi-tab-count">{count}</span>}
    </button>
  );
}

/** A caption on a hairline — quieter than a heading, still a boundary. */
function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="uxi-section">
      <span>{children}</span>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

/**
 * Every property that applies, grouped by what it decides, each carrying the
 * rule that set it.
 *
 * The panel used to print the resolved values and then every matched rule again
 * underneath — the same facts twice, the second time four times as tall, and
 * still leaving "which rule set this?" to be answered by reading both lists and
 * joining them by eye. Here the answer and its provenance share a row, and the
 * rules a property beat are one click away on that row instead of scattered
 * down the panel.
 */
function StylesTab({
  entries,
  open,
}: {
  entries: PropertyEntry[];
  open: (path: string, line: number, column?: number) => void;
}) {
  if (entries.length === 0) {
    return (
      <p className="uxi-empty">
        No stylesheet rule matches this element, and it carries no inline style.
      </p>
    );
  }

  return (
    <>
      {USS_PROPERTY_GROUP_ORDER.filter((g) => entries.some((e) => e.group === g)).map((group) => (
        <div key={group}>
          <Section>{group}</Section>
          <div className="uxi-props">
            {entries
              .filter((e) => e.group === group)
              .map((entry) => (
                <PropertyRow key={entry.property} entry={entry} open={open} />
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

function PropertyRow({
  entry,
  open,
}: {
  entry: PropertyEntry;
  open: (path: string, line: number, column?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const others = entry.sources.filter((s) => s !== entry.origin);
  const jump = (source: PropertySource) => {
    if (source.sheet) open(source.sheet, source.line);
  };

  return (
    <div className={`uxi-prop-row${entry.value === null ? ' unset' : ''}`}>
      <div className="uxi-prop-line">
        <button
          type="button"
          className="uxi-prop-decl"
          onClick={() => jump(entry.origin)}
          title={sourceTitle(entry.origin)}
        >
          <span className="uxi-prop-name">{entry.property}</span>
          <span className="uxi-prop-colon">:</span>{' '}
          {entry.value !== null ? (
            <span className="uxi-prop-value">{entry.value}</span>
          ) : (
            <>
              <span className="uxi-prop-value struck">{entry.origin.value}</span>
              <span className="uxi-prop-tag">
                {entry.origin.state === 'dropped' ? 'dropped by Unity' : 'state only'}
              </span>
            </>
          )}
        </button>
        <span className="uxi-prop-origin" title={sourceTitle(entry.origin)}>
          {entry.origin.selector}
        </span>
        {others.length > 0 && (
          <button
            type="button"
            className={`uxi-prop-more${expanded ? ' open' : ''}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            title={`${others.length} more rule${others.length === 1 ? '' : 's'} set this property`}
          >
            +{others.length}
          </button>
        )}
      </div>

      {expanded &&
        others.map((source, i) => (
          <button
            key={`${source.selector}:${source.line}:${i}`}
            type="button"
            className={`uxi-prop-source ${source.state}`}
            onClick={() => jump(source)}
            title={source.note ?? sourceTitle(source)}
          >
            <span className="uxi-prop-source-mark">{MARKS[source.state]}</span>
            <span className="uxi-prop-source-value">{source.value}</span>
            <span className="uxi-prop-source-sel">{source.selector}</span>
            <span className="uxi-where">
              {source.sheet === null ? 'inline' : `${source.sheet.split('/').pop()}:${source.line}`}
            </span>
          </button>
        ))}
    </div>
  );
}

const MARKS: Record<PropertySource['state'], string> = {
  winner: '',
  overridden: '✕',
  state: '~',
  dropped: '!',
};

function sourceTitle(source: PropertySource): string {
  const where =
    source.sheet === null ? 'inline on this element' : `${source.sheet}:${source.line}`;
  return `${source.selector} — ${where}`;
}

// ── References ───────────────────────────────────────────────────────────────

function RefsTab({
  behaviours,
  lookups,
  loaded,
  named,
  open,
}: {
  behaviours: ElementUsage[];
  lookups: ElementUsage[];
  loaded: boolean;
  named: boolean;
  open: (path: string, line: number, column?: number) => void;
}) {
  if (!named) {
    return (
      <p className="uxi-empty">
        This element has no <code>name</code>, so no C# can reach it with <code>Q()</code>. Give it
        one in the UXML to wire it up.
      </p>
    );
  }
  if (!loaded) return <p className="uxi-empty">Reading the project’s C#…</p>;
  if (behaviours.length === 0 && lookups.length === 0) {
    return <p className="uxi-empty">Nothing in this project reaches this element by name.</p>;
  }

  return (
    <>
      {behaviours.length > 0 && <Section>What happens</Section>}
      <div className="uxi-refs">
        {behaviours.map((u, i) => (
          <button
            key={`${u.filePath}:${u.line}:${i}`}
            type="button"
            className={`uxi-ref${u.kind === 'mutation' ? ' uxi-ref--mutation' : ''}`}
            // The wiring line, not the handler's declaration: this row answers
            // "where is this element used", and the caret lands on the name
            // literal itself. The handler is then one go-to-definition away,
            // which is where the user is already looking.
            onClick={() => open(u.filePath, u.line, u.column)}
            title={
              u.handlerLine === null
                ? u.snippet
                : `${u.snippet}\n\n${u.handler} is declared at line ${u.handlerLine}`
            }
          >
            <span className="uxi-ref-mark">{u.kind === 'mutation' ? '✎' : '→'}</span>
            <span className="uxi-ref-text">{describeUsage(u)}</span>
            <span className="uxi-where">
              {u.filePath.split('/').pop()}:{u.line}
            </span>
          </button>
        ))}
      </div>

      {lookups.length > 0 && (
        <>
          <Section>
            {behaviours.length > 0 ? 'Also looked up in' : 'Looked up, nothing attached'}
          </Section>
          <div className="uxi-refs">
            {lookups.map((u, i) => (
              <button
                key={`${u.filePath}:${u.line}:${i}`}
                type="button"
                className="uxi-ref uxi-ref--quiet"
                onClick={() => open(u.filePath, u.line, u.column)}
                title={u.snippet}
              >
                <span className="uxi-ref-mark">·</span>
                <span className="uxi-ref-text">{u.snippet}</span>
                <span className="uxi-where">
                  {u.filePath.split('/').pop()}:{u.line}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
