import { forwardRef, useMemo, useRef, useState } from 'react';
import { downloadText, slug, toCsv, type ConnectorDetails, type ProjectWire } from '../../../api';
import { colorLabel, colorParts } from '../../../colors';
import { useFolders } from '../../../components/folders';
import { Loading } from '../../../components/ui';
import { useWireChecks } from '../../../checkQueue';

type Scope = { kind: 'connection'; id: string } | { kind: 'folder'; id: string } | { kind: 'all' };

/**
 * Harness drawings: one connection, or every connection of a folder (e.g. "Toolhead") or of the
 * project combined in one drawing, with connectors and pins, colored wires with their number and
 * length, and a wire table. Printable and downloadable as SVG (e.g. for a harness supplier).
 */
export function DrawingsView({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { data, error } = useWireChecks(projectId, '');
  const folders = useFolders(projectId, 'connections').data ?? [];
  const [scopeText, setScopeText] = useState('');
  const [perConnection, setPerConnection] = useState(false);
  const svgRefs = useRef<(SVGSVGElement | null)[]>([]);

  const scope: Scope | null = useMemo(() => {
    if (!data) return null;
    if (!scopeText) return data.connections[0] ? { kind: 'connection', id: data.connections[0].id } : null;
    const [kind, id] = scopeText.split(':');
    return kind === 'all' ? { kind: 'all' } : ({ kind, id } as Scope);
  }, [scopeText, data]);

  if (!data) return <Loading error={error} />;
  if (!scope) return <p className="empty">No connections yet.</p>;

  const connIds =
    scope.kind === 'connection'
      ? [scope.id]
      : data.connections.filter((c) => scope.kind === 'all' || c.folderId === (scope.id === 'none' ? null : scope.id)).map((c) => c.id);
  const scopeName =
    scope.kind === 'connection'
      ? (data.connections.find((c) => c.id === scope.id)?.name ?? '')
      : scope.kind === 'folder'
        ? scope.id === 'none'
          ? 'Connections not in a folder'
          : `Folder ${folders.find((f) => f.id === scope.id)?.name ?? ''}`
        : 'All connections';
  const sheets: { title: string; wires: ProjectWire[] }[] =
    scope.kind !== 'connection' && perConnection
      ? connIds
          .map((id) => ({ title: data.connections.find((c) => c.id === id)!.name, wires: data.wires.filter((w) => w.connectionId === id) }))
          .filter((s) => s.wires.length)
      : [{ title: scopeName, wires: data.wires.filter((w) => connIds.includes(w.connectionId)) }];

  function download() {
    const parts = svgRefs.current.filter(Boolean).map((el) => new XMLSerializer().serializeToString(el!));
    if (parts.length === 1) downloadText(`${slug(projectName)}-${slug(scopeName)}.svg`, parts[0], 'image/svg+xml');
    else parts.forEach((p, i) => downloadText(`${slug(projectName)}-${slug(sheets[i].title)}.svg`, p, 'image/svg+xml'));
  }

  /** The order list a cable maker needs: connectors with type, crimp and cavity use, then every wire. */
  function downloadCsv() {
    const rows: (string | number)[][] = [];
    for (const s of sheets) {
      const sheet = buildSheet(s.wires, data!.connectors);
      rows.push([`Harness: ${s.title}`, projectName]);
      rows.push(['Ref', 'Connector', 'Connector type', 'Positions', 'Rows', 'Crimp', 'Crimps needed', 'Cavity allocation']);
      for (const b of sheet.boxes) {
        rows.push([
          b.ref,
          b.title,
          b.details.type?.name ?? 'NOT SET',
          b.details.type?.pinCount ?? b.details.pins.length,
          b.details.type?.rowCount ?? '',
          b.details.type?.crimpName ?? '',
          b.used.size * (b.details.inline ? 2 : 1),
          b.details.pins.map((p) => `${p.n}=${b.used.has(p.n) ? p.name || 'used' : 'NC'}`).join('; '),
        ]);
      }
      rows.push([]);
      rows.push(['Wire', 'From', 'From pin name', 'To', 'To pin name', 'Color', 'Gauge', 'Shielded', 'Length (mm)', 'Note']);
      for (const w of s.wires) {
        const f = sheet.byKey.get(w.from.connectorKey)!;
        const t = sheet.byKey.get(w.to.connectorKey)!;
        rows.push([
          w.ref,
          `${f.ref}:${w.from.pin}`,
          w.from.pinName,
          `${t.ref}:${w.to.pin}`,
          w.to.pinName,
          colorLabel(w.color),
          w.gauge,
          w.shielded ? 'yes' : '',
          w.lengthMm ?? '',
          w.note,
        ]);
      }
      rows.push([]);
    }
    downloadText(`${slug(projectName)}-${slug(scopeName)}-harness.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  }

  const missingTypes = sheets.reduce((n, s) => n + buildSheet(s.wires, data.connectors).boxes.filter((b) => !b.details.type).length, 0);
  return (
    <div>
      <div className="section-head no-print">
        <div className="btn-row">
          <select value={scopeText || `connection:${scope.kind === 'connection' ? scope.id : ''}`} onChange={(e) => setScopeText(e.target.value)} aria-label="What to draw">
            <optgroup label="Connection">
              {data.connections.map((c) => (
                <option key={c.id} value={`connection:${c.id}`}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Several connections">
              <option value="all">All connections</option>
              {folders.map((f) => (
                <option key={f.id} value={`folder:${f.id}`}>
                  Folder: {f.name}
                </option>
              ))}
              {folders.length > 0 && <option value="folder:none">Not in a folder</option>}
            </optgroup>
          </select>
          {scope.kind !== 'connection' && (
            <label className="small inline-check">
              <input type="checkbox" checked={perConnection} onChange={(e) => setPerConnection(e.target.checked)} /> One page per connection
            </label>
          )}
        </div>
        <div className="btn-row">
          <button className="btn" onClick={downloadCsv} title="Connectors with type, crimp and cavity allocation, and every wire, for a cable maker">
            Download order list (CSV)
          </button>
          <button className="btn" onClick={download}>
            Download SVG
          </button>
          <button className="btn btn-primary" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>
      <p className="small muted no-print">
        Each connector gets a reference (P1, P2…) with its connector type, number of positions and crimp, and every cavity is
        listed: unused ones as NC. Wires are given as P1:3 → P2:1. Connectors on the left and right, inline connectors and
        splices in the middle; in a combined drawing, a connector used by several connections shows once.
      </p>
      {missingTypes > 0 && (
        <p className="export-notice no-print">
          <span aria-hidden>⚠</span>
          <span>
            {missingTypes} connector{missingTypes > 1 ? 's have' : ' has'} no connector type, so a cable maker cannot tell what to
            fit. Set the type on the component's connector (or on the inline connector in the connection editor).
          </span>
        </p>
      )}
      {sheets.map((s, i) => (
        <div key={`${s.title}${i}`} className="drawing-sheet">
          <HarnessDrawing
            ref={(el) => (svgRefs.current[i] = el)}
            wires={s.wires}
            connectors={data.connectors}
            title={s.title}
            projectName={projectName}
          />
        </div>
      ))}
    </div>
  );
}

interface Box {
  key: string;
  /** Designator on the drawing, e.g. "P3". */
  ref: string;
  title: string;
  sub: string;
  details: ConnectorDetails;
  /** Cavities with a wire. */
  used: Set<number>;
  /** Rows drawn: every cavity, or only the used ones for very large connectors. */
  rows: { n: number; name: string }[];
  col: 0 | 1 | 2;
  x: number;
  y: number;
  h: number;
}

const BOX_W = 280;
const ROW = 18;
const HEAD = 48;
const GAP = 22;
/** Connectors with more cavities than this only draw the used ones (the full allocation is in the table). */
const MAX_ROWS = 40;

/** Connectors of a set of wires, laid out in three columns, with designators P1, P2… top to bottom. */
function buildSheet(wires: ProjectWire[], connectors: Record<string, ConnectorDetails>) {
  const boxes = new Map<string, Box>();
  for (const w of wires) {
    for (const e of [w.from, w.to]) {
      const k = e.connectorKey;
      let b = boxes.get(k);
      if (!b) {
        const details = connectors[k] ?? { key: k, inline: e.inline, type: null, pins: [] };
        b = {
          key: k,
          ref: '',
          title: e.inline ? `${e.connector} (inline)` : `${e.placementName} › ${e.connector}`,
          sub: e.inline ? 'inline connector / splice' : e.connectorPurpose,
          details,
          used: new Set(),
          rows: [],
          col: e.inline ? 1 : 0,
          x: 0,
          y: 0,
          h: 0,
        };
        boxes.set(k, b);
      }
      b.used.add(e.pin);
    }
  }
  // Board connectors go left or right so that most wires cross the drawing: start with the busiest,
  // put what it connects to on the other side (through inline connectors), and so on.
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    links.set(a, (links.get(a) ?? new Set()).add(b));
    links.set(b, (links.get(b) ?? new Set()).add(a));
  };
  for (const w of wires) link(w.from.connectorKey, w.to.connectorKey);
  const side = new Map<string, 0 | 2>();
  const order = [...boxes.values()].filter((b) => b.col !== 1).sort((a, b) => (links.get(b.key)?.size ?? 0) - (links.get(a.key)?.size ?? 0));
  for (const start of order) {
    if (side.has(start.key)) continue;
    const left = [...side.values()].filter((s) => s === 0).length;
    side.set(start.key, left <= side.size - left ? 0 : 2);
    const queue = [start.key];
    const seen = new Set(queue);
    while (queue.length) {
      const k = queue.shift()!;
      const s = side.get(k);
      for (const n of links.get(k) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        const b = boxes.get(n)!;
        if (b.col === 1) {
          for (const m of links.get(n) ?? []) if (!side.has(m) && boxes.get(m)!.col !== 1 && s !== undefined) side.set(m, s === 0 ? 2 : 0);
          queue.push(n);
        } else if (!side.has(n) && s !== undefined) {
          side.set(n, s === 0 ? 2 : 0);
          queue.push(n);
        }
      }
    }
  }
  for (const b of boxes.values()) if (b.col !== 1) b.col = side.get(b.key) ?? 0;
  const hasMiddle = [...boxes.values()].some((b) => b.col === 1);
  const colX = [20, 20 + BOX_W + 170, 20 + (hasMiddle ? 2 : 1) * (BOX_W + 170)];
  const colY = [80, 80, 80];
  const list = [...boxes.values()].sort((a, b) => a.col - b.col);
  list.forEach((b, i) => {
    b.ref = `P${i + 1}`;
    const all = b.details.pins.length ? b.details.pins : [...b.used].map((n) => ({ n, name: '' }));
    // Pin names drawn on the component, else the name the wire end carries.
    const named = all.map((p) => ({ n: p.n, name: p.name || wires.flatMap((w) => [w.from, w.to]).find((e) => e.connectorKey === b.key && e.pin === p.n)?.pinName || '' }));
    for (const n of b.used) if (!named.some((p) => p.n === n)) named.push({ n, name: '' });
    named.sort((p, q) => p.n - q.n);
    b.rows = named.length > MAX_ROWS ? named.filter((p) => b.used.has(p.n)) : named;
    b.h = HEAD + b.rows.length * ROW + 6;
    b.x = colX[b.col];
    b.y = colY[b.col];
    colY[b.col] += b.h + GAP;
  });
  return { boxes: list, byKey: boxes, width: colX[2] + BOX_W + 20, height: Math.max(...colY) + 10 };
}

const typeText = (b: Box) => {
  const t = b.details.type;
  if (!t) return 'CONNECTOR TYPE NOT SET';
  return [t.name, `${t.pinCount} pos.${t.rowCount > 1 ? ` (${t.rowCount} rows)` : ''}`, t.crimpName && `crimp ${t.crimpName}`].filter(Boolean).join(' · ');
};

const HarnessDrawing = forwardRef<
  SVGSVGElement,
  { wires: ProjectWire[]; connectors: Record<string, ConnectorDetails>; title: string; projectName: string }
>(function HarnessDrawing({ wires, connectors, title, projectName }, ref) {
  const { boxes, byKey, width, height } = useMemo(() => buildSheet(wires, connectors), [wires, connectors]);
  if (!wires.length) return <p className="empty">No wires.</p>;

  const anchor = (e: ProjectWire['from'], towards: number) => {
    const b = byKey.get(e.connectorKey)!;
    const i = Math.max(0, b.rows.findIndex((p) => p.n === e.pin));
    const y = b.y + HEAD + i * ROW + ROW / 2;
    const rightEdge = b.col === 0 || (b.col === 1 && towards > b.x + BOX_W / 2);
    return { x: rightEdge ? b.x + BOX_W : b.x, y, dir: rightEdge ? 1 : -1 };
  };

  const tableRow = 16;
  // Connector table, then wire list.
  const connTop = height + 30;
  const wireTop = connTop + 24 + boxes.length * tableRow + 34;
  const totalH = wireTop + 24 + wires.length * tableRow + 20;
  const totalLength = wires.reduce((s, w) => s + (w.lengthMm ?? 0), 0);
  const date = new Date().toISOString().slice(0, 10);
  const missing = boxes.filter((b) => !b.details.type).length;
  // Table columns scale with the drawing width (two or three columns of connectors).
  const avail = width - 80;
  const cx = [20, 60, 60 + avail * 0.32, 60 + avail * 0.6, 60 + avail * 0.68, 60 + avail * 0.84];
  const fit = (s: string, col: number) => clip(s, Math.max(6, Math.floor(((cx[col + 1] ?? width - 10) - cx[col] - 8) / 5.6)));
  const wx = [20, 70, 0, 0, width - 330, width - 210, width - 90];
  const half = (width - 330 - 70) / 2;
  wx[2] = 70;
  wx[3] = 70 + half;

  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${totalH}`}
      width="100%"
      className="harness-svg"
      fontFamily="Segoe UI, Roboto, Helvetica, Arial, sans-serif"
      role="img"
      aria-label={`Harness drawing: ${title}`}
    >
      <rect width={width} height={totalH} fill="#fff" />
      <text x={20} y={28} fontSize={18} fontWeight={700} fill="#0f172a">
        {title}
      </text>
      <text x={20} y={48} fontSize={11} fill="#475569">
        {projectName} · {boxes.length} connectors · {wires.length} wire{wires.length > 1 ? 's' : ''}
        {totalLength ? ` · ${(totalLength / 1000).toFixed(2)} m of wire` : ''} · {date} · Wire-Node
      </text>
      {missing > 0 && (
        <text x={20} y={66} fontSize={11} fontWeight={700} fill="#b45309">
          ⚠ {missing} connector{missing > 1 ? 's have' : ' has'} no connector type set
        </text>
      )}

      {wires.map((w) => {
        const fb = byKey.get(w.from.connectorKey)!;
        const tb = byKey.get(w.to.connectorKey)!;
        const a = anchor(w.from, tb.x + BOX_W / 2);
        const b = anchor(w.to, fb.x + BOX_W / 2);
        const c = Math.max(60, Math.abs(b.x - a.x) / 2);
        const d = `M${a.x} ${a.y} C${a.x + a.dir * c} ${a.y} ${b.x + b.dir * c} ${b.y} ${b.x} ${b.y}`;
        const parts = colorParts(w.color);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        return (
          <g key={w.id}>
            <path d={d} fill="none" stroke="#0f172a" strokeWidth={4.5} opacity={0.25} />
            <path d={d} fill="none" stroke={parts?.base ?? '#94a3b8'} strokeWidth={3} strokeDasharray={parts ? undefined : '6 4'} />
            {parts?.stripe && <path d={d} fill="none" stroke={parts.stripe} strokeWidth={3} strokeDasharray="5 7" />}
            <rect x={mx - 28} y={my - 8} width={56} height={14} rx={3} fill="#fff" stroke="#cbd5e1" />
            <text x={mx} y={my + 3} fontSize={9} textAnchor="middle" fill="#0f172a">
              {w.ref}
              {w.lengthMm != null ? ` · ${w.lengthMm}` : ''}
            </text>
          </g>
        );
      })}

      {boxes.map((b) => (
        <g key={b.key}>
          <rect x={b.x} y={b.y} width={BOX_W} height={b.h} rx={6} fill="#f8fafc" stroke="#334155" />
          <rect x={b.x} y={b.y} width={BOX_W} height={HEAD - 4} rx={6} fill={b.col === 1 ? '#64748b' : '#1e293b'} />
          <rect x={b.x + 6} y={b.y + 5} width={30} height={16} rx={3} fill="#fff" />
          <text x={b.x + 21} y={b.y + 17} fontSize={11} fontWeight={800} fill="#0f172a" textAnchor="middle">
            {b.ref}
          </text>
          <text x={b.x + 42} y={b.y + 17} fontSize={11} fontWeight={700} fill="#fff">
            {clip(b.title, 36)}
          </text>
          <text x={b.x + 8} y={b.y + 36} fontSize={9.5} fill={b.details.type ? '#fde68a' : '#fca5a5'} fontWeight={600}>
            {clip(typeText(b), 50)}
          </text>
          {b.rows.map((p, i) => {
            const used = b.used.has(p.n);
            const y = b.y + HEAD + i * ROW;
            return (
              <g key={p.n}>
                <line x1={b.x} x2={b.x + BOX_W} y1={y} y2={y} stroke="#e2e8f0" />
                <text x={b.x + 10} y={y + 13} fontSize={10} fill={used ? '#0f172a' : '#94a3b8'} fontWeight={700}>
                  {p.n}
                </text>
                <text x={b.x + 34} y={y + 13} fontSize={10} fill={used ? '#334155' : '#94a3b8'}>
                  {used ? clip(p.name, 38) : `NC${p.name ? ` (${clip(p.name, 30)})` : ''}`}
                </text>
              </g>
            );
          })}
        </g>
      ))}

      <text x={20} y={connTop} fontSize={12} fontWeight={700} fill="#0f172a">
        Connectors
      </text>
      {['Ref', 'Connector', 'Connector type', 'Positions', 'Crimp', 'Cavities used (others NC)'].map((h, i) => (
        <text key={h} x={cx[i]} y={connTop + 18} fontSize={10} fontWeight={700} fill="#475569">
          {h}
        </text>
      ))}
      {boxes.map((b, i) => {
        const y = connTop + 34 + i * tableRow;
        const t = b.details.type;
        const crimps = b.used.size * (b.details.inline ? 2 : 1);
        return (
          <g key={b.key} fontSize={10} fill="#0f172a">
            <text x={cx[0]} y={y} fontWeight={700}>
              {b.ref}
            </text>
            <text x={cx[1]} y={y}>
              {fit(b.title, 1)}
            </text>
            <text x={cx[2]} y={y} fill={t ? '#0f172a' : '#b91c1c'} fontWeight={t ? 400 : 700}>
              {t ? fit(`${t.name}${b.details.inline ? ' (plug + receptacle)' : ''}`, 2) : 'NOT SET'}
            </text>
            <text x={cx[3]} y={y}>
              {t ? `${t.pinCount}${t.rowCount > 1 ? ` (${t.rowCount}×${Math.ceil(t.pinCount / t.rowCount)})` : ''}` : b.details.pins.length || ''}
            </text>
            <text x={cx[4]} y={y}>
              {t?.crimpName ? fit(`${t.crimpName} × ${crimps}`, 4) : ''}
            </text>
            <text x={cx[5]} y={y}>
              {fit([...b.used].sort((p, q) => p - q).join(', '), 5)}
            </text>
          </g>
        );
      })}

      <text x={20} y={wireTop} fontSize={12} fontWeight={700} fill="#0f172a">
        Wire list
      </text>
      {['Wire', 'From', 'To', 'Color', 'Gauge', 'Length'].map((h, i) => (
        <text key={h} x={[wx[0], wx[2], wx[3], wx[4], wx[5], wx[6]][i]} y={wireTop + 18} fontSize={10} fontWeight={700} fill="#475569">
          {h}
        </text>
      ))}
      {wires.map((w, i) => {
        const y = wireTop + 34 + i * tableRow;
        const f = byKey.get(w.from.connectorKey)!;
        const t = byKey.get(w.to.connectorKey)!;
        const end = (box: Box, e: ProjectWire['from']) => `${box.ref}:${e.pin}${e.pinName ? ` ${e.pinName}` : ''} — ${e.short.replace(/\.\d+$/, '')}`;
        return (
          <g key={w.id} fontSize={10} fill="#0f172a">
            <text x={wx[0]} y={y} fontWeight={700}>
              {w.ref}
            </text>
            <text x={wx[2]} y={y}>
              {clip(end(f, w.from), Math.floor(half / 5.4))}
            </text>
            <text x={wx[3]} y={y}>
              {clip(end(t, w.to), Math.floor(half / 5.4))}
            </text>
            <text x={wx[4]} y={y}>
              {colorLabel(w.color)}
            </text>
            <text x={wx[5]} y={y}>
              {w.gauge}
              {w.shielded ? ' (shielded)' : ''}
            </text>
            <text x={wx[6]} y={y}>
              {w.lengthMm != null ? `${w.lengthMm} mm` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
