import { useState } from 'react';
import { CircleDot, X } from 'lucide-react';
import { useDebugStore } from '../../../stores/debug';
import { recordJumpOrigin } from '../../../utils/jump-history';
import { useWorkspaceStore } from '../../../stores/workspace';

/**
 * Every breakpoint in the project, and the only place conditions, hit counts
 * and logpoints can be edited.
 *
 * `setBreakpointCondition` existed in the store with no caller at all, so those
 * three features were reachable from nowhere in the UI — the store carried them
 * and the panels never offered them.
 */
export function BreakpointsPanel() {
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const toggle = useDebugStore((s) => s.toggleBreakpoint);
  const setCondition = useDebugStore((s) => s.setBreakpointCondition);
  const [editing, setEditing] = useState<string | null>(null);

  const rows = Array.from(breakpoints.entries()).flatMap(([file, list]) =>
    list.map((bp) => ({ file, bp })),
  );

  if (rows.length === 0) {
    return <div className="dbg-section-empty">No breakpoints. Click a line's gutter to add one.</div>;
  }

  const openAt = (file: string, line: number) => {
    recordJumpOrigin();
    const name = file.split(/[\\/]/).pop() ?? file;
    void useWorkspaceStore
      .getState()
      .openFile(file, name)
      .then(() => {
        window.dispatchEvent(new CustomEvent('navigate-to-line', { detail: { line, column: 1 } }));
      });
  };

  return (
    <div className="dbg-breakpoints">
      {rows.map(({ file, bp }) => {
        const key = `${file}:${bp.line}`;
        const name = file.split(/[\\/]/).pop() ?? file;
        return (
          <div className="dbg-bp-row" key={key}>
            <div className="dbg-bp-main">
              <CircleDot
                size={12}
                className={bp.verified ? 'dbg-bp-dot' : 'dbg-bp-dot dbg-bp-dot--pending'}
              />
              <button className="dbg-bp-location" onClick={() => openAt(file, bp.line)}>
                {name}:{bp.line}
              </button>
              <button
                className="dbg-bp-edit"
                onClick={() => setEditing(editing === key ? null : key)}
                title="Condition, hit count and logpoint"
              >
                {bp.condition || bp.hitCondition || bp.logMessage ? 'edit…' : '+'}
              </button>
              <button
                className="dbg-bp-remove"
                onClick={() => toggle(file, bp.line)}
                title="Remove breakpoint"
                aria-label={`Remove breakpoint at ${name}:${bp.line}`}
              >
                <X size={12} />
              </button>
            </div>

            {/* A breakpoint that is set but not yet bound looks identical in the
                gutter to one that is, so the state is spelled out here. */}
            {!bp.verified && (
              <div className="dbg-bp-note">
                not bound yet — binds when the script&apos;s assembly loads
              </div>
            )}

            {editing === key && (
              <div className="dbg-bp-editor">
                <label>
                  Condition
                  <input
                    defaultValue={bp.condition ?? ''}
                    placeholder="health &lt;= 0"
                    onBlur={(e) =>
                      setCondition(file, bp.line, e.target.value || undefined, bp.hitCondition, bp.logMessage)
                    }
                  />
                </label>
                <label>
                  Hit count
                  <input
                    defaultValue={bp.hitCondition ?? ''}
                    placeholder="&gt;= 5, == 3, % 10"
                    onBlur={(e) =>
                      setCondition(file, bp.line, bp.condition, e.target.value || undefined, bp.logMessage)
                    }
                  />
                </label>
                <label>
                  Log message
                  <input
                    defaultValue={bp.logMessage ?? ''}
                    placeholder="hp is {health} — prints instead of stopping"
                    onBlur={(e) =>
                      setCondition(file, bp.line, bp.condition, bp.hitCondition, e.target.value || undefined)
                    }
                  />
                </label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
