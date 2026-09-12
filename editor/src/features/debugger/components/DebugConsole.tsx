import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { useDebugStore } from '../../../stores/debug';

/**
 * The debug console: logpoint output, condition failures, and notices from the
 * debug session.
 *
 * The session emitted DAP `output` events before this existed and nothing
 * listened, so a logpoint printed into the void. Everything here is bounded by
 * the store — a logpoint inside `Update()` writes sixty lines a second.
 */
export function DebugConsole() {
  const lines = useDebugStore((s) => s.consoleLines);
  const clear = useDebugStore((s) => s.clearConsole);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Whether the view was pinned to the bottom before this render. Following
  // new output is only helpful while the user has not scrolled up to read
  // something; yanking them back down mid-read is not.
  const pinned = useRef(true);

  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [lines]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="dbg-console">
      <div className="dbg-console-actions">
        <button
          className="dbg-console-clear"
          onClick={clear}
          title="Clear console"
          aria-label="Clear console"
          disabled={lines.length === 0}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="dbg-console-scroll" ref={scroller} onScroll={onScroll}>
        {lines.length === 0 ? (
          <div className="dbg-section-empty">
            Logpoint output appears here. Add one from the Breakpoints panel.
          </div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`dbg-console-line dbg-console-line--${line.category}`}>
              {line.text}
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}
