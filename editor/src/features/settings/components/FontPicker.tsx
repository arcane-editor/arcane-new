import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import { optionLabel, optionValue, type SettingOption } from '../data/definitions';

interface FontPickerProps {
  options: SettingOption[];
  value: string;
  onChange: (value: string) => void;
}

const MENU_WIDTH = 260;

/**
 * A font dropdown that renders each option **in the font it names**.
 *
 * The native `<select>` this replaces rendered `<option>{String(opt)}</option>`
 * over raw CSS stacks, so the control's label was literally
 * `ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', …`. Seeing the
 * face is also the only way to tell whether a font is actually installed —
 * a missing one silently falls through its stack, and a plain list gives no
 * hint that happened.
 */
function FontPicker({ options, value, onChange }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = options.find((o) => String(optionValue(o)) === value);
  const activeLabel = active ? optionLabel(active) : 'Custom';

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !buttonRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Deferred so the click that opened the menu does not immediately close it.
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', () => setOpen(false), true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="settings-font-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open && buttonRef.current) setRect(buttonRef.current.getBoundingClientRect());
          setOpen((v) => !v);
        }}
      >
        <span className="settings-font-trigger-name" style={{ fontFamily: value }}>
          {activeLabel}
        </span>
        <ChevronDown size={12} />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            className="settings-font-menu"
            style={{
              position: 'fixed',
              top: rect.bottom + 4,
              left: Math.max(8, Math.min(window.innerWidth - MENU_WIDTH - 8, rect.right - MENU_WIDTH)),
              width: MENU_WIDTH,
            }}
          >
            {options.map((opt) => {
              const v = String(optionValue(opt));
              const selected = v === value;
              return (
                <button
                  key={v}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`settings-font-option${selected ? ' is-selected' : ''}`}
                  onClick={() => {
                    onChange(v);
                    setOpen(false);
                  }}
                >
                  <span className="settings-font-option-text">
                    <span className="settings-font-option-name">{optionLabel(opt)}</span>
                    {/* The sample is the point: it shows the real face, and
                        the characters chosen are the ones that differ most
                        between monospace fonts. */}
                    <span className="settings-font-option-sample" style={{ fontFamily: v }}>
                      Il1O0 {'{}'} =&gt; ~
                    </span>
                  </span>
                  {selected && <Check size={13} />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

export default FontPicker;
