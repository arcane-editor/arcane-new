/**
 * Deciding whether a span of inline code is a file the editor can open.
 *
 * Assistant prose is dense with inline code, and almost none of it is a path:
 * `useState`, `props.children`, `--noEmit`, `bun run verify`. A false positive
 * here renders a clickable file chip that opens nothing, which is worse than
 * rendering no chips at all — so this errs hard toward saying no, and the tests
 * are mostly rejections.
 *
 * The rule it settles on: a reference must end in a **known file extension**.
 * That deliberately refuses `src/features/ai-panel` (a real directory, but
 * `openFile` cannot open one) and `window.location` (a real dotted name, but
 * `location` is not an extension). Pure and separate from the component for the
 * reason `empty-state.ts` gives — this project has no component-test
 * infrastructure, so what is worth verifying lives outside the React wiring.
 */

export interface FileRef {
  path: string;
  /** 1-based, when the reference carried one. */
  line?: number;
  column?: number;
}

/**
 * Extensions that make a token a file reference.
 *
 * Unity asset types are first-class here, not an afterthought: `.prefab`,
 * `.unity`, `.asset`, `.mat` and `.shader` are most of what gets discussed in
 * this editor, and a chip that works for `.tsx` but not `.prefab` would feel
 * arbitrary in exactly the project this ships for.
 */
const KNOWN_EXTENSIONS = new Set([
  // code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'cs', 'rs', 'py', 'go', 'java', 'kt',
  'swift', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'm', 'mm', 'sh', 'bash',
  'zsh', 'sql', 'lua',
  // shaders / Unity
  'shader', 'cginc', 'hlsl', 'compute', 'prefab', 'unity', 'asset', 'mat',
  'anim', 'controller', 'meta', 'asmdef',
  // web / markup / config
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'json', 'jsonc',
  'md', 'mdx', 'yml', 'yaml', 'toml', 'ini', 'env', 'xml', 'svg', 'csproj',
  'sln', 'gradle', 'lock', 'txt', 'cfg', 'conf', 'plist',
]);

/** Longer than any real path in a chat message; refuse rather than scan. */
const MAX_LENGTH = 260;

/** Characters that mean this is code or a command, not a path. */
const DISQUALIFYING = /[\s()[\]{}<>|*?"'`,;=!&$]/;

/**
 * Pull a trailing `:12`, `:12:5` or `#L12` off the token.
 *
 * A malformed or zero/negative line is dropped rather than failing the whole
 * reference: `App.tsx:0` is still a file worth opening, just not at a line.
 */
function splitLocation(token: string): { path: string; line?: number; column?: number } {
  const hash = /^(.*?)#L(\d+)$/.exec(token);
  if (hash) {
    const line = Number(hash[2]);
    return line > 0 ? { path: hash[1], line } : { path: hash[1] };
  }

  const colon = /^(.*?):(-?\d+)(?::(-?\d+))?$/.exec(token);
  if (colon) {
    const line = Number(colon[2]);
    const column = colon[3] === undefined ? undefined : Number(colon[3]);
    if (line > 0) {
      return column !== undefined && column > 0
        ? { path: colon[1], line, column }
        : { path: colon[1], line };
    }
    return { path: colon[1] };
  }

  return { path: token };
}

function hasKnownExtension(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  // `dot < 1` also rejects a dotfile with no extension (`.gitignore` → -1 after
  // the slice, `.env` handled by the extension list itself).
  if (dot < 1) return false;
  return KNOWN_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

export function parseFileRef(raw: string): FileRef | null {
  const token = raw.trim();
  if (!token || token.length > MAX_LENGTH) return null;
  if (DISQUALIFYING.test(token)) return null;

  // A URL is not a workspace file, and `openFile` would create a phantom tab.
  // `mailto:` is caught here too, before `splitLocation` mistakes it for a path
  // with a location suffix.
  //
  // The scheme pattern excludes `.` deliberately: with it, `App.tsx:-3` parsed
  // as scheme `App.tsx` and was thrown out as a URL. No real scheme contains a
  // dot, and every path worth chipping does.
  if (token.includes('://') || /^[a-z][a-z0-9+-]*:(?!\d)/i.test(token)) return null;

  // Shell flags read as paths otherwise (`--noEmit`, `-rf`).
  if (token.startsWith('-')) return null;

  const { path, line, column } = splitLocation(token);
  if (!path || !hasKnownExtension(path)) return null;

  const ref: FileRef = { path };
  if (line !== undefined) ref.line = line;
  if (column !== undefined) ref.column = column;
  return ref;
}
