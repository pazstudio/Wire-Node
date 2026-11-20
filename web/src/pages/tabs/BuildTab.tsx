import { useDeferredValue, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  downloadText,
  errorMessage,
  slug,
  toCsv,
  type BuildList,
  type CheckResult,
  type DesignIssue,
  type ProjectWire,
  type ProjectWires,
  type Severity,
} from '../../api';
import { colorLabel } from '../../colors';
import { useCan } from '../../auth';
import { Loading, Swatch } from '../../components/ui';
import { QrCode, appUrl } from '../../components/qr';
import { ChecklistView, TestMode } from './build/checklist';
import { UnitsView } from './build/units';
import { WiresView } from './build/wires';
import { FirmwareView } from './build/firmware';
import { DrawingsView } from './build/drawings';
import { useWireChecks } from '../../checkQueue';

const VIEWS = [
  { key: 'checks', label: 'Checks' },
  { key: 'wires', label: 'Wires' },
  { key: 'parts', label: 'Parts & cut list' },
  { key: 'units', label: 'Units' },
  { key: 'checklist', label: 'Checklist' },
  { key: 'test', label: 'Test mode' },
  { key: 'labels', label: 'Labels' },
  { key: 'drawings', label: 'Drawings' },
  { key: 'nets', label: 'Nets' },
  { key: 'firmware', label: 'Firmware' },
] as const;
type View = (typeof VIEWS)[number]['key'];

export const buildKeys = {
  checks: (pid: string) => ['checks', pid],
  list: (pid: string) => ['build-list', pid],
  wires: (pid: string, unitId = '') => ['project-wires', pid, unitId],
  status: (pid: string) => ['build-status', pid],
};

