import type { ReactElement } from 'react';
import { Network, Loader2 } from 'lucide-react';
import { useGraphifyStore } from '../../../stores/graphify';
import { useWorkspaceStore } from '../../../stores/workspace';
import { computeBuildOpts } from '../services/build-opts';

function GraphifyStatusBadge() {
  const status = useGraphifyStore((s) => s.status);
  const summary = useGraphifyStore((s) => s.summary);
  const progressMessage = useGraphifyStore((s) => s.progressMessage);
  const errorMessage = useGraphifyStore((s) => s.errorMessage);
  const sidecarAvailable = useGraphifyStore((s) => s.sidecarAvailable);
  const build = useGraphifyStore((s) => s.build);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  if (!workspacePath) return null;
  if (sidecarAvailable === false) {
    return (
      <span style={baseStyle} title="The unityide-graph sidecar binary is not bundled with this build.">
        <Network size={12} />
        <span>graph: unavailable</span>
      </span>
    );
  }

  function onClick() {
    if (!workspacePath) return;
    if (status === 'building') return;
    void build(workspacePath, computeBuildOpts());
  }

  let label: string;
  let iconNode: ReactElement;
  let title: string;
  switch (status) {
    case 'building':
      iconNode = <Loader2 size={12} className="animate-spin" />;
      label = progressMessage ? `graph: ${progressMessage}` : 'graph: indexing…';
      title = 'Building the codebase graph. Click is disabled while indexing.';
      break;
    case 'present':
      iconNode = <Network size={12} />;
      label = summary ? `graph: ${summary.nodes} nodes` : 'graph: ready';
      title = 'Codebase graph ready. Click to rebuild.';
      break;
    case 'stale':
      iconNode = <Network size={12} />;
      label = summary ? `graph: ${summary.nodes} nodes (stale)` : 'graph: stale';
      title = 'Graph is older than 24h. Click to rebuild.';
      break;
    case 'error':
      iconNode = <Network size={12} />;
      label = 'graph: error';
      title = errorMessage ?? 'graphify failed. Click to retry.';
      break;
    default:
      iconNode = <Network size={12} />;
      label = 'graph: build';
      title = 'No codebase graph yet. Click to build.';
      break;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={status === 'building'}
      style={{
        ...baseStyle,
        cursor: status === 'building' ? 'default' : 'pointer',
        opacity: status === 'building' ? 0.8 : 1,
      }}
      title={title}
    >
      {iconNode}
      <span>{label}</span>
    </button>
  );
}

const baseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 6px',
  height: 22,
  fontSize: 11,
  color: 'var(--text-secondary)',
  background: 'transparent',
  border: 'none',
  borderRadius: 3,
  whiteSpace: 'nowrap',
};

export default GraphifyStatusBadge;
