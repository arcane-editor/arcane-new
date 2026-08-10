import { useSettingsStore } from '../../../stores/settings';

/**
 * A live sample of the terminal at the current font and size.
 *
 * Font settings are the one case where the control cannot tell you the answer:
 * whether 13px Menlo is comfortable, or whether the font you picked is even
 * installed, is only visible by looking at it. Previously the only way to find
 * out was to close the modal, look at the terminal, and come back.
 *
 * Deliberately static markup rather than a real xterm instance — spinning up a
 * PTY to preview a font would be absurd, and the glyphs below are chosen to
 * expose exactly what differs between monospace faces: zero/O, one/l/I,
 * ligature pairs, and box-drawing characters.
 */
function TerminalPreview() {
  const fontFamily = useSettingsStore((s) => s.settings['terminal.fontFamily']);
  const fontSize = useSettingsStore((s) => s.settings['terminal.fontSize']);

  return (
    <div className="settings-terminal-preview" aria-label="Terminal preview">
      <div className="settings-terminal-preview-chrome">
        <span className="settings-terminal-preview-dot" />
        <span className="settings-terminal-preview-title">Preview</span>
      </div>
      <pre
        className="settings-terminal-preview-body"
        style={{ fontFamily: String(fontFamily), fontSize: Number(fontSize) }}
      >
        <span className="settings-terminal-preview-prompt">~/UnityProject</span> dotnet build{'\n'}
        {'  '}Il1O0 {'{}'} [] {'<>'} =&gt; != ~ * &amp;{'\n'}
        <span className="settings-terminal-preview-ok">✓</span> Build succeeded in 2.4s{'\n'}
        <span className="settings-terminal-preview-err">✗</span> CS0103: name &apos;rb&apos; not found
      </pre>
    </div>
  );
}

export default TerminalPreview;
