/**
 * Build list of a project: what to buy and cut to make its harnesses.
 *
 * - Loose wires (not a core of a cable) are grouped by gauge, color and shielding into a cut list.
 * - Cables are counted once per connection, at the longest length of their cores there.
 * - Connector housings: one per connection node with a connector type. An inline connector is a
 *   mated pair, so it needs two housings and a crimp on both sides of every pin.
 * - Crimps: one per wire end on a node whose connector type names a crimp.
 * - Splices: inline nodes without a connector type, one per pin used.
 */

import type { WiringRows } from './wiringReport.js';
import { buildProjectModel, type ResolvedWire } from './projectModel.js';

export interface CutGroup {
  gauge: string;
  color: string;
  shielded: boolean;
  count: number;
  /** Sum of the wire lengths that are known. */
  totalMm: number;
  /** Wires in this group with no length (neither their own nor the connection's). */
  missingLength: number;
  wires: { ref: string; connection: string; from: string; to: string; lengthMm: number | null }[];
}

export interface CableUse {
  cableId: string;
  name: string;
  gauge: string;
  coreCount: number;
  shielded: boolean;
  /** One piece per connection that uses the cable. */
  pieces: { connection: string; lengthMm: number | null; coresUsed: number }[];
  totalMm: number;
  missingLength: number;
}

export interface PartLine {
  /** "housing" | "crimp" | "splice" */
  kind: 'housing' | 'crimp' | 'splice';
  name: string;
  count: number;
  /** Where they go, e.g. "Octopus › M0 (X motor cable)". */
  where: string[];
}

export interface BuildList {
  projectName: string;
  wireCount: number;
  cutList: CutGroup[];
  cables: CableUse[];
  parts: PartLine[];
  /** Wires without a gauge (they are listed in the cut list under an empty gauge too). */
  wiresWithoutGauge: number;
}

const collator = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function buildBuildList(rows: WiringRows, projectId: string): BuildList | null {
  const m = buildProjectModel(rows, projectId);
  if (!m) return null;

  const loose = m.wires.filter((w) => !w.cableId);
  const groups = new Map<string, CutGroup>();
  for (const w of loose) {
    const k = `${w.gauge}|${w.color}|${w.shielded}`;
    let g = groups.get(k);
    if (!g) {
      g = { gauge: w.gauge, color: w.color, shielded: w.shielded, count: 0, totalMm: 0, missingLength: 0, wires: [] };
      groups.set(k, g);
    }
    g.count++;
    if (w.lengthMm == null) g.missingLength++;
    else g.totalMm += w.lengthMm;
    g.wires.push({ ref: w.ref, connection: w.connectionName, from: w.from.text, to: w.to.text, lengthMm: w.lengthMm });
  }
  const cutList = [...groups.values()].sort(
    (a, b) => collator(a.gauge || '￿', b.gauge || '￿') || collator(a.color, b.color) || Number(a.shielded) - Number(b.shielded),
  );

  // Cables: one piece per (cable, connection).
  const cableUse = new Map<string, CableUse>();
  const pieces = new Map<string, ResolvedWire[]>();
  for (const w of m.wires) {
    if (!w.cableId) continue;
    const k = `${w.cableId}|${w.connectionId}`;
    pieces.set(k, [...(pieces.get(k) ?? []), w]);
  }
  for (const list of pieces.values()) {
    const cable = m.cableById.get(list[0].cableId!)!;
    let use = cableUse.get(cable.id);
    if (!use) {
      use = {
        cableId: cable.id,
        name: String(cable.name ?? ''),
        gauge: String(cable.gauge ?? ''),
        coreCount: Number(cable.coreCount ?? 0),
        shielded: !!cable.shielded,
        pieces: [],
        totalMm: 0,
        missingLength: 0,
      };
      cableUse.set(cable.id, use);
    }
    const lengths = list.map((w) => w.lengthMm).filter((x): x is number => x != null);
    const len = lengths.length ? Math.max(...lengths) : null;
    use.pieces.push({
      connection: list[0].connectionName,
      lengthMm: len,
      coresUsed: new Set(list.map((w) => w.coreIndex ?? w.id)).size,
    });
    if (len == null) use.missingLength++;
    else use.totalMm += len;
  }
  const cables = [...cableUse.values()].sort((a, b) => collator(a.name, b.name));
  for (const c of cables) c.pieces.sort((a, b) => collator(a.connection, b.connection));

  // Connector parts.
  const parts = new Map<string, PartLine>();
  const add = (kind: PartLine['kind'], name: string, count: number, where: string) => {
    if (count <= 0) return;
    const k = `${kind}|${name}`;
    const p = parts.get(k) ?? { kind, name, count: 0, where: [] };
    p.count += count;
    if (!p.where.includes(where)) p.where.push(where);
    parts.set(k, p);
  };
  const connName = new Map(m.connections.map((c) => [c.id, String(c.name ?? '')]));
  const endsAt = new Map<string, { pins: Set<number>; ends: number }>();
  for (const w of m.wires) {
    for (const e of [w.from, w.to]) {
      const s = endsAt.get(e.nodeId) ?? { pins: new Set<number>(), ends: 0 };
      s.pins.add(e.pin);
      s.ends++;
      endsAt.set(e.nodeId, s);
    }
  }
  for (const n of m.nodes) {
    const used = endsAt.get(n.id);
    if (!used) continue;
    const type = m.nodeType(n);
    const inline = !(n.pcbConnectorId && n.projectPcbId);
    const pc = n.pcbConnectorId ? m.pcbConnById.get(n.pcbConnectorId) : undefined;
    const pl = n.projectPcbId ? m.placements.find((p) => p.id === n.projectPcbId) : undefined;
    const where = `${
      pc && pl ? `${m.placementName(pl)} › ${m.connectorName(pc)}` : `inline "${String(n.label ?? '').trim() || 'unnamed'}"`
    } (${connName.get(n.connectionId)})`;
    if (!type) {
      if (inline) add('splice', 'Splice / solder joint', used.pins.size, where);
      continue;
    }
    const name = `${type.name} (${type.pinCount} pins)`;
    add('housing', name, inline ? 2 : 1, where);
    if (type.crimpName) {
      // On an inline connector every pin has a crimp on each side: count wire ends, at least one per side.
      add('crimp', String(type.crimpName), inline ? Math.max(used.ends, used.pins.size * 2) : used.ends, where);
    }
  }
  const order = { housing: 0, crimp: 1, splice: 2 };
  const partList = [...parts.values()].sort((a, b) => order[a.kind] - order[b.kind] || collator(a.name, b.name));
  for (const p of partList) p.where.sort(collator);

  return {
    projectName: String(m.project.name ?? ''),
    wireCount: m.wires.length,
    cutList,
    cables,
    parts: partList,
    wiresWithoutGauge: m.wires.filter((w) => !w.gauge).length,
  };
}
