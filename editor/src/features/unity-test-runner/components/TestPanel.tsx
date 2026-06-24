import { useEffect, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Play,
  Bug,
  RefreshCw,
  CheckCircle2,
  XCircle,
  CircleDashed,
  Circle,
  LoaderCircle,
} from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUnityStore } from '../../../stores/unity';
import {
  useTestStore,
  type TestMode,
  type TestNode,
  type TestStatus,
  type TestFixtureDTO,
} from '../stores/test-store';

function openAt(filePath: string, line: number) {
  const name = filePath.split('/').pop() || filePath;
  void useWorkspaceStore
    .getState()
    .openFile(filePath, name)
    .then(() => {
      setTimeout(
        () => window.dispatchEvent(new CustomEvent('navigate-to-line', { detail: { line, column: 1 } })),
        60,
      );
    });
}

function StatusIcon({ status }: { status: TestStatus }) {
  switch (status) {
    case 'passed':
      return <CheckCircle2 size={13} style={{ color: 'var(--git-added, #4caf50)' }} />;
    case 'failed':
      return <XCircle size={13} style={{ color: 'var(--error-text)' }} />;
    case 'skipped':
      return <CircleDashed size={13} style={{ color: 'var(--text-secondary)' }} />;
    case 'running':
      return <LoaderCircle size={13} className="spin" style={{ color: 'var(--info)' }} />;
    default:
      return <Circle size={13} style={{ color: 'var(--text-secondary)', opacity: 0.5 }} />;
  }
}

function TestRow({ test }: { test: TestNode }) {
  const result = useTestStore((s) => s.results.get(test.fullName));
  const runFiltered = useTestStore((s) => s.runFiltered);
  const debugTest = useTestStore((s) => s.debugTest);
  const connected = useUnityStore((s) => s.connected);
  const [open, setOpen] = useState(false);
  const status = result?.status ?? 'not-run';
  const failed = status === 'failed';

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          height: 22,
          paddingLeft: 32,
          fontSize: 12.5,
          cursor: 'pointer',
        }}
        onClick={() => (failed ? setOpen((o) => !o) : openAt(test.filePath, test.line))}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        title={test.fullName}
      >
        <StatusIcon status={status} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{test.name}</span>
        {result?.durationMs != null && (
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{result.durationMs}ms</span>
        )}
        <button
          className="explorer-action-btn"
          title="Run this test"
          onClick={(e) => {
            e.stopPropagation();
            void runFiltered(test.fullName, test.mode);
          }}
        >
          <Play size={12} />
        </button>
        <button
          className="explorer-action-btn"
          title={connected ? 'Debug this test' : 'Debug requires a connected Unity Editor'}
          disabled={!connected}
          onClick={(e) => {
            e.stopPropagation();
            void debugTest(test.fullName, test.mode);
          }}
          style={{ opacity: connected ? 1 : 0.4 }}
        >
          <Bug size={12} />
        </button>
      </div>
      {open && failed && result && (
        <div
          style={{
            padding: '4px 8px 6px 48px',
            background: 'var(--bg-input)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {result.message && <div style={{ color: 'var(--error-text)' }}>{result.message}</div>}
          {result.stackTrace && <div style={{ marginTop: 4 }}>{result.stackTrace}</div>}
        </div>
      )}
    </>
  );
}

function FixtureRow({ fixture }: { fixture: TestFixtureDTO }) {
  const [open, setOpen] = useState(true);
  const shortName = fixture.fqn.split('.').pop() || fixture.fqn;
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          height: 22,
          paddingLeft: 16,
          fontSize: 12.5,
          cursor: 'pointer',
        }}
        onClick={() => setOpen((o) => !o)}
        title={fixture.fqn}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortName}</span>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 'auto', paddingRight: 6 }}>
          {fixture.tests.length}
        </span>
      </div>
      {open && fixture.tests.map((t) => <TestRow key={t.id} test={t} />)}
    </>
  );
}

export function TestPanel() {
  const assemblies = useTestStore((s) => s.assemblies);
  const discovering = useTestStore((s) => s.discovering);
  const run = useTestStore((s) => s.run);
  const runAll = useTestStore((s) => s.runAll);
  const discover = useTestStore((s) => s.discover);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  useEffect(() => {
    if (assemblies.length === 0) void useTestStore.getState().discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  function runMode(mode: TestMode) {
    void runAll(mode);
  }

  return (
    <div className="sidebar">
      <div className="explorer-header">
        <span className="explorer-header-title">Tests</span>
        <div className="explorer-header-actions">
          <button className="explorer-action-btn" title="Run All (EditMode)" onClick={() => runMode('EditMode')}>
            <Play size={14} />
          </button>
          <button
            className="explorer-action-btn"
            title="Run All (PlayMode)"
            onClick={() => runMode('PlayMode')}
            style={{ position: 'relative' }}
          >
            <Play size={14} style={{ color: 'var(--info)' }} />
          </button>
          <button
            className="explorer-action-btn"
            title="Re-discover tests"
            onClick={() => void discover()}
          >
            <RefreshCw size={14} className={discovering ? 'spin' : ''} />
          </button>
        </div>
      </div>
      {run && (
        <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
          {run.active ? 'Running' : 'Done'} ({run.source}): {run.done}/{run.total || '?'} —{' '}
          <span style={{ color: 'var(--git-added, #4caf50)' }}>{run.passed}✓</span>{' '}
          <span style={{ color: 'var(--error-text)' }}>{run.failed}✗</span>
        </div>
      )}
      <div className="sidebar-tree" style={{ overflow: 'auto' }}>
        {assemblies.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 12 }}>
            {discovering ? 'Discovering tests…' : 'No tests found. (Test assemblies reference nunit.framework.)'}
          </div>
        ) : (
          assemblies.map((asm) => (
            <div key={asm.name}>
              <div
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--text-secondary)',
                  padding: '6px 8px 2px',
                }}
                title={`${asm.name} (${asm.mode})`}
              >
                {asm.name}
              </div>
              {asm.fixtures.map((fx) => (
                <FixtureRow key={fx.fqn} fixture={fx} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default TestPanel;
