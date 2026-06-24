import { useEffect, useMemo, useRef, useState } from 'react';

interface InlineInputProps {
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Names already present in the target directory, for duplicate detection. */
  siblingNames?: string[];
}

const INVALID_CHARS = /[\\/:*?"<>|]/;

function InlineInput({ defaultValue, onSubmit, onCancel, siblingNames = [] }: InlineInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards against committing/cancelling twice (e.g. Enter then the unmount blur).
  const doneRef = useRef(false);

  // Existing names in the target dir (lower-cased), excluding the original name
  // so a no-op or case-only rename of the same entry isn't flagged as a dupe.
  const takenNames = useMemo(() => {
    const set = new Set(siblingNames.map((n) => n.toLowerCase()));
    set.delete(defaultValue.trim().toLowerCase());
    return set;
  }, [siblingNames, defaultValue]);

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'A file or folder name must be provided.';
    if (trimmed === '.' || trimmed === '..') {
      return `The name "${trimmed}" is not valid as a file or folder name.`;
    }
    if (INVALID_CHARS.test(trimmed)) {
      return 'A file or folder name cannot contain any of the following characters: \\ / : * ? " < > |';
    }
    if (takenNames.has(trimmed.toLowerCase())) {
      return `A file or folder "${trimmed}" already exists at this location. Please choose a different name.`;
    }
    return null;
  }

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dotIndex = defaultValue.lastIndexOf('.');
    if (dotIndex > 0) {
      input.setSelectionRange(0, dotIndex);
    } else {
      input.select();
    }
  }, []);

  const commit = (raw: string) => {
    if (doneRef.current) return;
    const validationError = validate(raw);
    if (validationError) {
      setError(validationError);
      inputRef.current?.focus();
      return;
    }
    doneRef.current = true;
    onSubmit(raw.trim());
  };

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <div style={{ position: 'relative', width: '100%', zIndex: 1 }}>
      <input
        ref={inputRef}
        className="inline-input"
        defaultValue={defaultValue}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => setError(validate(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(inputRef.current?.value ?? ''); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          e.stopPropagation();
        }}
        onBlur={() => {
          // Match VS Code: commit a valid name on blur, otherwise abandon the
          // edit rather than trapping focus inside an invalid field.
          const raw = inputRef.current?.value ?? '';
          if (validate(raw)) cancel();
          else commit(raw);
        }}
        style={{
          width: '100%',
          height: '22px',
          fontSize: '13px',
          padding: '0 4px',
          border: `1px solid ${error ? 'var(--error, #f48771)' : 'var(--accent)'}`,
          background: 'var(--bg-input)',
          color: 'var(--text-primary)',
          borderRadius: error ? '2px 2px 0 0' : '2px',
          outline: 'none',
          fontFamily: 'inherit',
          position: 'relative',
          zIndex: 1,
        }}
      />
      {error && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: -1,
            padding: '3px 6px',
            fontSize: '12px',
            lineHeight: 1.35,
            background: 'var(--bg-input)',
            color: 'var(--error, #f48771)',
            border: '1px solid var(--error, #f48771)',
            borderTop: 'none',
            borderRadius: '0 0 2px 2px',
            boxShadow: '0 2px 6px rgba(0, 0, 0, 0.35)',
            whiteSpace: 'normal',
            zIndex: 20,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export default InlineInput;