export default function BuildTab({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View) || 'checks';
  const setView = (v: View) =>
    setParams(
      (p) => {
        p.set('view', v);
        return p;
      },
      { replace: true },
    );
  return (
    <section>
      <div className="section-head no-print" hidden={view === 'test'}>
        <div className="seg" role="tablist">
          {VIEWS.filter((v) => v.key !== 'test' || view === 'test').map((v) => (
            <button key={v.key} className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)} role="tab">
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {view === 'checks' && <ChecksView projectId={projectId} />}
      {view === 'parts' && <PartsView projectId={projectId} projectName={projectName} />}
      {view === 'wires' && <WiresView projectId={projectId} />}
      {view === 'units' && <UnitsView projectId={projectId} />}
      {view === 'checklist' && <ChecklistView projectId={projectId} />}
      {view === 'test' && <TestMode projectId={projectId} />}
      {view === 'labels' && <LabelsView projectId={projectId} projectName={projectName} />}
      {view === 'drawings' && <DrawingsView projectId={projectId} projectName={projectName} />}
      {view === 'nets' && <NetsView projectId={projectId} />}
      {view === 'firmware' && <FirmwareView projectId={projectId} projectName={projectName} />}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

const SEVERITY_LABEL: Record<Severity, string> = { error: 'Errors', warning: 'Warnings', info: 'Notes' };
const SEVERITY_ICON: Record<Severity, string> = { error: '⛔', warning: '⚠', info: 'ℹ' };

function useChecks(projectId: string) {
  return useQuery({
    queryKey: buildKeys.checks(projectId),
    queryFn: () => api.get<CheckResult>(`/api/projects/${projectId}/checks`),
    refetchOnMount: 'always',
  });
}

function ChecksView({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = useChecks(projectId);
  const canEdit = useCan('projects.edit');
  const [shown, setShown] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: false });
  const [showDismissed, setShowDismissed] = useState(false);

  async function setDismissed(issue: DesignIssue, dismiss: boolean) {
    let note = '';
    if (dismiss) {
      const answer = prompt('Why is this intended? (optional, shown to others)', '');
      if (answer === null) return;
      note = answer;
    }
    try {
      const res = dismiss
        ? await api.post<CheckResult>(`/api/projects/${projectId}/check-dismissals`, { key: issue.key, title: issue.title, note })
        : await api.del<CheckResult>(`/api/projects/${projectId}/check-dismissals?key=${encodeURIComponent(issue.key)}`);
      qc.setQueryData(buildKeys.checks(projectId), res);
      void qc.invalidateQueries({ queryKey: buildKeys.status(projectId) });
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  if (!q.data) return <Loading error={q.error} />;
  const { issues, counts, dismissed } = q.data;
  return (
    <div>
      <p className="small muted">
        Mistakes found in the wiring: shorts between supplies (from pin names such as 24V, 5V, GND), wires on pins the
        connector does not have, wires too thin for the max current set on their pins, and missing gauges or lengths.
        Current limits are a rough guide for wires in a bundle.
      </p>
      <div className="check-summary">
        {(['error', 'warning', 'info'] as Severity[]).map((s) => (
          <label key={s} className={`check-chip check-${s}`}>
            <input type="checkbox" checked={shown[s]} onChange={(e) => setShown({ ...shown, [s]: e.target.checked })} />
            <span aria-hidden>{SEVERITY_ICON[s]}</span> {counts[s]} {SEVERITY_LABEL[s].toLowerCase()}
          </label>
        ))}
      </div>
      {issues.length === 0 ? (
        <p className="empty">No problems found. 🎉</p>
      ) : (
        <ul className="issue-list">
          {issues
            .filter((i) => shown[i.severity])
            .map((i) => (
              <IssueItem key={i.key} issue={i} projectId={projectId} onDismiss={canEdit ? () => setDismissed(i, true) : undefined} />
            ))}
        </ul>
      )}
      {dismissed.length > 0 && (
        <div className="mt">
          <button className="btn-link small" onClick={() => setShowDismissed(!showDismissed)}>
            {showDismissed ? '▾' : '▸'} {dismissed.length} finding{dismissed.length > 1 ? 's' : ''} marked as intended
          </button>
          {showDismissed && (
            <ul className="issue-list mt">
              {dismissed.map((i) => (
                <IssueItem key={i.key} issue={i} projectId={projectId} onRestore={canEdit ? () => setDismissed(i, false) : undefined} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function IssueItem({
  issue,
  projectId,
  onDismiss,
  onRestore,
}: {
  issue: DesignIssue;
  projectId: string;
  onDismiss?: () => void;
  onRestore?: () => void;
}) {
  const [all, setAll] = useState(false);
  const LIMIT = 8;
  const conns = issue.connections ?? [];
  const link = issue.connectionId
    ? { to: `/projects/${projectId}/connections/${issue.connectionId}`, text: 'Open connection' }
    : conns.length === 1
      ? { to: `/projects/${projectId}/connections/${conns[0].id}`, text: 'Open connection' }
      : issue.pcbId
        ? { to: `/projects/${projectId}/pcbs/${issue.pcbId}`, text: 'Open component' }
        : null;
  // A finding across several connections (e.g. a net through a harness): a link to each.
  const manyLinks = !issue.connectionId && conns.length > 1 ? conns : [];
  const LINKS_SHOWN = 6;
  return (
    <li className={`issue issue-${issue.severity} ${issue.dismissal ? 'issue-dismissed' : ''}`}>
      <div className="issue-head">
        <span className="issue-icon" aria-label={issue.severity}>
          {SEVERITY_ICON[issue.severity]}
        </span>
        <strong>{issue.title}</strong>
        {link && (
          <Link to={link.to} className="small issue-link">
            {link.text} →
          </Link>
        )}
        {manyLinks.length > 0 && (
          <span className="small issue-links">
            Open:{' '}
            {manyLinks.slice(0, all ? manyLinks.length : LINKS_SHOWN).map((c, i) => (
              <span key={c.id}>
                {i > 0 && ' · '}
                <Link to={`/projects/${projectId}/connections/${c.id}`}>{c.name}</Link>
              </span>
            ))}
            {!all && manyLinks.length > LINKS_SHOWN && (
              <>
                {' '}
                <button className="btn-link small" onClick={() => setAll(true)}>
                  +{manyLinks.length - LINKS_SHOWN} more
                </button>
              </>
            )}
          </span>
        )}
        {onDismiss && (
          <button className="btn btn-sm" onClick={onDismiss} title="Mark as intended: hide it and leave it out of the counts">
            Intended
          </button>
        )}
        {onRestore && (
          <button className="btn btn-sm" onClick={onRestore}>
            Show again
          </button>
        )}
      </div>
      {issue.dismissal && (
        <p className="small muted issue-dismissal">
          Marked as intended by {issue.dismissal.by}, {new Date(issue.dismissal.at).toLocaleDateString()}
          {issue.dismissal.note && <>: “{issue.dismissal.note}”</>}
        </p>
      )}
      {issue.items.length > 0 && (
        <ul className="issue-items small">
          {(all ? issue.items : issue.items.slice(0, LIMIT)).map((t, k) => (
            <li key={k}>{t}</li>
          ))}
          {issue.items.length > LIMIT && (
            <li>
              <button className="btn-link small" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : `Show all ${issue.items.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Parts & cut list
// ---------------------------------------------------------------------------------------------

const MARGIN_KEY = 'wn:cut-margin';

function readMargin(): { perWire: number; percent: number } {
  try {
    const v = JSON.parse(localStorage.getItem(MARGIN_KEY) ?? '');
    if (typeof v?.perWire === 'number' && typeof v?.percent === 'number') return v;
  } catch {
    /* none saved */
  }
  return { perWire: 0, percent: 0 };
}

const fmtM = (mm: number) => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`);

function PartsView({ projectId, projectName }: { projectId: string; projectName: string }) {
  const q = useQuery({
    queryKey: buildKeys.list(projectId),
    queryFn: () => api.get<BuildList>(`/api/projects/${projectId}/build-list`),
    refetchOnMount: 'always',
  });
  const [margin, setMarginState] = useState(readMargin);
  const [open, setOpen] = useState<string | null>(null);
  const setMargin = (m: typeof margin) => {
    setMarginState(m);
    try {
      localStorage.setItem(MARGIN_KEY, JSON.stringify(m));
    } catch {
      /* private mode */
    }
  };
  if (!q.data) return <Loading error={q.error} />;
  const b = q.data;
  /** Length to cut for a wire (or cable piece) of `mm`, with the margin. */
  const cut = (mm: number) => (mm + margin.perWire) * (1 + margin.percent / 100);
  const groupTotal = (g: BuildList['cutList'][number]) =>
    g.wires.reduce((s, w) => s + (w.lengthMm != null ? cut(w.lengthMm) : 0), 0);
  const cableTotal = (c: BuildList['cables'][number]) =>
    c.pieces.reduce((s, p) => s + (p.lengthMm != null ? cut(p.lengthMm) : 0), 0);

  function exportCsv() {
    const rows: (string | number | null)[][] = [['Section', 'Item', 'Gauge', 'Color', 'Shielded', 'Quantity', 'Total length (mm)', 'Missing length', 'Details']];
    for (const g of b.cutList) {
      rows.push(['Wire', '', g.gauge, colorLabel(g.color), g.shielded ? 'yes' : '', g.count, Math.round(groupTotal(g)), g.missingLength || '', '']);
    }
    for (const c of b.cables) {
      rows.push(['Cable', c.name, c.gauge, `${c.coreCount} cores`, c.shielded ? 'yes' : '', c.pieces.length, Math.round(cableTotal(c)), c.missingLength || '', c.pieces.map((p) => p.connection).join('; ')]);
    }
    for (const p of b.parts) {
      rows.push([p.kind === 'housing' ? 'Housing' : p.kind === 'crimp' ? 'Crimp' : 'Splice', p.name, '', '', '', p.count, '', '', p.where.join('; ')]);
    }
    rows.push([]);
    rows.push(['Cut list', 'Wire', 'Gauge', 'Color', 'Shielded', 'Connection', 'Cut length (mm)', 'From', 'To']);
    for (const g of b.cutList) {
      for (const w of g.wires) {
        rows.push(['', w.ref, g.gauge, colorLabel(g.color), g.shielded ? 'yes' : '', w.connection, w.lengthMm != null ? Math.round(cut(w.lengthMm)) : '', w.from, w.to]);
      }
    }
    downloadText(`${slug(projectName)}-bom.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  }

  return (
    <div className="build-print">
      <div className="section-head">
        <p className="small muted" style={{ margin: 0 }}>
          What to buy and cut for the {b.wireCount} wires of this project. Lengths come from each wire, or from its
          connection when the wire has none.
        </p>
        <div className="btn-row no-print">
          <button className="btn" onClick={exportCsv}>
            Download CSV
          </button>
          <button className="btn" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>
      <div className="form-row margin-row no-print">
        <label className="field">
          <span className="field-label">Extra per wire</span>
          <span className="input-row">
            <input
              type="number"
              min={0}
              step={5}
              value={margin.perWire}
              onChange={(e) => setMargin({ ...margin, perWire: Math.max(0, +e.target.value || 0) })}
              className="length-input"
            />{' '}
            mm
          </span>
        </label>
        <label className="field">
          <span className="field-label">Spare</span>
          <span className="input-row">
            <input
              type="number"
              min={0}
              max={200}
              value={margin.percent}
              onChange={(e) => setMargin({ ...margin, percent: Math.max(0, +e.target.value || 0) })}
              className="length-input"
            />{' '}
            %
          </span>
        </label>
        <p className="small muted">For stripping and service loops; added to every wire and cable piece.</p>
      </div>
      {b.wiresWithoutGauge > 0 && (
        <p className="export-notice">
          <span aria-hidden>⚠</span>
          <span>{b.wiresWithoutGauge} wire(s) have no gauge; they are listed without one.</span>
        </p>
      )}

      <h3>Loose wire</h3>
      {b.cutList.length === 0 ? (
        <p className="muted small">No loose wires (every wire is a core of a cable).</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Gauge</th>
                <th>Color</th>
                <th>Shielded</th>
                <th className="right">Wires</th>
                <th className="right">Total to cut</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {b.cutList.map((g) => {
                const key = `${g.gauge}|${g.color}|${g.shielded}`;
                return (
                  <CutRow
                    key={key}
                    group={g}
                    total={groupTotal(g)}
                    open={open === key}
                    onToggle={() => setOpen(open === key ? null : key)}
                    cut={cut}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt">Cable</h3>
      {b.cables.length === 0 ? (
        <p className="muted small">No cables used.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Cable</th>
                <th>Pieces</th>
                <th className="right">Total to cut</th>
              </tr>
            </thead>
            <tbody>
              {b.cables.map((c) => (
                <tr key={c.cableId}>
                  <td>
                    <strong>{c.name}</strong>
                    <div className="small muted">
                      {[`${c.coreCount} cores`, c.gauge, c.shielded && 'shielded'].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="small">
                    {c.pieces.map((p, i) => (
                      <div key={i}>
                        {p.connection}: {p.lengthMm != null ? fmtM(cut(p.lengthMm)) : <em className="error-text">no length</em>}
                        <span className="muted"> · {p.coresUsed} of {c.coreCount} cores</span>
                      </div>
                    ))}
                  </td>
                  <td className="right nowrap">
                    {fmtM(cableTotal(c))}
                    {c.missingLength > 0 && <div className="small error-text">+ {c.missingLength} without length</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt">Connectors, crimps and splices</h3>
      {b.parts.length === 0 ? (
        <p className="muted small">No connector types set on the wired connectors.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Part</th>
                <th className="right">Qty</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {b.parts.map((p) => (
                <tr key={`${p.kind}|${p.name}`}>
                  <td>
                    <span className={`badge part-${p.kind}`}>{p.kind}</span> <strong>{p.name}</strong>
                  </td>
                  <td className="right">{p.count}</td>
                  <td className="small muted">{p.where.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        Housings: one per wired connector; inline connectors count as a pair (plug and receptacle). Crimps: one per wire
        end, from the crimp set on the connector type.
      </p>
    </div>
  );
}

function CutRow({
  group: g,
  total,
  open,
  onToggle,
  cut,
}: {
  group: BuildList['cutList'][number];
  total: number;
  open: boolean;
  onToggle: () => void;
  cut: (mm: number) => number;
}) {
  return (
    <>
      <tr>
        <td>{g.gauge || <em className="muted">no gauge</em>}</td>
        <td>
          <span className="swatches">
            <Swatch color={g.color} /> {colorLabel(g.color) || <em className="muted">no color</em>}
          </span>
        </td>
        <td>{g.shielded ? 'Yes' : ''}</td>
        <td className="right">{g.count}</td>
        <td className="right nowrap">
          {fmtM(total)}
          {g.missingLength > 0 && <div className="small error-text">+ {g.missingLength} without length</div>}
        </td>
        <td className="right no-print">
          <button className="btn btn-sm" onClick={onToggle}>
            {open ? 'Hide' : 'Wires'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="sub-row">
          <td colSpan={6}>
            <table className="table small">
              <tbody>
                {g.wires.map((w) => (
                  <tr key={w.ref}>
                    <td className="nowrap">
                      <strong>{w.ref}</strong>
                    </td>
                    <td>{w.connection}</td>
                    <td>
                      {w.from} → {w.to}
                    </td>
                    <td className="right nowrap">
                      {w.lengthMm != null ? fmtM(cut(w.lengthMm)) : <em className="error-text">no length</em>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

type LabelKind = 'wires' | 'harness';

function LabelsView({ projectId, projectName }: { projectId: string; projectName: string }) {
  const q = useWireChecks(projectId, '');
  const [kind, setKind] = useState<LabelKind>('wires');
  const [conn, setConn] = useState<string>('');
  const [bothEnds, setBothEnds] = useState(true);

  if (!q.data) return <Loading error={q.error} />;
  const { wires, connections } = q.data;
  const ws = conn ? wires.filter((w) => w.connectionId === conn) : wires;
  const shownConns = connections.filter((c) => (conn ? c.id === conn : wires.some((w) => w.connectionId === c.id)));

  /** Text printed on a wire-end label: the wire number, this end, and the far end. */
  const endLabel = (w: ProjectWire, end: 'from' | 'to') => {
    const here = w[end];
    const far = w[end === 'from' ? 'to' : 'from'];
    return { ref: w.ref, here: here.short, far: far.short, signal: here.pinName || far.pinName };
  };
  const wireLabels = ws.flatMap((w) => (bothEnds ? [endLabel(w, 'from'), endLabel(w, 'to')] : [endLabel(w, 'from')]));

  function exportCsv() {
    const rows: string[][] =
      kind === 'wires'
        ? [['Wire', 'This end', 'Other end', 'Signal', 'Text'], ...wireLabels.map((l) => [l.ref, l.here, l.far, l.signal, `${l.ref} ${l.here} → ${l.far}`])]
        : [
            ['Connection', 'Wires', 'Ends', 'Link'],
            ...shownConns.map((c) => {
              const cw = wires.filter((w) => w.connectionId === c.id);
              return [c.name, String(cw.length), connectionEnds(cw).join(' / '), appUrl(`/projects/${projectId}/connections/${c.id}`)];
            }),
          ];
    downloadText(`${slug(projectName)}-${kind === 'wires' ? 'wire' : 'harness'}-labels.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  }

  return (
    <div>
      <div className="section-head no-print">
        <div className="btn-row">
          <div className="seg">
            <button className={kind === 'wires' ? 'active' : ''} onClick={() => setKind('wires')}>
              Wire-end labels
            </button>
            <button className={kind === 'harness' ? 'active' : ''} onClick={() => setKind('harness')}>
              Harness tags (QR)
            </button>
          </div>
          <select value={conn} onChange={(e) => setConn(e.target.value)} aria-label="Connection">
            <option value="">All connections</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {kind === 'wires' && (
            <label className="small inline-check">
              <input type="checkbox" checked={bothEnds} onChange={(e) => setBothEnds(e.target.checked)} /> Both ends
            </label>
          )}
        </div>
        <div className="btn-row">
          <button className="btn" onClick={exportCsv} title="For label printer software, e.g. as a database file">
            Download CSV
          </button>
          <button className="btn btn-primary" onClick={() => window.print()}>
            Print labels
          </button>
        </div>
      </div>
      <p className="small muted no-print">
        Prints on A4 as a grid to cut out or to use with sticker sheets. For a label printer, download the CSV and use it as
        the data source in its software. Harness tags have a QR code that opens the connection on a phone.
      </p>
      {kind === 'wires' ? (
        <div className="label-sheet label-sheet-wires">
          {wireLabels.map((l, i) => (
            <div key={i} className="wire-label">
              <strong>{l.ref}</strong>
              <span>{l.here}</span>
              <span className="wire-label-far">→ {l.far}</span>
              {l.signal && <span className="wire-label-signal">{l.signal}</span>}
            </div>
          ))}
          {wireLabels.length === 0 && <p className="empty">No wires.</p>}
        </div>
      ) : (
        <div className="label-sheet label-sheet-tags">
          {shownConns.map((c) => {
            const cw = wires.filter((w) => w.connectionId === c.id);
            return (
              <div key={c.id} className="harness-tag">
                <QrCode value={appUrl(`/projects/${projectId}/connections/${c.id}`)} size={84} title={`Link to ${c.name}`} />
                <div className="harness-tag-text">
                  <strong>{c.name}</strong>
                  <span className="small">{connectionEnds(cw).join(' ⟷ ')}</span>
                  <span className="small muted">
                    {cw.length} wire{cw.length === 1 ? '' : 's'} · {projectName}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Components and inline connectors a connection's wires end on, e.g. ["Octopus", "X motor"]. */
function connectionEnds(ws: ProjectWire[]) {
  const names = new Set<string>();
  for (const w of ws) for (const e of [w.from, w.to]) names.add(e.inline ? e.connector : e.placementName);
  return [...names];
}

// ---------------------------------------------------------------------------------------------
// Nets
// ---------------------------------------------------------------------------------------------

function NetsView({ projectId }: { projectId: string }) {
  const q = useChecks(projectId);
  const [filter, setFilter] = useState('');
  const deferred = useDeferredValue(filter);
  const nets = useMemo(() => {
    const all = q.data?.nets ?? [];
    const t = deferred.trim().toLowerCase();
    if (!t) return all;
    return all.filter((n) => n.names.some((x) => x.toLowerCase().includes(t)) || n.ends.some((e) => e.toLowerCase().includes(t)));
  }, [q.data, deferred]);
  if (!q.data) return <Loading error={q.error} />;
  return (
    <div>
      <p className="small muted">
        A net is every pin joined by wires, followed through inline connectors and across connections that use the same
        pin. Its name comes from the pin names on it. Set a pin's max current on the component (connector panel) to check
        wire gauges.
      </p>
      <input
        className="search-box"
        type="search"
        placeholder="Filter by signal, component, connector…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="table-wrap mt">
        <table className="table">
          <thead>
            <tr>
              <th>Net</th>
              <th>Signal</th>
              <th>Pins on this net</th>
              <th className="right">Wires</th>
              <th className="right">Max current</th>
            </tr>
          </thead>
          <tbody>
            {nets.map((n) => (
              <tr key={n.id}>
                <td className="nowrap muted">{n.id}</td>
                <td>
                  <strong>{n.names[0] ?? <em className="muted">unnamed</em>}</strong>
                  {n.names.length > 1 && <div className="small muted">also {n.names.slice(1).join(', ')}</div>}
                </td>
                <td className="small">
                  {n.ends.map((e, i) => (
                    <div key={i}>{e}</div>
                  ))}
                </td>
                <td className="right">{n.wires}</td>
                <td className="right">{n.maxCurrent != null ? `${n.maxCurrent} A` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {nets.length === 0 && <p className="empty">No nets{filter ? ' match' : ''}.</p>}
      </div>
    </div>
  );
}
