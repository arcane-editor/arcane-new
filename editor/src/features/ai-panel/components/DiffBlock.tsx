/**
 * DiffBlock — renders a file edit as a colored unified diff.
 *
 * Reuses generateDiff() (the `diff` npm package) from the vendor edit utilities,
 * then classes each line for +/-/hunk/meta coloring.
 */

import { useMemo } from 'react';
import { generateDiff } from '../services/vendor/tools/edit-diff';

interface DiffBlockProps {
  path: string;
  oldText: string;
  newText: string;
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'ai-diff-line ai-diff-meta';
  if (line.startsWith('@@')) return 'ai-diff-line ai-diff-hunk';
  if (line.startsWith('+')) return 'ai-diff-line ai-diff-add';
  if (line.startsWith('-')) return 'ai-diff-line ai-diff-del';
  return 'ai-diff-line';
}

function DiffBlock({ path, oldText, newText }: DiffBlockProps) {
  const lines = useMemo(() => {
    const { diff } = generateDiff(oldText, newText, path || 'file');
    // Drop the patch header lines (Index:/===) — keep file markers + hunks.
    return diff
      .split('\n')
      .filter((l) => !l.startsWith('Index:') && !l.startsWith('==='));
  }, [path, oldText, newText]);

  return (
    <div className="ai-diff-block">
      <div className="ai-diff-block-path" title={path}>
        {path || 'file'}
      </div>
      <pre className="ai-diff-block-body">
        {lines.map((line, i) => (
          <div key={i} className={lineClass(line)}>
            {line || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

export default DiffBlock;
