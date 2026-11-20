import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ProjectWire, type Unit } from '../../../api';
import { useCan } from '../../../auth';
import { colorLabel } from '../../../colors';
import { Loading, Swatch } from '../../../components/ui';
import { useWireChecks, type Step } from '../../../checkQueue';

export const unitsKey = (projectId: string) => ['units', projectId];

export function useUnits(projectId: string) {
  return useQuery({ queryKey: unitsKey(projectId), queryFn: () => api.get<Unit[]>(`/api/projects/${projectId}/units`) });
}

/** The unit chosen in the URL (?unit=), "" = the project itself. */
export function useUnitParam(): [string, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const unitId = params.get('unit') ?? '';
  const set = (id: string) =>
    setParams(
      (p) => {
        if (id) p.set('unit', id);
        else p.delete('unit');
        return p;
      },
      { replace: true },
    );
  return [unitId, set];
}

export function UnitPicker({ projectId }: { projectId: string }) {
  const units = useUnits(projectId).data ?? [];
  const [unitId, setUnitId] = useUnitParam();
  if (!units.length) return null;
  return (
    <label className="unit-picker">
      <span className="small muted">Unit</span>
      <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
        <option value="">— whole project (no unit) —</option>
        {units.map((u) => (
          <option key={u.id} value={u.id}>
            {u.serial} · {u.status}
          </option>
        ))}
      </select>
    </label>
  );
}

const isDone = (w: ProjectWire, s: Step) => !!w[s] && !w[s]!.stale && (s === 'crimped' || w[s]!.ok);
const isFailed = (w: ProjectWire) => !!w.tested && !w.tested.stale && !w.tested.ok;

function PendingNote({ pending }: { pending: number }) {
  if (!pending) return null;
  return (
    <p className="export-notice">
      <span aria-hidden>⏳</span>
      <span>
        {pending} tick{pending > 1 ? 's' : ''} saved on this device, waiting for the connection to the server. They are sent
        automatically.
      </span>
    </p>
  );
}

