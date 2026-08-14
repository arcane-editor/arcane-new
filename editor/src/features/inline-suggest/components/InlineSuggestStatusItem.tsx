import { Sparkles } from 'lucide-react';
import { useInlineSuggestStore, type InlineSuggestStatus } from '../../../stores/inline-suggest';
import { useSettingsStore } from '../../../stores/settings';

const LABELS: Record<InlineSuggestStatus, string> = {
  active: 'Tab',
  disabled: 'Tab off',
  'signed-out': 'Tab · sign in',
  offline: 'Tab · offline',
  quota: 'Tab · daily limit',
  'budget-exhausted': 'Tab · monthly limit',
  backoff: 'Tab · paused',
};

const TITLES: Record<InlineSuggestStatus, string> = {
  active: 'AI inline suggestions are active. Click to disable.',
  disabled: 'AI inline suggestions are off. Click to enable.',
  'signed-out': 'Sign in to use AI inline suggestions.',
  offline: 'Offline — suggestions resume when the connection returns.',
  quota: 'Daily completion limit reached.',
  'budget-exhausted': 'Tab completions for this month are used up.',
  backoff: 'Suggestions paused after repeated errors — retrying shortly.',
};

// Matches the neighboring GraphifyStatusBadge's inline-styled-button
// convention (StatusBar renders the two side by side).
const baseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 6px',
  height: 22,
  fontSize: 11,
  color: 'var(--text-secondary)',
  background: 'transparent',
  border: 'none',
  borderRadius: 3,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

export function InlineSuggestStatusItem() {
  const status = useInlineSuggestStore((s) => s.status);
  const quotaResetAt = useInlineSuggestStore((s) => s.quotaResetAt);
  // Daily quota resets same-day, so a bare time-of-day reads fine; the
  // monthly budget can be many days out, so it needs a date instead.
  const title = status === 'quota' && quotaResetAt
    ? `${TITLES.quota} Resumes at ${new Date(quotaResetAt).toLocaleTimeString()}.`
    : status === 'budget-exhausted' && quotaResetAt
      ? `${TITLES['budget-exhausted']} Resets ${new Date(quotaResetAt).toLocaleDateString()}.`
      : TITLES[status];
  const toggle = () => {
    const s = useSettingsStore.getState();
    s.setSetting('ai.inlineSuggestions.enabled', !s.settings['ai.inlineSuggestions.enabled']);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      style={{ ...baseStyle, opacity: status === 'active' ? 1 : 0.6 }}
    >
      <Sparkles size={12} />
      <span>{LABELS[status]}</span>
    </button>
  );
}

export default InlineSuggestStatusItem;
