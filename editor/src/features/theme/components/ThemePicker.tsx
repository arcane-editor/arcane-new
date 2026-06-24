import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useThemeStore } from '../../../stores/theme';
import { getAllThemes } from '../registry';

interface ThemePickerProps {
  onClose: () => void;
}

function ThemePicker({ onClose }: ThemePickerProps) {
  const themes = useMemo(() => getAllThemes(), []);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const previewTheme = useThemeStore((s) => s.previewTheme);
  const revertPreview = useThemeStore((s) => s.revertPreview);

  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, themes.findIndex((t) => t.id === activeThemeId)),
  );
  const [filterText, setFilterText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmedRef = useRef(false);

  const filteredThemes = themes.filter((t) =>
    t.name.toLowerCase().includes(filterText.toLowerCase()),
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Preview theme on selection change
  useEffect(() => {
    const theme = filteredThemes[selectedIndex];
    if (theme) {
      previewTheme(theme.id);
    }
  }, [selectedIndex, filterText]);

  // Revert on unmount if not confirmed
  useEffect(() => {
    return () => {
      if (!confirmedRef.current) {
        revertPreview();
      }
    };
  }, [revertPreview]);

  const handleConfirm = useCallback(
    (themeId: string) => {
      confirmedRef.current = true;
      setTheme(themeId);
      onClose();
    },
    [setTheme, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filteredThemes.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter': {
          e.preventDefault();
          const theme = filteredThemes[selectedIndex];
          if (theme) handleConfirm(theme.id);
          break;
        }
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filteredThemes, selectedIndex, handleConfirm, onClose],
  );

  return (
    <div className="theme-picker-overlay" onClick={onClose}>
      <div className="theme-picker" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="theme-picker-input"
          type="text"
          placeholder="Select Color Theme (Up/Down to preview)"
          value={filterText}
          onChange={(e) => {
            setFilterText(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="theme-picker-list">
          {filteredThemes.map((theme, index) => (
            <div
              key={theme.id}
              className={`theme-picker-item${index === selectedIndex ? ' selected' : ''}${theme.id === activeThemeId ? ' active' : ''}`}
              onMouseEnter={() => {
                setSelectedIndex(index);
              }}
              onClick={() => handleConfirm(theme.id)}
            >
              <div className="theme-picker-swatches" aria-hidden>
                <span className="theme-picker-swatch" style={{ background: theme.ui['bg-primary'] }} />
                <span className="theme-picker-swatch" style={{ background: theme.ui['bg-statusbar'] }} />
                <span className="theme-picker-swatch" style={{ background: theme.ui['accent'] }} />
                <span className="theme-picker-swatch" style={{ background: theme.ui['accent-secondary'] }} />
                <span className="theme-picker-swatch" style={{ background: theme.ui['text-primary'] }} />
              </div>
              <span className="theme-picker-name">{theme.name}</span>
              <span className="theme-picker-type">{theme.type}</span>
            </div>
          ))}
          {filteredThemes.length === 0 && (
            <div className="theme-picker-empty">No matching themes</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ThemePicker;