export function ChecklistView({ projectId }: { projectId: string }) {
  const [unitId] = useUnitParam();
  const { data, error, tick, pending } = useWireChecks(projectId, unitId);
  const canTick = useCan('projects.edit');
  const [hideDone, setHideDone] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [, setParams] = useSearchParams();

  if (!data) return <Loading error={error} />;
  const { wires, connections } = data;
  const total = wires.length;
  const crimped = wires.filter((w) => isDone(w, 'crimped')).length;
  const tested = wires.filter((w) => isDone(w, 'tested')).length;
  const failed = wires.filter(isFailed).length;
  const stale = wires.filter((w) => w.crimped?.stale || w.tested?.stale).length;

  async function fail(w: ProjectWire) {
    const note = prompt(`What is wrong with ${w.ref}? (e.g. "no continuity", "swapped with W13")`, w.tested?.note ?? '');
    if (note === null) return;
    await tick([w.id], 'tested', true, { ok: false, note });
  }

  return (
    <div>
      <div className="section-head">
        <UnitPicker projectId={projectId} />
        <button
          className="btn btn-primary"
          onClick={() =>
            setParams(
              (p) => {
                p.set('view', 'test');
                return p;
              },
              { replace: true },
            )
          }
          title="One wire at a time, big buttons: for testing at the machine with a phone"
        >
          📱 Test mode
        </button>
      </div>
      <p className="small muted">
        Tick each wire as it is made (crimped) and as its continuity is checked (tested), or mark a failed test with a note.
        Ticks are shared with everyone and kept when the project is locked. Without a connection they are kept on this
        device and sent later. A wire changed after it was ticked shows as <span className="tick-stale-text">changed</span>.
      </p>
      <PendingNote pending={pending} />
      <div className="progress-grid">
        <ProgressLine label="Crimped" done={crimped} total={total} />
        <ProgressLine label="Tested" done={tested} total={total} failed={failed} />
      </div>
      {stale > 0 && (
        <p className="export-notice">
          <span aria-hidden>⚠</span>
          <span>{stale} wire(s) changed after they were ticked.</span>
        </p>
      )}
      <label className="small inline-check">
        <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide tested wires
      </label>
      {connections.map((c) => {
        const ws = wires.filter((w) => w.connectionId === c.id);
        if (!ws.length) return null;
        const shown = hideDone ? ws.filter((w) => !isDone(w, 'tested')) : ws;
        const cDone = ws.filter((w) => isDone(w, 'tested')).length;
        const cFailed = ws.filter(isFailed).length;
        const isCollapsed = collapsed.has(c.id);
        const toggle = () => {
          const next = new Set(collapsed);
          if (isCollapsed) next.delete(c.id);
          else next.add(c.id);
          setCollapsed(next);
        };
        return (
          <div key={c.id} className="panel checklist-conn">
            <div className="checklist-head">
              <button className="btn-link checklist-toggle" onClick={toggle} aria-expanded={!isCollapsed}>
                {isCollapsed ? '▸' : '▾'} <strong>{c.name}</strong>
              </button>
              <span className={`small ${cDone === ws.length ? 'ok-text' : 'muted'}`}>
                {cDone}/{ws.length} tested
              </span>
              {cFailed > 0 && <span className="small error-text">{cFailed} failed</span>}
              <span className="grow" />
              {canTick && (
                <span className="btn-row">
                  <button className="btn btn-sm" onClick={() => tick(ws.filter((w) => !isDone(w, 'crimped')).map((w) => w.id), 'crimped', true)}>
                    All crimped
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => tick(ws.filter((w) => !isDone(w, 'tested') && !isFailed(w)).map((w) => w.id), 'tested', true)}
                  >
                    All tested
                  </button>
                </span>
              )}
            </div>
            {!isCollapsed && (
              <div className="table-wrap">
                <table className="table checklist-table">
                  <thead>
                    <tr>
                      <th>Wire</th>
                      <th>From → To</th>
                      <th className="center">Crimped</th>
                      <th className="center">Tested</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((w) => (
                      <tr key={w.id} className={isFailed(w) ? 'row-failed' : isDone(w, 'tested') ? 'row-done' : ''}>
                        <td className="nowrap">
                          <span className="swatches">
                            <Swatch color={w.color} size={12} /> <strong>{w.ref}</strong>
                          </span>
                          <div className="small muted">{[w.gauge, w.lengthMm != null && `${w.lengthMm} mm`].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className="small">
                          {w.from.text}
                          <br />→ {w.to.text}
                          {isFailed(w) && <div className="error-text">✗ {w.tested!.note || 'Test failed'}</div>}
                        </td>
                        {(['crimped', 'tested'] as Step[]).map((s) => (
                          <td key={s} className="center">
                            <TickBox wire={w} step={s} disabled={!canTick} onChange={(v) => tick([w.id], s, v)} />
                          </td>
                        ))}
                        <td className="right">
                          {canTick && (
                            <button className="btn btn-sm" onClick={() => (isFailed(w) ? tick([w.id], 'tested', false) : fail(w))}>
                              {isFailed(w) ? 'Clear' : 'Failed…'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {total === 0 && <p className="empty">No wires yet.</p>}
    </div>
  );
}

function TickBox({ wire, step, disabled, onChange }: { wire: ProjectWire; step: Step; disabled: boolean; onChange: (v: boolean) => void }) {
  const t = wire[step];
  const done = isDone(wire, step);
  const title = t
    ? `${t.pending ? 'Not sent yet. ' : ''}${t.stale ? 'Changed since ticked. ' : ''}${step === 'crimped' ? 'Crimped' : t.ok ? 'Tested' : 'Failed'} by ${t.doneBy}, ${new Date(t.doneAt).toLocaleString()}`
    : '';
  return (
    <label className={`tick ${t?.stale ? 'tick-stale' : ''} ${t?.pending ? 'tick-pending' : ''}`} title={title}>
      <input type="checkbox" checked={done} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={`${wire.ref} ${step}`} />
      {t?.stale && <span className="small tick-stale-text">changed</span>}
      {done && <span className="tick-by small muted">{t!.pending ? '⏳' : t!.doneBy}</span>}
    </label>
  );
}

export function ProgressLine({ label, done, total, failed = 0 }: { label: string; done: number; total: number; failed?: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const failPct = total ? (failed / total) * 100 : 0;
  return (
    <div className="progress-line">
      <span className="small">
        {label}: <strong>{done}</strong> / {total} ({pct}%){failed > 0 && <span className="error-text"> · {failed} failed</span>}
      </span>
      <div className="progress progress-stack">
        <div className="progress-bar" style={{ width: `${pct}%`, background: pct === 100 ? 'var(--ok)' : undefined }} />
        {failed > 0 && <div className="progress-bar progress-fail" style={{ width: `${failPct}%` }} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Test mode: one wire at a time, for a phone at the machine
// ---------------------------------------------------------------------------------------------

export function TestMode({ projectId }: { projectId: string }) {
  const [unitId] = useUnitParam();
  const units = useUnits(projectId).data ?? [];
  const unit = units.find((u) => u.id === unitId);
  const { data, error, tick, pending } = useWireChecks(projectId, unitId);
  const canTick = useCan('projects.edit');
  const [, setParams] = useSearchParams();
  const [step, setStep] = useState<Step>('tested');
  const [conn, setConn] = useState('');
  const [index, setIndex] = useState(0);
  const [failing, setFailing] = useState(false);
  const [note, setNote] = useState('');

  const list = useMemo(() => (data ? data.wires.filter((w) => !conn || w.connectionId === conn) : []), [data, conn]);
  const open = list.filter((w) => (step === 'crimped' ? !isDone(w, 'crimped') : !isDone(w, 'tested') && !isFailed(w)));
  // Stay on the wire being shown; move on to the next open one when it is done.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const current = list.find((w) => w.id === currentId) ?? open[0] ?? null;
  useEffect(() => {
    if (current && current.id !== currentId) setCurrentId(current.id);
  }, [current, currentId]);
  useEffect(() => setIndex(current ? list.indexOf(current) : 0), [current, list]);

  // Keep the screen on while testing, where supported.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
    return () => void lock?.release().catch(() => {});
  }, []);

  if (!data) return <Loading error={error} />;

  const exit = () =>
    setParams(
      (p) => {
        p.set('view', 'checklist');
        return p;
      },
      { replace: true },
    );
  const nextOpen = (from: ProjectWire) => {
    const i = list.indexOf(from);
    const after = [...list.slice(i + 1), ...list.slice(0, i)];
    return after.find((w) => (step === 'crimped' ? !isDone(w, 'crimped') : !isDone(w, 'tested') && !isFailed(w)))?.id ?? null;
  };
  async function mark(ok: boolean) {
    if (!current) return;
    const next = nextOpen(current);
    await tick([current.id], step, true, ok ? {} : { ok: false, note });
    setFailing(false);
    setNote('');
    setCurrentId(next);
  }
  const go = (d: number) => {
    if (!list.length) return;
    const i = (index + d + list.length) % list.length;
    setCurrentId(list[i].id);
    setFailing(false);
  };

  const doneCount = list.length - open.length;
  const t = current?.[step];
  return (
    <div className="test-mode">
      <div className="test-top">
        <button className="btn btn-sm" onClick={exit}>
          ← Checklist
        </button>
        <span className="seg">
          <button className={step === 'crimped' ? 'active' : ''} onClick={() => setStep('crimped')}>
            Crimp
          </button>
          <button className={step === 'tested' ? 'active' : ''} onClick={() => setStep('tested')}>
            Test
          </button>
        </span>
        <select value={conn} onChange={(e) => (setConn(e.target.value), setCurrentId(null))} aria-label="Connection">
          <option value="">All connections</option>
          {data.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="test-progress small">
        {unit && <strong>Unit {unit.serial} · </strong>}
        {doneCount} / {list.length} {step === 'crimped' ? 'crimped' : 'tested'}
        {pending > 0 && <span className="muted"> · ⏳ {pending} waiting to be sent</span>}
      </div>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${list.length ? (doneCount / list.length) * 100 : 0}%` }} />
      </div>

      {!current ? (
        <div className="test-card test-done">
          <div className="test-big">✓</div>
          <p>Every wire here is {step === 'crimped' ? 'crimped' : 'tested'}.</p>
        </div>
      ) : (
        <div className={`test-card ${t && !t.stale ? (t.ok ? 'test-card-ok' : 'test-card-fail') : ''}`}>
          <div className="test-ref">
            <Swatch color={current.color} size={22} /> {current.ref}
            <span className="small muted"> {current.connectionName}</span>
          </div>
          <div className="test-end">
            <span className="small muted">From</span>
            <strong>{current.from.short}</strong>
            <span className="small">{current.from.text}</span>
          </div>
          <div className="test-arrow">↓</div>
          <div className="test-end">
            <span className="small muted">To</span>
            <strong>{current.to.short}</strong>
            <span className="small">{current.to.text}</span>
          </div>
          <div className="small muted test-props">
            {[colorLabel(current.color), current.gauge, current.lengthMm != null && `${current.lengthMm} mm`, current.cableName && `cable ${current.cableName}`]
              .filter(Boolean)
              .join(' · ')}
            {current.note && <div>Note: {current.note}</div>}
          </div>
          {t && (
            <p className="small">
              {t.stale ? '⚠ Changed since: ' : ''}
              {step === 'crimped' ? 'Crimped' : t.ok ? 'Passed' : `Failed${t.note ? `: ${t.note}` : ''}`} — {t.doneBy}
              {t.pending && ' (not sent yet)'}
            </p>
          )}
          {canTick &&
            (failing ? (
              <div className="test-fail-form">
                <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is wrong? e.g. no continuity" />
                <div className="test-buttons">
                  <button className="btn test-btn" onClick={() => setFailing(false)}>
                    Cancel
                  </button>
                  <button className="btn btn-danger test-btn test-btn-fail" onClick={() => mark(false)}>
                    Save failure
                  </button>
                </div>
              </div>
            ) : (
              <div className="test-buttons">
                {step === 'tested' && (
                  <button className="btn test-btn test-btn-fail" onClick={() => setFailing(true)}>
                    ✗ Fail
                  </button>
                )}
                <button className="btn btn-primary test-btn test-btn-pass" onClick={() => mark(true)}>
                  ✓ {step === 'crimped' ? 'Crimped' : 'Pass'}
                </button>
              </div>
            ))}
          <div className="test-nav">
            <button className="btn" onClick={() => go(-1)}>
              ‹ Previous
            </button>
            <span className="small muted">
              {index + 1} / {list.length}
            </span>
            <button className="btn" onClick={() => go(1)}>
              Skip ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
