/**
 * Resolved view of one project's wiring, built from the same rows as the backup (see readAll):
 * every wire with both ends named and its effective color, gauge, shielding and length, plus the
 * nets (sets of pins joined by wires, followed through inline connectors and splices).
 *
 * Used by the build list (BOM / cut list), the design checks, labels and project comparison.
 */

import type { WiringRows } from './wiringReport.js';

type Row = Record<string, any>;

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

export interface EndInfo {
  nodeId: string;
  pin: number;
  /** On a component: the placement's name in the project. */
  placementId: string | null;
  placementName: string;
  /** Connector designator (e.g. "J1") or the inline connector's label. */
  connector: string;
  /** What the connector is for, e.g. "Motor 0". */
  connectorPurpose: string;
  /** Pin name from the component drawing, which doubles as its signal name (e.g. "GND", "24V"). */
  pinName: string;
  /** Pin role from the drawing ("power", "ground", "output", "can_h"…), or "" when not set. */
  pinRole: string;
  inline: boolean;
  connectorTypeId: string | null;
  /** The same for every end on this physical connector: "<placement>|<connector>", or "node:<id>" inline. */
  connectorKey: string;
  /** Readable, e.g. `Octopus › M0 pin 1 "2B"`. */
  text: string;
  /** Compact, for labels: `Octopus:M0.1`. */
  short: string;
}

export interface ResolvedWire {
  id: string;
  /** Number of the wire in the project, e.g. "W12" (stable order: connection name, then wire order). */
  ref: string;
  connectionId: string;
  connectionName: string;
  from: EndInfo;
  to: EndInfo;
  color: string;
  gauge: string;
  shielded: boolean;
  /** Effective length: the wire's own, else the connection's. Null when neither is set. */
  lengthMm: number | null;
  cableId: string | null;
  cableName: string;
  coreIndex: number | null;
  note: string;
  /**
   * What the wire physically is: its ends, color, gauge and cable core. A build-checklist tick is
   * only valid while this stays the same. Not the cable id: locking a project points wires at
   * frozen copies of their cables, which must not undo the ticks.
   */
  fingerprint: string;
}

export interface ConnectorDetails {
  key: string;
  inline: boolean;
  /** Connector type from the library (housing, pin count, rows, crimp); null when not set. */
  type: { name: string; pinCount: number; rowCount: number; crimpName: string } | null;
  /** Every cavity of the connector, used or not. */
  pins: { n: number; name: string }[];
}

export interface Net {
  id: string;
  /** Signal names: the pin names on the net, most common first. */
  names: string[];
  ends: EndInfo[];
  wireIds: string[];
}

export interface ProjectModel {
  project: Row;
  connections: Row[];
  nodes: Row[];
  placements: Row[];
  wires: ResolvedWire[];
  nets: Net[];
  /** Net of a node pin (only pins with at least one wire). */
  netOf: (nodeId: string, pin: number) => Net | undefined;
  typeById: Map<string, Row>;
  cableById: Map<string, Row>;
  pcbById: Map<string, Row>;
  pcbConnById: Map<string, Row>;
  placementName: (pp: Row) => string;
  connectorName: (c: Row) => string;
  /** Pins of a connector on a component, numbered from its type when none are drawn. */
  pinsOf: (pc: Row) => { n: number; name: string; current: number | null; role: string }[];
  /** Connector type of a node (its own, else that of the component connector it sits on). */
  nodeType: (n: Row) => Row | undefined;
  /** Everything a cable maker needs about the connector a wire end is on: type, crimp and every cavity. */
  connectorDetails: (e: EndInfo) => ConnectorDetails;
}

