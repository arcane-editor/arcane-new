import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, IDisposable, languages } from 'monaco-editor';
import { useGitStore } from '../../../stores/git';
import { useWorkspaceStore } from '../../../stores/workspace';
import { formatRelativeDate } from '../../../utils/date';
import type { BlameLine } from '../../../types';

let registered = false;

function pathFromUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(uri.slice('file://'.length));
  } catch {
    return null;
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatBlameMarkdown(line: BlameLine): string {
  if (line.is_uncommitted) {
    return '**Uncommitted changes**';
  }
  const date = line.date ? formatRelativeDate(line.date) : '';
  const dateBit = date ? ` _(${date})_` : '';
  const summary = line.summary ? `> ${line.summary}\n\n` : '';
  const email = line.author_email ? ` · ${line.author_email}` : '';
  return `**${line.author || 'Unknown'}**${dateBit}\n\n${summary}\`${shortSha(line.sha)}\`${email}`;
}

export function registerBlameHoverProvider(monaco: Monaco): IDisposable | null {
  if (registered) return null;
  registered = true;

  const provider: languages.HoverProvider = {
    provideHover(model: MonacoEditorNs.ITextModel, position) {
      const ws = useWorkspaceStore.getState().workspacePath;
      const git = useGitStore.getState();
      if (!ws || !git.isGitRepo) return null;
      if (model.getLineCount() > 50_000) return null;

      const absPath = pathFromUri(model.uri.toString());
      if (!absPath) return null;
      if (!absPath.startsWith(ws + '/') && absPath !== ws) return null;

      const cached = git.blameCache.get(absPath);
      if (cached && cached.gen === git.blameGen) {
        const line = cached.lines[position.lineNumber - 1];
        if (!line) return null;
        return {
          contents: [
            { value: formatBlameMarkdown(line), isTrusted: false, supportHtml: false },
          ],
        };
      }

      git.getBlame(ws, absPath);
      return {
        contents: [{ value: '_Loading blame…_', isTrusted: false }],
      };
    },
  };

  return monaco.languages.registerHoverProvider({ scheme: 'file' }, provider);
}
