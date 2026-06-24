import { ChevronRight } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';

function Breadcrumbs() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);

  if (!workspacePath || !activeFilePath) return null;

  // Build relative path segments
  const relativePath = activeFilePath.startsWith(workspacePath)
    ? activeFilePath.slice(workspacePath.length + 1)
    : activeFilePath;

  const segments = relativePath.split('/').filter(Boolean);

  return (
    <div className="breadcrumbs">
      {segments.map((segment, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center' }}>
          {i > 0 && (
            <span className="breadcrumb-separator">
              <ChevronRight size={12} />
            </span>
          )}
          <span className="breadcrumb-segment">{segment}</span>
        </span>
      ))}
    </div>
  );
}

export default Breadcrumbs;
