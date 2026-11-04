/**
 * Human- and AI-readable summary of the wiring, written as Markdown.
 * It names everything (no ids), lists every connector pin of every placed component with what it is
 * wired to, and marks unused connectors, so it can answer questions like "which pin is the X endstop on"
 * or "which slot is free for a new fan" and be used as a reference for writing firmware config / G-code.
 *
 * Built from the same rows as the backup, so it always matches the backup it is packed with.
 */

type Row = Record<string, any>;

export interface WiringRows {
  projects: Row[];
  cables: Row[];
  connectorTypes: Row[];
  pcbs: Row[];
  folders: Row[];
  projectPcbs: Row[];
  pcbConnectors: Row[];
  connections: Row[];
  connectionNodes: Row[];
  wires: Row[];
}

interface Pin {
  n: number;
  name: string;
}

/** One end of a wire: a pin of a node in a connection. */
interface End {
  node: Row;
  pin: number;
}

const byName = (a: { name?: string }, b: { name?: string }) =>
  (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true });

const md = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

function fmtDate(d: unknown) {
  if (!d) return '';
  return new Date(d as string).toISOString().slice(0, 10);
}

function pinsOf(conn: Row | undefined, type: Row | undefined, fallbackCount = 0): Pin[] {
  const raw = Array.isArray(conn?.pins) ? (conn!.pins as Row[]) : [];
  if (raw.length) return raw.map((p) => ({ n: Number(p.n), name: md(p.name) })).sort((a, b) => a.n - b.n);
  const count = type?.pinCount ?? fallbackCount;
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, name: '' }));
}

const pinLabel = (p: Pin | undefined, n: number) => (p?.name ? `pin ${n} "${p.name}"` : `pin ${n}`);

