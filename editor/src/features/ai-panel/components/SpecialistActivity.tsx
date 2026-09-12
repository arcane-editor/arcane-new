import type { SpecialistResult } from '../services/specialists/contracts';
import { SPECIALISTS } from '../services/specialists/definitions';

export default function SpecialistActivity({ run }: { run: SpecialistResult }) {
  return (
    <details className="ai-specialist-activity">
      <summary>
        <strong>{SPECIALISTS[run.role]?.label ?? run.role}</strong>
        <span>{run.status}{run.activity ? ` · ${run.activity.replace(/_/g, ' ')}` : ''}</span>
      </summary>
      <p>{run.objective}</p>
      {run.summary && <p className="ai-specialist-summary">{run.summary}</p>}
      {run.changedArtifacts.length > 0 && <ul>{run.changedArtifacts.map((path) => <li key={path}>{path}</li>)}</ul>}
      {run.evidence.length > 0 && <ul>{run.evidence.map((e) => <li key={e.id}>
        <strong>{e.kind.replace(/-/g, ' ')}: {e.status.replace(/-/g, ' ')}</strong> — {e.summary}
      </li>)}</ul>}
      <small>{run.modelCalls} model calls · {run.inputTokens + run.outputTokens} tokens</small>
    </details>
  );
}
