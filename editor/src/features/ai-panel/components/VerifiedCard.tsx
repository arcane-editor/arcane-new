/**
 * VerifiedCard — the "AI you can trust" closing proof (P3.4). Renders the
 * verified-pass result (`verified-pass.ts`) as a compact single-row summary:
 * compile / analyzers / GUID integrity, plus the touched-file count, each with
 * a ✓ / ✗ / – (skipped) marker. The touched-file list (and any missing-GUID
 * detail) sits collapsed behind a chevron, same pattern as ToolCallBlock.
 */

import { useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Minus,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
} from 'lucide-react';
import type { AiMessage } from '../../../stores/ai';
import { verifiedVerdict, verdictTitle } from '../services/verified-verdict';

interface Props {
  message: AiMessage;
}

import type { CheckMarker as Marker } from '../services/verified-verdict';

function MarkerIcon({ marker }: { marker: Marker }) {
  switch (marker) {
    case 'ok':
      return <Check size={11} strokeWidth={2.5} className="ai-verified-icon-ok" />;
    case 'bad':
      return <X size={11} strokeWidth={2.5} className="ai-verified-icon-bad" />;
    case 'skip':
      return <Minus size={11} strokeWidth={2.5} className="ai-verified-icon-skip" />;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function VerifiedCard({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const data = message.verifiedPass;
  if (!data) return null;

  const { files, touchedFiles, analyzers, compile, guids } = data;

  const compileMarker: Marker = compile === 'clean' ? 'ok' : compile === 'skipped' ? 'skip' : 'bad';
  const compileLabel =
    compile === 'clean'
      ? 'compiles clean'
      : compile === 'skipped'
        ? 'compile (no Unity bridge)'
        : `compile: ${plural(compile.errors, 'error')}`;

  const analyzersMarker: Marker =
    analyzers === 'skipped' ? 'skip' : analyzers.errors === 0 ? 'ok' : 'bad';
  const analyzersLabel =
    analyzers === 'skipped' ? 'analyzers skipped' : plural(analyzers.errors, 'analyzer error');

  const guidsMarker: Marker = guids === 'skipped' ? 'skip' : guids === 'intact' ? 'ok' : 'bad';
  const guidsLabel =
    guids === 'skipped'
      ? 'GUIDs skipped'
      : guids === 'intact'
        ? 'GUIDs ok'
        : plural(guids.missing.length, 'GUID missing');

  // A skipped check is NOT a passing one: when the bridge is down and the budget
  // runs out, all three skip — and this used to render a green "Verified".
  const verdict = verifiedVerdict([compileMarker, analyzersMarker, guidsMarker]);
  const missingGuids = guids !== 'skipped' && guids !== 'intact' ? guids.missing : [];
  const hasDetail = touchedFiles.length > 0 || missingGuids.length > 0;

  return (
    <div className={`ai-verified-card is-${verdict}`}>
      <button
        type="button"
        className="ai-verified-header"
        onClick={() => setExpanded((v) => !v)}
        disabled={!hasDetail}
      >
        {hasDetail ? (
          expanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )
        ) : (
          <span className="ai-verified-chevron-spacer" />
        )}
        {verdict === 'passed' ? (
          <ShieldCheck size={13} strokeWidth={2} className="ai-verified-icon-ok" />
        ) : verdict === 'unverified' ? (
          <ShieldQuestion size={13} strokeWidth={2} className="ai-verified-icon-skip" />
        ) : (
          <ShieldAlert size={13} strokeWidth={2} className="ai-verified-icon-bad" />
        )}
        <span className="ai-verified-title">{verdictTitle(verdict)}</span>
        <span className="ai-verified-summary">
          <span className="ai-verified-item">
            <MarkerIcon marker={compileMarker} />
            {compileLabel}
          </span>
          <span className="ai-verified-sep">·</span>
          <span className="ai-verified-item">
            <MarkerIcon marker={analyzersMarker} />
            {analyzersLabel}
          </span>
          <span className="ai-verified-sep">·</span>
          <span className="ai-verified-item">
            <MarkerIcon marker={guidsMarker} />
            {guidsLabel}
          </span>
          <span className="ai-verified-sep">·</span>
          <span className="ai-verified-item ai-verified-files">{plural(files, 'file')}</span>
        </span>
      </button>

      {expanded && hasDetail && (
        <div className="ai-verified-body">
          {touchedFiles.length > 0 && (
            <>
              <div className="ai-verified-body-label">Touched files</div>
              <ul className="ai-verified-file-list">
                {touchedFiles.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}
          {missingGuids.length > 0 && (
            <>
              <div className="ai-verified-body-label ai-verified-error-label">Missing .meta/GUID</div>
              <ul className="ai-verified-file-list">
                {missingGuids.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default VerifiedCard;