/** Wiring summary of one project. Returns null if the project does not exist. */
export function buildWiringReport(rows: WiringRows, projectId: string, exportedAt = new Date().toISOString()): string | null {
  const project = rows.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const pcbById = new Map(rows.pcbs.map((r) => [r.id, r]));
  const typeById = new Map(rows.connectorTypes.map((r) => [r.id, r]));
  const cableById = new Map(rows.cables.map((r) => [r.id, r]));
  const folderById = new Map(rows.folders.map((r) => [r.id, r]));
  const pcbConnById = new Map(rows.pcbConnectors.map((r) => [r.id, r]));
  const placementById = new Map(rows.projectPcbs.map((r) => [r.id, r]));

  const connectorsOfPcb = new Map<string, Row[]>();
  for (const c of rows.pcbConnectors) {
    if (!connectorsOfPcb.has(c.pcbId)) connectorsOfPcb.set(c.pcbId, []);
    connectorsOfPcb.get(c.pcbId)!.push(c);
  }

  const placementName = (pp: Row) => md(pp.name) || md(pcbById.get(pp.pcbId)?.name) || 'Unnamed component';
  const connectorName = (c: Row) => md(c.label) || md(c.name) || 'Unnamed connector';
  const typeText = (t: Row | undefined) =>
    t ? `${md(t.name)} (${t.pinCount} pins${t.crimpName ? `, crimp ${md(t.crimpName)}` : ''})` : 'type not set';

  /** Full name of a node's pin, e.g. `Octopus › J12 "X motor" pin 1 "A1"`. */
  function endText(e: End): string {
    const n = e.node;
    const pc = n.pcbConnectorId ? pcbConnById.get(n.pcbConnectorId) : undefined;
    const pp = n.projectPcbId ? placementById.get(n.projectPcbId) : undefined;
    if (pc && pp) {
      const pin = pinsOf(pc, typeById.get(pc.connectorTypeId)).find((p) => p.n === e.pin);
      const purpose = pc.name && md(pc.name) !== connectorName(pc) ? ` "${md(pc.name)}"` : '';
      return `${placementName(pp)} › ${connectorName(pc)}${purpose} ${pinLabel(pin, e.pin)}`;
    }
    const label = md(n.label) || 'unnamed';
    return `inline connector "${label}" pin ${e.pin}`;
  }

  const isBoardEnd = (e: End) => !!(e.node.pcbConnectorId && e.node.projectPcbId);

  function wireDetails(w: Row): string {
    const bits: string[] = [];
    if (w.color) bits.push(md(w.color));
    const cable = w.cableId ? cableById.get(w.cableId) : undefined;
    if (cable) bits.push(`cable "${md(cable.name)}"${w.coreIndex != null ? ` core ${w.coreIndex + 1}` : ''}`);
    if (w.lengthMm != null) bits.push(`${w.lengthMm} mm`);
    if (w.note) bits.push(`note: ${md(w.note)}`);
    return bits.join(', ');
  }

  const out: string[] = [];
  out.push(`# Wiring: ${md(project.name)}`, '');
  const meta: string[] = [];
  if (project.machine) meta.push(`Machine: ${md(project.machine)}`);
  if (project.lockedAt) meta.push(`Locked (frozen revision) since ${fmtDate(project.lockedAt)}`);
  meta.push(`Exported from Wire-Node ${exportedAt}`);
  out.push(meta.join(' · '), '');
  if (project.description) out.push(md(project.description), '');
  out.push(
    'How to read this file:',
    '',
    '- This file describes one machine. **Components** are boards and parts placed in it (a library component can be placed several times under different names).',
    '- Each component lists its **connectors** (label, what it is for, connector type) and every **pin**, with where that pin is wired to.',
    '  Wires are followed through inline connectors and splices, so "→" names the pins at the far end.',
    '- Connectors marked **FREE** have nothing wired to them in this project; pins marked "not connected" are unused.',
    '- **Connections** lists each cable/harness wire by wire, with color, cable core, length and notes.',
    '- Pin names come from the component drawings in Wire-Node. Use them to map firmware pins (e.g. Klipper/Marlin config) to motors, endstops, fans and heaters.',
    '',
  );

  const connections = rows.connections.filter((c) => c.projectId === project.id).sort(byName);
  const connIds = new Set(connections.map((c) => c.id));
  const nodes = rows.connectionNodes.filter((n) => connIds.has(n.connectionId));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const wires = rows.wires.filter((w) => connIds.has(w.connectionId) && nodeById.has(w.fromNodeId) && nodeById.has(w.toNodeId));

  // Nets: pins joined by wires. Keyed by node+pin, so wires meeting at the same pin of an
  // inline connector or splice end up in the same net.
  const key = (nodeId: string, pin: number) => `${nodeId}#${pin}`;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const w of wires) {
    const a = find(key(w.fromNodeId, w.fromPin));
    const b = find(key(w.toNodeId, w.toPin));
    if (a !== b) parent.set(a, b);
  }
  const netEnds = new Map<string, End[]>();
  const netWires = new Map<string, Row[]>();
  const addEnd = (nodeId: string, pin: number) => {
    const root = find(key(nodeId, pin));
    const list = netEnds.get(root) ?? [];
    if (!list.some((e) => e.node.id === nodeId && e.pin === pin)) list.push({ node: nodeById.get(nodeId)!, pin });
    netEnds.set(root, list);
  };
  for (const w of wires) {
    addEnd(w.fromNodeId, w.fromPin);
    addEnd(w.toNodeId, w.toPin);
    const root = find(key(w.fromNodeId, w.fromPin));
    netWires.set(root, [...(netWires.get(root) ?? []), w]);
  }
  const connById = new Map(connections.map((c) => [c.id, c]));
  const nodesOnConnector = new Map<string, Row[]>();
  for (const n of nodes) {
    const k = `${n.projectPcbId}|${n.pcbConnectorId}`;
    nodesOnConnector.set(k, [...(nodesOnConnector.get(k) ?? []), n]);
  }

  /** What a board pin is wired to, one line per connection it appears in. */
  function targetsOf(placementId: string, pcbConnectorId: string, pin: number): string[] {
    const res: string[] = [];
    for (const n of nodesOnConnector.get(`${placementId}|${pcbConnectorId}`) ?? []) {
      const k = key(n.id, pin);
      if (!parent.has(k)) continue;
      const root = find(k);
      const ends = (netEnds.get(root) ?? []).filter((e) => !(e.node.id === n.id && e.pin === pin));
      const boardEnds = ends.filter(isBoardEnd);
      const inlineEnds = ends.filter((e) => !isBoardEnd(e));
      const far = boardEnds.length ? boardEnds : inlineEnds;
      const via = boardEnds.length && inlineEnds.length ? ` (via ${inlineEnds.map(endText).join(', ')})` : '';
      const w = (netWires.get(root) ?? [])[0];
      const details = w && (netWires.get(root) ?? []).length === 1 ? wireDetails(w) : '';
      const conn = connById.get(n.connectionId);
      res.push(
        `${far.map(endText).join(' + ') || 'nothing'}${via} — connection "${md(conn?.name)}"${details ? `, ${details}` : ''}`,
      );
    }
    return res;
  }

  // ---- Components ----
  const placements = rows.projectPcbs
    .filter((pp) => pp.projectId === project.id)
    .sort((a, b) => placementName(a).localeCompare(placementName(b), undefined, { numeric: true }));
  out.push('## Components', '');
  if (!placements.length) out.push('_No components placed._', '');

  const freeSummary: string[] = [];
  for (const pp of placements) {
    const pcb = pcbById.get(pp.pcbId);
    const name = placementName(pp);
    const folder = pp.folderId ? folderById.get(pp.folderId) : undefined;
    const sub = [pcb && md(pcb.name) !== name ? `library component "${md(pcb.name)}"` : '', folder ? `folder "${md(folder.name)}"` : '']
      .filter(Boolean)
      .join(', ');
    out.push(`### ${name}${sub ? ` (${sub})` : ''}`, '');
    if (pcb?.description) out.push(md(pcb.description), '');

    const conns = [...(connectorsOfPcb.get(pp.pcbId) ?? [])].sort((a, b) =>
      connectorName(a).localeCompare(connectorName(b), undefined, { numeric: true }),
    );
    if (!conns.length) out.push('_No connectors drawn on this component._', '');

    for (const c of conns) {
      const type = c.connectorTypeId ? typeById.get(c.connectorTypeId) : undefined;
      const pins = pinsOf(c, type);
      const lines = pins.map((p) => ({ p, targets: targetsOf(pp.id, c.id, p.n) }));
      const used = lines.some((l) => l.targets.length);
      const purpose = c.name && md(c.name) !== connectorName(c) ? ` — ${md(c.name)}` : '';
      out.push(`- **${connectorName(c)}**${purpose} · ${typeText(type)}${used ? '' : ' · **FREE**'}`);
      if (!used) freeSummary.push(`${name} › ${connectorName(c)}${purpose} · ${typeText(type)}`);
      for (const { p, targets } of lines) {
        const label = pinLabel(p, p.n);
        if (!targets.length) out.push(`  - ${label}: not connected`);
        else for (const t of targets) out.push(`  - ${label} → ${t}`);
      }
    }
    out.push('');
  }

  out.push('## Free connectors', '');
  if (freeSummary.length) out.push(...freeSummary.map((s) => `- ${s}`), '');
  else out.push('_None — every connector has at least one wire._', '');

  // ---- Connections ----
  out.push('## Connections', '');
  if (!connections.length) out.push('_No connections._', '');
  for (const conn of connections) {
    const folder = conn.folderId ? folderById.get(conn.folderId) : undefined;
    const meta = [md(conn.kind), conn.lengthMm != null ? `${conn.lengthMm} mm` : '', folder ? `folder "${md(folder.name)}"` : '']
      .filter(Boolean)
      .join(', ');
    out.push(`### ${md(conn.name)}${meta ? ` (${meta})` : ''}`, '');
    if (conn.description) out.push(md(conn.description), '');
    const cw = wires.filter((w) => w.connectionId === conn.id);
    if (!cw.length) out.push('_No wires._');
    for (const w of cw) {
      const from = endText({ node: nodeById.get(w.fromNodeId)!, pin: w.fromPin });
      const to = endText({ node: nodeById.get(w.toNodeId)!, pin: w.toPin });
      const details = wireDetails(w);
      out.push(`- ${from} → ${to}${details ? ` [${details}]` : ''}`);
    }
    out.push('');
  }

  return out.join('\n');
}
