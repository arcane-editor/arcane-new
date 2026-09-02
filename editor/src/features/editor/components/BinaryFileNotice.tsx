import { FileQuestion } from 'lucide-react';

/** Bytes as something a person reads, not as a count of bytes. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shown in place of the editor when a file's bytes are not UTF-8.
 *
 * This replaces a raw OS error toast -- "Unexpected error: stream did not
 * contain valid UTF-8" -- which named a Rust implementation detail and implied
 * something had broken. Nothing had: Unity writes several assets in every
 * project as binary regardless of the project's serialization mode, so
 * clicking one is ordinary. The copy explains rather than apologises, and says
 * where the file can actually be edited.
 */
export function BinaryFileNotice({ name, byteSize }: { name: string; byteSize?: number }) {
  return (
    <div className="editor-container" style={SHELL}>
      <div style={CARD}>
        <FileQuestion size={20} style={{ color: 'var(--text-secondary)' }} />
        <h2 style={TITLE}>{name} is a binary file</h2>
        <p style={BODY}>
          Its bytes are not text, so there is nothing to show or edit here.
          {typeof byteSize === 'number' ? ` It is ${humanSize(byteSize)} on disk.` : ''}
        </p>
        <p style={BODY}>
          Unity stores some assets this way &mdash; terrain, XR settings, lightmaps &mdash; even in
          projects set to Force Text serialization. Open it in Unity to change it.
        </p>
      </div>
    </div>
  );
}

const SHELL: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  padding: 24,
};

const CARD: React.CSSProperties = {
  maxWidth: 430,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 8,
};

const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text-primary)',
  wordBreak: 'break-all',
};

const BODY: React.CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  lineHeight: 1.6,
  color: 'var(--text-secondary)',
};

export default BinaryFileNotice;
