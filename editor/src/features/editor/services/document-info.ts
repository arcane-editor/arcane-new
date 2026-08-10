import { fileUri } from '../../lsp';
import { getMonaco } from './monaco-init';

export interface DocumentInfo {
  /** e.g. `Spaces: 4` or `Tab Size: 4`. */
  indent: string;
  /** `LF` or `CRLF`. */
  eol: string;
}

/**
 * Read indentation and line endings off the live Monaco model.
 *
 * The status bar printed `Spaces: 4`, `UTF-8` and `LF` as literals, derived
 * from nothing. On a tab-indented file it said Spaces; on a file with Windows
 * line endings it said LF. A status bar that is confidently wrong is worse than
 * one that is empty — and it is the kind of detail that makes an app read as a
 * mockup.
 *
 * Encoding is deliberately not reported: the backend reads and writes UTF-8
 * only, so the value can never vary and the item carried no information.
 *
 * Returns null when there is no model — the caller renders nothing rather than
 * guessing.
 */
export function getDocumentInfo(path: string | null): DocumentInfo | null {
  if (!path) return null;
  const monaco = getMonaco();
  if (!monaco) return null;
  if (path.includes('://')) return null;

  const model = monaco.editor.getModel(monaco.Uri.parse(fileUri(path)));
  if (!model) return null;

  const options = model.getOptions();
  const indent = options.insertSpaces
    ? `Spaces: ${options.indentSize ?? options.tabSize}`
    : `Tab Size: ${options.tabSize}`;

  // Monaco's EOL is the literal sequence, not a name.
  const eol = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';

  return { indent, eol };
}
