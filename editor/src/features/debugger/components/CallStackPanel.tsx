import { useDebugStore } from '../../../stores/debug';
import { useWorkspaceStore } from '../../../stores/workspace';

/** Call stack of the paused thread. Clicking a frame opens its source + selects it. */
export function CallStackPanel() {
  const frames = useDebugStore((s) => s.frames);
  const currentFrameId = useDebugStore((s) => s.currentFrameId);
  const status = useDebugStore((s) => s.status);

  if (status !== 'paused') {
    return <div className="dbg-section-empty">Not paused.</div>;
  }
  if (frames.length === 0) {
    return <div className="dbg-section-empty">No stack frames.</div>;
  }

  const openFrame = async (frame: (typeof frames)[number]) => {
    await useDebugStore.getState().selectFrame(frame.id);
    if (frame.path) {
      const name = frame.path.split('/').pop() ?? frame.path;
      await useWorkspaceStore.getState().openFile(frame.path, name);
      window.dispatchEvent(
        new CustomEvent('navigate-to-line', { detail: { line: frame.line, column: frame.column } }),
      );
    }
  };

  return (
    <ul className="dbg-callstack">
      {frames.map((f) => (
        <li
          key={f.id}
          className={`dbg-frame${f.id === currentFrameId ? ' active' : ''}`}
          onClick={() => void openFrame(f)}
          title={f.path ?? ''}
        >
          <span className="dbg-frame-name">{f.name}</span>
          {f.path && (
            <span className="dbg-frame-loc">
              {f.path.split('/').pop()}:{f.line}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
