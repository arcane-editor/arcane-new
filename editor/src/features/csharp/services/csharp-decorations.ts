import { LIFECYCLE_METHOD_NAMES, UNITY_LIFECYCLE_METHODS } from './lifecycle-db';
import { getThemeColor } from '../../theme';

type MonacoEditor = import('monaco-editor').editor.IStandaloneCodeEditor;
type MonacoModule = typeof import('monaco-editor');

let decorationIds: string[] = [];

// Regex to match C# method definitions like: void Update() or private void Awake()
const METHOD_REGEX = /(?:(?:private|protected|public|internal|static|virtual|override|sealed|abstract)\s+)*(?:void|IEnumerator)\s+(\w+)\s*\(/gm;

// Regex to match [SerializeField] attribute
const SERIALIZE_FIELD_REGEX = /\[SerializeField\]/g;

// Regex to match public fields (simplified)
const PUBLIC_FIELD_REGEX = /^\s*public\s+\w[\w<>,\s\[\]]*\s+\w+\s*[;=]/gm;

// Convert a `#RRGGBB` hex from the theme to a `#RRGGBBAA` string with the given alpha.
// Falls back to the input if the color is already non-hex (rgba/var/etc.).
function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith('#') || color.length !== 7) return color;
  const aa = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `${color}${aa}`;
}

export function applyCSharpDecorations(
  editor: MonacoEditor,
  monaco: MonacoModule,
): void {
  const model = editor.getModel();
  if (!model) return;

  const uri = model.uri.toString();
  if (!uri.endsWith('.cs')) {
    clearDecorations(editor);
    return;
  }

  const text = model.getValue();
  const newDecorations: import('monaco-editor').editor.IModelDeltaDecoration[] = [];

  const lifecycleRulerColor = withAlpha(getThemeColor('info'), 0.27);
  const serializeRulerColor = withAlpha(getThemeColor('success'), 0.27);

  // Find lifecycle methods
  let match: RegExpExecArray | null;
  METHOD_REGEX.lastIndex = 0;
  while ((match = METHOD_REGEX.exec(text)) !== null) {
    const methodName = match[1];
    if (LIFECYCLE_METHOD_NAMES.has(methodName)) {
      const pos = model.getPositionAt(match.index);
      const methodInfo = UNITY_LIFECYCLE_METHODS.find((m) => m.name === methodName);

      newDecorations.push({
        range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1),
        options: {
          isWholeLine: true,
          className: 'unity-lifecycle-line',
          glyphMarginClassName: 'unity-lifecycle-glyph',
          glyphMarginHoverMessage: {
            value: `**Unity ${methodInfo?.category ?? 'Lifecycle'}**: \`${methodName}\`\n\n${methodInfo?.description ?? ''}`,
          },
          overviewRuler: {
            color: lifecycleRulerColor,
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      });
    }
  }

  // Find [SerializeField] attributes
  SERIALIZE_FIELD_REGEX.lastIndex = 0;
  while ((match = SERIALIZE_FIELD_REGEX.exec(text)) !== null) {
    const pos = model.getPositionAt(match.index);
    newDecorations.push({
      range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1),
      options: {
        isWholeLine: true,
        className: 'unity-serialize-field-line',
        overviewRuler: {
          color: serializeRulerColor,
          position: monaco.editor.OverviewRulerLane.Right,
        },
      },
    });
  }

  // Find public fields
  PUBLIC_FIELD_REGEX.lastIndex = 0;
  while ((match = PUBLIC_FIELD_REGEX.exec(text)) !== null) {
    const pos = model.getPositionAt(match.index);
    newDecorations.push({
      range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1),
      options: {
        isWholeLine: true,
        after: {
          content: ' [Inspector]',
          inlineClassName: 'unity-inspector-hint',
        },
      },
    });
  }

  decorationIds = editor.deltaDecorations(decorationIds, newDecorations);
}

export function clearDecorations(editor: MonacoEditor): void {
  if (decorationIds.length > 0) {
    decorationIds = editor.deltaDecorations(decorationIds, []);
  }
}
