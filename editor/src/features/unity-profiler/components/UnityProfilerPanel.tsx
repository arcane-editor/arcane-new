import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Circle, Square, FolderOpen, Download, RefreshCw, Sparkles } from 'lucide-react';
import { useProfilerStore } from '../../../stores/profiler';
import { useWorkspaceStore } from '../../../stores/workspace';
import { attachUnityEvidence } from '../../ai-panel';
import { frameStatistics, aggregateSamples } from '../services/analysis';
import type { ProfilerFrame, ProfilerSample } from '../../../types/profiler';
import './profiler.css';
const ms = (n: number | null | undefined) => n == null ? '—' : `${n.toFixed(2)} ms`;
export function UnityProfilerPanel() {
  const s = useProfilerStore();
  const [view, setView] = useState<'hierarchy' | 'timeline' | 'hotspots' | 'counters'>('hierarchy');
  const [selected, setSelected] = useState<ProfilerSample | null>(null);
  const [comparison, setComparison] = useState<ProfilerFrame[]>([]);
  const [compareId, setCompareId] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const rows = s.data?.samples ?? [];
  const virtual = useVirtualizer({ count: view === 'hierarchy' ? rows.length : 0, getScrollElement: () => scroll.current, estimateSize: () => 27, overscan: 10 });
  const statistics = useMemo(() => frameStatistics(s.frames), [s.frames]);
  const baseline = useMemo(() => frameStatistics(comparison), [comparison]);
  const hotspots = useMemo(() => aggregateSamples(rows), [rows]);
  const frame = s.frames.find(f => f.frame === s.frame);
  useEffect(() => { void s.refreshCaptures(); }, []);
  useEffect(() => { setSelected(null); }, [s.captureId, s.frame, s.thread]);
  const reportError = (e: unknown) => useProfilerStore.setState({ error: String(e) });
  const importCapture = async () => {
    try { const source = await open({ filters: [{ name: 'UnityIDE capture', extensions: ['unityide-profile'] }], multiple: false });
      if (typeof source !== 'string') return;
      const id = await invoke<string>('profiler_import', { source }); await s.refreshCaptures(); await s.selectCapture(id);
    } catch (e) { reportError(e); }
  };
  const exportCapture = async () => {
    try { if (!s.captureId) return; const destination = await save({ defaultPath: 'Unity capture.unityide-profile', filters: [{ name: 'UnityIDE capture', extensions: ['unityide-profile'] }] });
      if (destination) await invoke('profiler_export', { captureId: s.captureId, destination });
    } catch (e) { reportError(e); }
  };
  const explain = () => void attachUnityEvidence({ source: 'profiler', label: selected ? `Profiler: ${selected.name}` : `Profiler frame ${s.frame}`, capturedAt: new Date().toISOString(), workspacePath: useWorkspaceStore.getState().workspacePath,
    data: { metadata: s.captures.find(c => c.id === s.captureId), frame, thread: s.data?.threads.find(t => t.id === s.thread), sample: selected, statistics, counters: s.data?.counters, topSamples: hotspots.slice(0, 20), includedSamples: rows.length, totalSamples: s.data?.total, droppedFrames: s.status?.captureId === s.captureId ? s.status.droppedFrames : undefined } });
  const openSource = async (path: string, line: number) => {
    try { await useWorkspaceStore.getState().openFile(path, path.split(/[\\/]/).pop() ?? path); window.dispatchEvent(new CustomEvent('navigate-to-line', { detail: { line, column: 1 } })); } catch (e) { reportError(e); }
  };
  return <section className="unity-profiler" aria-label="Unity Profiler">
    <div className="up-toolbar">
      <button onClick={() => void s.connect()} disabled={s.busy} title="Refresh Unity targets"><RefreshCw size={13} /> Connect Unity</button>
      <select aria-label="Profiler target" value={s.target ?? ''} disabled={s.recording || s.saving} onChange={e => useProfilerStore.setState({ target: Number(e.target.value) })}>
        <option value="" disabled>Select target</option>{s.capabilities?.targets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      {s.recording ? <button className="up-recording" onClick={() => void s.stop()} disabled={s.busy}><Square size={12} /> Stop</button> : <button onClick={() => void s.start()} disabled={s.target == null || s.busy || s.saving}><Circle size={12} /> Record</button>}
      <span className="up-state">{s.recording ? 'Recording' : s.saving ? 'Saving capture…' : 'Idle'}</span>
      <span className="up-spacer" />
      <button onClick={() => void importCapture()} disabled={s.recording || s.saving} title="Import capture"><FolderOpen size={13} /> Import</button>
      <button onClick={() => void exportCapture()} disabled={!s.captureId} title="Export capture"><Download size={13} /> Export</button>
      <button onClick={explain} disabled={!s.data}><Sparkles size={13} /> Analyze with AI</button>
    </div>
    {s.error && <div className="up-error" role="alert">{s.error}<button onClick={() => useProfilerStore.setState({ error: null })} aria-label="Dismiss profiler error">×</button></div>}
    <div className="up-capturebar">
      <select aria-label="Saved capture" value={s.captureId ?? ''} disabled={s.recording || s.saving} onChange={e => void s.selectCapture(e.target.value)}><option value="" disabled>Saved captures</option>{s.captures.map(c => <option key={c.id} value={c.id}>{c.project} · {c.target} · {new Date(c.capturedAt).toLocaleString()}</option>)}</select>
      <span>{statistics.count} frames</span><span>Median <b>{ms(statistics.median)}</b></span><span>P95 <b>{ms(statistics.p95)}</b></span>
      <select aria-label="Compare capture" value={compareId} onChange={async e => { const id = e.target.value; setCompareId(id); try { setComparison(id ? await invoke<ProfilerFrame[]>('profiler_frames', { captureId: id }) : []); } catch (error) { reportError(error); } }}><option value="">Compare with…</option>{s.captures.filter(c => c.id !== s.captureId).map(c => <option key={c.id} value={c.id}>{c.project} · {new Date(c.capturedAt).toLocaleString()}</option>)}</select>
      {baseline.p95 != null && statistics.p95 != null && <span>P95 change <b>{ms(statistics.p95 - baseline.p95)}</b></span>}
    </div>
    {!s.frames.length ? <div className="up-empty"><h3>Find the cost of a Unity frame</h3><p>Connect Unity, choose the Editor or a development player, and record a scenario. Select a frame to inspect its threads, script callbacks and allocations.</p><p>Saved captures can be opened without Unity running. Recording starts only when you choose Record.</p></div> : <>
      <div className="up-frame-strip" aria-label="Captured frames">{s.frames.slice(0, 300).reverse().map(f => <button key={f.frame} className={f.frame === s.frame ? 'selected' : ''} aria-label={`Frame ${f.frame}: ${ms(f.durationMs)}`} title={`Frame ${f.frame} · ${ms(f.durationMs)}`} onClick={() => void s.selectFrame(f.frame)}><span style={{ height: `${Math.min(100, Math.max(3, f.durationMs / 50 * 100))}%` }} /></button>)}</div>
      <div className="up-toolbar">
        <label>Frame <input className="up-frame-input" type="number" value={s.frame ?? ''} onChange={e => { const frame = Number(e.target.value); if (s.frames.some(f => f.frame === frame)) void s.selectFrame(frame); }} /></label>
        <b>{ms(frame?.durationMs)}</b><span>GPU {ms(frame?.gpuMs)}</span>
        <select aria-label="Thread" value={s.thread} onChange={e => { useProfilerStore.setState({ thread: Number(e.target.value), offset: 0 }); void s.query(); }}>{s.data?.threads.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <label><input type="checkbox" checked={s.following} onChange={e => useProfilerStore.setState({ following: e.target.checked })} /> Follow latest</label>
        <span className="up-spacer" /><input aria-label="Filter samples" placeholder="Find a marker or method…" value={s.search} onChange={e => { useProfilerStore.setState({ search: e.target.value, offset: 0 }); void s.query(); }} />
      </div>
      <div className="up-views" role="tablist" aria-label="Analysis view">{(['hierarchy', 'timeline', 'hotspots', 'counters'] as const).map(v => <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>{v === 'counters' ? 'Unity counters' : v[0].toUpperCase() + v.slice(1)}</button>)}<span className="up-spacer" /><span>{s.status?.droppedFrames ? `${s.status.droppedFrames} frames dropped` : ''}</span></div>
      <div className="up-analysis">
        <div className="up-main">
          {view === 'hierarchy' && <><div className="up-row up-columns"><span>Sample</span><span>Total</span><span>Self</span><span>GC bytes</span></div><div className="up-samples" ref={scroll}><div style={{ height: virtual.getTotalSize(), position: 'relative' }}>{virtual.getVirtualItems().map(item => { const row = rows[item.index]; return <button key={row.id} className={`up-row ${selected?.id === row.id ? 'selected' : ''}`} style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }} onClick={() => setSelected(row)}><span style={{ paddingLeft: Math.min(row.depth, 24) * 12 }} title={row.name}>{row.name}</span><span>{ms(row.durationMs)}</span><span>{ms(row.selfMs)}</span><span>{row.allocationBytes ?? '—'}</span></button>; })}</div></div></>}
          {view === 'timeline' && <div className="up-timeline"><div className="up-timeline-label">{ms(0)}<span>{ms(frame?.durationMs)}</span></div><div style={{ position: 'relative', height: Math.max(1, ...rows.map(r => r.depth + 1)) * 25 }}>{rows.map(row => <button key={row.id} title={`${row.name} · ${ms(row.durationMs)}`} onClick={() => setSelected(row)} style={{ position: 'absolute', left: `${Math.max(0, row.startMs) / Math.max(.01, frame?.durationMs ?? 1) * 100}%`, width: `${Math.max(.15, row.durationMs / Math.max(.01, frame?.durationMs ?? 1) * 100)}%`, top: row.depth * 25, height: 23, background: `hsl(${(row.category * 47 + 200) % 360} 35% 35%)` }}>{row.name}</button>)}</div></div>}
          {view === 'hotspots' && <div className="up-scroll"><p className="up-note">Aggregated samples on this page, sorted by self time.</p><div className="up-row up-columns"><span>Marker</span><span>Self</span><span>Calls</span><span>GC bytes</span></div>{hotspots.map(row => <div key={row.name} className="up-row"><span title={row.name}>{row.name}</span><span>{ms(row.selfMs)}</span><span>{row.calls}</span><span>{row.allocationBytes}</span></div>)}</div>}
          {view === 'counters' && <div className="up-scroll"><p className="up-note">Counters reported by this target and thread. Unavailable counters are not inferred from other measurements.</p>{s.data?.counters.map(c => <div key={c.name} className="up-counter"><span>{c.name}</span><b>{c.value.toLocaleString()} {c.unit === 2 ? 'bytes' : c.unit === 1 ? 'ns' : ''}</b></div>)}{!s.data?.counters.length && <p className="up-note">No counter data in this frame.</p>}</div>}
          <div className="up-pagination"><button disabled={s.offset === 0} onClick={() => { useProfilerStore.setState({ offset: Math.max(0, s.offset - 1000) }); void s.query(); }}>Previous</button><span>{s.offset + 1}–{s.offset + rows.length} of {s.data?.total ?? 0} samples</span><button disabled={s.offset + rows.length >= (s.data?.total ?? 0)} onClick={() => { useProfilerStore.setState({ offset: s.offset + 1000 }); void s.query(); }}>Next</button></div>
        </div>
        {selected && <aside className="up-detail"><h4>{selected.name}</h4><p>Total {ms(selected.durationMs)} · Self {ms(selected.selfMs)}</p><p>GC allocation {selected.allocationBytes == null ? 'not recorded' : `${selected.allocationBytes} bytes`}</p><h4>Recorded call stack</h4>{selected.callstack.length ? selected.callstack.map((loc, i) => <button key={i} disabled={!loc.path} onClick={() => void openSource(loc.path, loc.line)}>{loc.method}<small>{loc.path ? `${loc.path}:${loc.line}` : 'Source unavailable'}</small></button>) : <p>No call stack was recorded for this sample.</p>}</aside>}
      </div>
    </>}
  </section>;
}
