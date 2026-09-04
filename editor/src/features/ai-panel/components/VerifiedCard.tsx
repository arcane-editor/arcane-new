/**
 * VerifiedCard — the "AI you can trust" closing proof (P3.4). Renders the
 * verified-pass result (`verified-pass.ts`) as a compact single-row summary:
 * compile / analyzers / GUID integrity, plus the three Unity subsystems whose
 * breakage a compile can never report (UI Toolkit, ScriptableObjects, Input),
 * plus the touched-file count, each with a ✓ / ✗ / – (skipped) marker.
 *
 * Task 13 adds two more chips on the same rule: what Unity's own console said
 * after the turn, and the latest test run the send made. Those two are the only
 * evidence that the change actually WORKS rather than merely compiling, and a
 * repair pass the check made is labelled honestly — a console error is never
 * called "fixed", only "not seen again".
 *
 * The three subsystem chips render only when their step actually ran. Unlike
 * compile/analyzers/GUIDs, which apply to every send, a send that touched no
 * .uxml has nothing to say about UI Toolkit — and a chip reading "UI Toolkit
 * skipped" on every C#-only change is noise that trains the user to stop
 * reading the card. Their markers still feed the verdict, so a real failure
 * both appears and turns the shield red. The touched-file list (and any missing-GUID
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
import { verifiedVerdict, verdictTitle, consoleMarker, testsMarker } from '../services/verified-verdict';
import { consoleRowLabel, testsRowLabel } from '../services/console-check';

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

  const {
    files,
    touchedFiles,
    analyzers,
    compile,
    guids,
    uiToolkit,
    scriptableObjects,
    input,
    // Task 13: `'skipped'` on both means the closing check never ran (not a
    // Unity send, the setting is off, nothing was touched) — same rule the
    // three subsystem chips follow, so the card does not grow two permanent
    // "skipped" chips users learn to ignore.
    console: consoleCheck = 'skipped',
    tests = 'skipped',
    repair,
  } = data;

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

  // ── The three silent-failure subsystems ───────────────────────────────────
  const uiMarker: Marker =
    uiToolkit === 'skipped'
      ? 'skip'
      : uiToolkit === 'clean'
        ? 'ok'
        : uiToolkit.problems > 0 || uiToolkit.queriesResolved < uiToolkit.queriesTotal
          ? 'bad'
          : 'ok';
  const uiLabel =
    uiToolkit === 'skipped' || uiToolkit === 'clean'
      ? 'UI Toolkit ok'
      : uiToolkit.problems > 0
        ? `UI Toolkit: ${plural(uiToolkit.problems, 'problem')}`
        : `${uiToolkit.queriesResolved}/${uiToolkit.queriesTotal} Q<T>() resolve`;

  const soMarker: Marker =
    scriptableObjects === 'skipped' ? 'skip' : scriptableObjects === 'clean' ? 'ok' : 'bad';
  const soLabel =
    scriptableObjects === 'skipped' || scriptableObjects === 'clean'
      ? 'no ScriptableObject drift'
      : `${plural(scriptableObjects.drift, 'ScriptableObject drift')}`;

  const inputMarker: Marker = input === 'skipped' ? 'skip' : input === 'clean' ? 'ok' : 'bad';
  const inputLabel =
    input === 'skipped' || input === 'clean'
      ? 'input actions ok'
      : `input: ${plural(input.problems, 'problem')}`;

  // ── What Unity itself said after the turn ─────────────────────────────────
  const consoleCheckMarker = consoleMarker(consoleCheck);
  const consoleLabel = consoleRowLabel(consoleCheck);
  const testsCheckMarker = testsMarker(tests);
  const testsLabel = testsRowLabel(tests);

  // A skipped check is NOT a passing one: when the bridge is down and the budget
  // runs out, all three skip — and this used to render a green "Verified".
  const verdict = verifiedVerdict([
    compileMarker,
    analyzersMarker,
    guidsMarker,
    uiMarker,
    soMarker,
    inputMarker,
    consoleCheckMarker,
    testsCheckMarker,
  ]);
  const missingGuids = guids !== 'skipped' && guids !== 'intact' ? guids.missing : [];
  const consoleItems =
    consoleCheck !== 'skipped' && consoleCheck !== 'clean' && !('unknown' in consoleCheck)
      ? consoleCheck.items
      : [];
  const testFailures = tests !== 'skipped' ? tests.failures : [];
  const hasDetail =
    touchedFiles.length > 0 ||
    missingGuids.length > 0 ||
    consoleItems.length > 0 ||
    testFailures.length > 0;

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
          {uiToolkit !== 'skipped' && (
            <>
              <span className="ai-verified-sep">·</span>
              <span className="ai-verified-item">
                <MarkerIcon marker={uiMarker} />
                {uiLabel}
              </span>
            </>
          )}
          {scriptableObjects !== 'skipped' && (
            <>
              <span className="ai-verified-sep">·</span>
              <span className="ai-verified-item">
                <MarkerIcon marker={soMarker} />
                {soLabel}
              </span>
            </>
          )}
          {input !== 'skipped' && (
            <>
              <span className="ai-verified-sep">·</span>
              <span className="ai-verified-item">
                <MarkerIcon marker={inputMarker} />
                {inputLabel}
              </span>
            </>
          )}
          {consoleCheck !== 'skipped' && (
            <>
              <span className="ai-verified-sep">·</span>
              <span className="ai-verified-item">
                <MarkerIcon marker={consoleCheckMarker} />
                {consoleLabel}
              </span>
            </>
          )}
          {tests !== 'skipped' && (
            <>
              <span className="ai-verified-sep">·</span>
              <span className="ai-verified-item">
                <MarkerIcon marker={testsCheckMarker} />
                {testsLabel}
              </span>
            </>
          )}
          {repair && (
            <>
              <span className="ai-verified-sep">·</span>
              <span className="ai-verified-item ai-verified-files">1 repair pass</span>
            </>
          )}
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
          {consoleItems.length > 0 && (
            <>
              <div className="ai-verified-body-label ai-verified-error-label">New console errors</div>
              <ul className="ai-verified-file-list">
                {consoleItems.map((item, i) => (
                  <li key={`${item.logType}-${item.location ?? 'external'}-${i}`}>
                    [{item.logType}] {item.firstLine}
                    {item.location ? ` — ${item.location}` : ''}
                    {item.count > 1 ? ` ×${item.count}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {testFailures.length > 0 && (
            <>
              <div className="ai-verified-body-label ai-verified-error-label">Failed tests</div>
              <ul className="ai-verified-file-list">
                {testFailures.map((f) => (
                  <li key={f.fullName}>
                    {f.fullName}
                    {f.message ? ` — ${f.message}` : ''}
                  </li>
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