export function buildProjectModel(rows: WiringRows, projectId: string): ProjectModel | null {
  const project = rows.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const pcbById = new Map(rows.pcbs.map((r) => [r.id, r]));
  const typeById = new Map(rows.connectorTypes.map((r) => [r.id, r]));
  const cableById = new Map(rows.cables.map((r) => [r.id, r]));
  const pcbConnById = new Map(rows.pcbConnectors.map((r) => [r.id, r]));
  const placements = rows.projectPcbs.filter((pp) => pp.projectId === projectId);
  const placementById = new Map(placements.map((r) => [r.id, r]));

  const placementName = (pp: Row) => clean(pp.name) || clean(pcbById.get(pp.pcbId)?.name) || 'Unnamed component';
  const connectorName = (c: Row) => clean(c.label) || clean(c.name) || 'Unnamed connector';
  const pinsOf = (pc: Row) => {
    const raw = Array.isArray(pc?.pins) ? (pc.pins as Row[]) : [];
    if (raw.length) {
      return raw
        .map((p) => ({
          n: Number(p.n),
          name: clean(p.name),
          role: clean(p.role),
          current: typeof p.current === 'number' && Number.isFinite(p.current) ? p.current : null,
        }))
        .sort((a, b) => a.n - b.n);
    }
    const count = typeById.get(pc?.connectorTypeId)?.pinCount ?? 0;
    return Array.from({ length: count }, (_, i) => ({ n: i + 1, name: '', current: null as number | null, role: '' }));
  };
  const nodeType = (n: Row) => {
    if (n.connectorTypeId) return typeById.get(n.connectorTypeId);
    const pc = n.pcbConnectorId ? pcbConnById.get(n.pcbConnectorId) : undefined;
    return pc?.connectorTypeId ? typeById.get(pc.connectorTypeId) : undefined;
  };

  const byName = (a: Row, b: Row) => clean(a.name).localeCompare(clean(b.name), undefined, { numeric: true });
  const connections = rows.connections.filter((c) => c.projectId === projectId).sort(byName);
  const connById = new Map(connections.map((c) => [c.id, c]));
  const nodes = rows.connectionNodes.filter((n) => connById.has(n.connectionId));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  function endInfo(nodeId: string, pin: number): EndInfo {
    const n = nodeById.get(nodeId)!;
    const pc = n.pcbConnectorId ? pcbConnById.get(n.pcbConnectorId) : undefined;
    const pp = n.projectPcbId ? placementById.get(n.projectPcbId) : undefined;
    const type = nodeType(n);
    if (pc && pp) {
      const p = pinsOf(pc).find((x) => x.n === pin);
      const pname = placementName(pp);
      const cname = connectorName(pc);
      const purpose = clean(pc.name) !== cname ? clean(pc.name) : '';
      return {
        nodeId,
        pin,
        placementId: pp.id,
        placementName: pname,
        connector: cname,
        connectorPurpose: purpose,
        pinName: p?.name ?? '',
        pinRole: p?.role ?? '',
        inline: false,
        connectorTypeId: type?.id ?? null,
        connectorKey: `${pp.id}|${pc.id}`,
        text: `${pname} › ${cname}${purpose ? ` "${purpose}"` : ''} pin ${pin}${p?.name ? ` "${p.name}"` : ''}`,
        short: `${pname}:${cname}.${pin}`,
      };
    }
    const label = clean(n.label) || 'inline';
    return {
      nodeId,
      pin,
      placementId: null,
      placementName: '',
      connector: label,
      connectorPurpose: '',
      pinName: '',
      pinRole: '',
      inline: true,
      connectorTypeId: type?.id ?? null,
      connectorKey: `node:${nodeId}`,
      text: `inline connector "${label}" pin ${pin}`,
      short: `${label}.${pin}`,
    };
  }

  const rawWires = rows.wires.filter(
    (w) => connById.has(w.connectionId) && nodeById.has(w.fromNodeId) && nodeById.has(w.toNodeId),
  );
  // Order: connection name, then the order the wires were saved in (ids are random, so keep row order).
  const order = new Map(connections.map((c, i) => [c.id, i]));
  const sortedWires = rawWires
    .map((w, i) => ({ w, i }))
    .sort((a, b) => order.get(a.w.connectionId)! - order.get(b.w.connectionId)! || a.i - b.i)
    .map(({ w }) => w);

  const wires: ResolvedWire[] = sortedWires.map((w, i) => {
    const conn = connById.get(w.connectionId)!;
    const cable = w.cableId ? cableById.get(w.cableId) : undefined;
    const coreColor = cable && w.coreIndex != null ? clean(cable.cores?.[w.coreIndex]?.color) : '';
    return {
      id: w.id,
      ref: `W${i + 1}`,
      connectionId: conn.id,
      connectionName: clean(conn.name),
      from: endInfo(w.fromNodeId, w.fromPin),
      to: endInfo(w.toNodeId, w.toPin),
      color: clean(w.color) || coreColor,
      gauge: clean(w.gauge) || clean(cable?.gauge),
      shielded: w.shielded ?? !!cable?.shielded,
      lengthMm: w.lengthMm ?? conn.lengthMm ?? null,
      cableId: cable?.id ?? null,
      cableName: clean(cable?.name),
      coreIndex: w.coreIndex ?? null,
      note: clean(w.note),
      fingerprint: [
        w.fromNodeId, w.fromPin, w.toNodeId, w.toPin, clean(w.color), clean(w.gauge), w.coreIndex ?? '',
      ].join('|'),
    };
  });

  // ---- Nets (union-find over node pins) ----
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
  for (const w of rawWires) {
    const a = find(key(w.fromNodeId, w.fromPin));
    const b = find(key(w.toNodeId, w.toPin));
    if (a !== b) parent.set(a, b);
  }
  // The same pin of the same placed connector can appear in several connections (each connection has
  // its own node for it). Electrically that is one point, so join those too.
  const boardPin = new Map<string, string>();
  for (const k of [...parent.keys()]) {
    const [nodeId, pinStr] = k.split('#');
    const n = nodeById.get(nodeId)!;
    if (!n.pcbConnectorId || !n.projectPcbId) continue;
    const bk = `${n.projectPcbId}|${n.pcbConnectorId}|${pinStr}`;
    const other = boardPin.get(bk);
    if (other) {
      const a = find(k);
      const b = find(other);
      if (a !== b) parent.set(a, b);
    } else boardPin.set(bk, k);
  }

  const netByRoot = new Map<string, Net>();
  const getNet = (root: string) => {
    let net = netByRoot.get(root);
    if (!net) {
      net = { id: root, names: [], ends: [], wireIds: [] };
      netByRoot.set(root, net);
    }
    return net;
  };
  const seenEnd = new Set<string>();
  for (const w of wires) {
    const net = getNet(find(key(w.from.nodeId, w.from.pin)));
    net.wireIds.push(w.id);
    for (const e of [w.from, w.to]) {
      const k = key(e.nodeId, e.pin);
      if (seenEnd.has(k)) continue;
      seenEnd.add(k);
      // A board pin used in two connections shows once.
      if (!e.inline && net.ends.some((x) => !x.inline && x.placementId === e.placementId && x.short === e.short)) continue;
      net.ends.push(e);
    }
  }
  for (const net of netByRoot.values()) {
    const counts = new Map<string, number>();
    for (const e of net.ends) {
      if (e.pinName) counts.set(e.pinName, (counts.get(e.pinName) ?? 0) + 1);
    }
    net.names = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  }
  const nets = [...netByRoot.values()].sort(
    (a, b) =>
      (a.names[0] ?? '￿').localeCompare(b.names[0] ?? '￿', undefined, { numeric: true }) ||
      a.ends[0].text.localeCompare(b.ends[0].text, undefined, { numeric: true }),
  );
  nets.forEach((n, i) => (n.id = `N${i + 1}`));

  return {
    project,
    connections,
    nodes,
    placements,
    wires,
    nets,
    netOf: (nodeId, pin) => {
      const k = key(nodeId, pin);
      return parent.has(k) ? netByRoot.get(find(k)) : undefined;
    },
    typeById,
    cableById,
    pcbById,
    pcbConnById,
    placementName,
    connectorName,
    pinsOf,
    nodeType,
    connectorDetails: (e) => {
      const n = nodeById.get(e.nodeId)!;
      const type = nodeType(n);
      const pc = n.pcbConnectorId ? pcbConnById.get(n.pcbConnectorId) : undefined;
      const drawn = pc ? pinsOf(pc) : [];
      const count = Math.max(drawn.length, Number(type?.pinCount ?? 0), e.inline ? Number(n.pinCount ?? 0) : 0);
      return {
        key: e.connectorKey,
        inline: e.inline,
        type: type
          ? { name: clean(type.name), pinCount: Number(type.pinCount ?? 0), rowCount: Number(type.rowCount ?? 1), crimpName: clean(type.crimpName) }
          : null,
        pins: Array.from({ length: count }, (_, i) => ({ n: i + 1, name: drawn.find((p) => p.n === i + 1)?.name ?? '' })),
      };
    },
  };
}
