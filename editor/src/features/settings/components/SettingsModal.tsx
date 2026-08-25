import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, UserRound } from 'lucide-react';
import { useUiStore } from '../../../stores/ui';
import { useAuthStore } from '../../../stores/auth';
import { SETTING_DEFINITIONS } from '../data/definitions';
import { ACCOUNT_SECTION, categoriesOf, filterSettings, isKnownSection } from '../data/nav';
import SettingsSection from './SettingsSection';
import { getVersion } from '@tauri-apps/api/app';
import AccountSection from './AccountSection';

/**
 * Settings and Account, as one modal with a nav rail.
 *
 * Replaces two inconsistent surfaces: settings used to swap out the whole
 * editor area (taking the tab bar and breadcrumbs with it) while account was a
 * virtual `auth://` tab pretending to be a file. Neither was a file, so
 * neither belonged in the editor. As a modal the workspace stays visible
 * behind, and closing returns you exactly where you were.
 */
export function SettingsModal() {
  const open = useUiStore((s) => s.settingsOpen);
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.setSettingsSection);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const email = useAuthStore((s) => s.email);
  const loggedIn = useAuthStore((s) => s.loggedIn);

  const [search, setSearch] = useState('');
  // The app displayed its version nowhere, which made "what version are you
  // on?" unanswerable on a bug report. Best-effort: the settings modal must
  // still open if this fails.
  const [appVersion, setAppVersion] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const categories = useMemo(() => categoriesOf(SETTING_DEFINITIONS), []);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);
  const results = useMemo(() => filterSettings(SETTING_DEFINITIONS, search), [search]);
  const searching = search.trim().length > 0;

  // A section remembered from a previous version may no longer exist; falling
  // back keeps the pane from rendering blank.
  const activeSection = isKnownSection(section, categories) ? section : categories[0];

  useEffect(() => {
    if (!open) return;
    // Opening clears the previous query — a stale filter would otherwise hide
    // the section the user just navigated to.
    setSearch('');
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeSettings();
        return;
      }
      if (e.key !== 'Tab') return;

      // Focus trap: keep Tab inside the dialog so it cannot walk into the
      // editor behind the backdrop, which is inert but still focusable.
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, closeSettings]);

  if (!open) return null;

  return createPortal(
    <div className="settings-modal-overlay" onMouseDown={closeSettings}>
      <div
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Nav rail */}
        <div className="settings-modal-rail">
          <div className="settings-modal-search">
            <Search size={13} className="settings-modal-search-icon" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search settings…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          <nav className="settings-modal-nav">
            <button
              className={`settings-modal-nav-item settings-modal-nav-account${
                activeSection === ACCOUNT_SECTION && !searching ? ' is-active' : ''
              }`}
              onClick={() => {
                setSearch('');
                setSection(ACCOUNT_SECTION);
              }}
            >
              <UserRound size={14} />
              <span className="settings-modal-nav-account-text">
                <span className="settings-modal-nav-label">Account</span>
                {loggedIn && email && (
                  <span className="settings-modal-nav-sublabel">{email}</span>
                )}
              </span>
            </button>

            <div className="settings-modal-nav-divider" />

            {categories.map((cat) => (
              <button
                key={cat}
                className={`settings-modal-nav-item${
                  activeSection === cat && !searching ? ' is-active' : ''
                }`}
                onClick={() => {
                  setSearch('');
                  setSection(cat);
                }}
              >
                <span className="settings-modal-nav-label">{cat}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Content pane */}
        <div className="settings-modal-content">
          <button
            className="settings-modal-close"
            onClick={closeSettings}
            title="Close settings"
            aria-label="Close settings"
          >
            <X size={15} />
          </button>

          {searching ? (
            <SettingsSection
              title={`${results.length} result${results.length === 1 ? '' : 's'}`}
              definitions={results}
              showCategory
            />
          ) : activeSection === ACCOUNT_SECTION ? (
            <AccountSection />
          ) : (
            <>
              {activeSection === 'Updates' && appVersion && (
                <p className="settings-app-version">Arcane {appVersion}</p>
              )}
              <SettingsSection
                title={activeSection}
                definitions={SETTING_DEFINITIONS.filter((d) => d.category === activeSection)}
              />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default SettingsModal;
