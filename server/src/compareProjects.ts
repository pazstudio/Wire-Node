/**
 * Differences between two projects, e.g. machine revision 2 and its duplicate revision 3.
 * Everything is matched by name, since a duplicate has new ids: components by their name in the
 * project, connections by name, and wires within a connection by their two ends (in either direction).
 */

import type { WiringRows } from './wiringReport.js';
import { buildProjectModel, type ResolvedWire } from './projectModel.js';

export interface ConnectionDiff {
  name: string;
  status: 'added' | 'removed' | 'changed';
  /** Lines like "Added W3: Board:J1.1 → Fan:J1.1 (red, 22 AWG)". */
  lines: string[];
}

export interface ProjectDiff {
  a: { id: string; name: string };
  b: { id: string; name: string };
  components: { added: string[]; removed: string[]; changed: string[] };
  connections: ConnectionDiff[];
  /** Number of differences in total (0 = same wiring). */
  total: number;
}

const lower = (s: string) => s.trim().toLowerCase();
const collate = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function wireKey(w: ResolvedWire) {
  const a = lower(w.from.short);
  const b = lower(w.to.short);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function wireText(w: ResolvedWire) {
  const props = [w.color, w.gauge, w.shielded && 'shielded', w.lengthMm != null && `${w.lengthMm} mm`, w.cableName && `cable ${w.cableName}`]
    .filter(Boolean)
    .join(', ');
  return `${w.from.short} → ${w.to.short}${props ? ` (${props})` : ''}`;
}

function propChanges(a: ResolvedWire, b: ResolvedWire): string[] {
  const out: string[] = [];
  const cmp = (label: string, x: unknown, y: unknown, fmt = (v: unknown) => (v === '' || v == null ? 'none' : String(v))) => {
    if ((x ?? '') !== (y ?? '')) out.push(`${label} ${fmt(x)} → ${fmt(y)}`);
  };
  cmp('color', a.color, b.color);
  cmp('gauge', a.gauge, b.gauge);
  cmp('shielded', a.shielded ? 'yes' : 'no', b.shielded ? 'yes' : 'no');
  cmp('length', a.lengthMm, b.lengthMm, (v) => (v == null ? 'none' : `${v} mm`));
  cmp('cable', a.cableName, b.cableName);
  cmp('note', a.note, b.note);
  return out;
}

export function compareProjects(rows: WiringRows, aId: string, bId: string): ProjectDiff | null {
  const A = buildProjectModel(rows, aId);
  const B = buildProjectModel(rows, bId);
  if (!A || !B) return null;

  // Components (placements) by name; "changed" = same name, different library component.
  const placements = (m: NonNullable<typeof A>) =>
    new Map(m.placements.map((p) => [lower(m.placementName(p)), { name: m.placementName(p), pcb: String(m.pcbById.get(p.pcbId)?.name ?? '') }]));
  const pa = placements(A);
  const pb = placements(B);
  const components = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  for (const [k, v] of pb) if (!pa.has(k)) components.added.push(v.name);
  for (const [k, v] of pa) if (!pb.has(k)) components.removed.push(v.name);
  for (const [k, v] of pb) {
    const old = pa.get(k);
    // Frozen copies keep the library name (or get a suffix), so compare names without "(…)" suffixes.
    const base = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
    if (old && base(old.pcb) !== base(v.pcb)) components.changed.push(`${v.name}: component "${old.pcb}" → "${v.pcb}"`);
  }
  components.added.sort(collate);
  components.removed.sort(collate);
  components.changed.sort(collate);

  const conns = (m: NonNullable<typeof A>) => {
    const map = new Map<string, { name: string; wires: ResolvedWire[] }>();
    for (const c of m.connections) map.set(lower(String(c.name)), { name: String(c.name), wires: [] });
    for (const w of m.wires) map.get(lower(w.connectionName))?.wires.push(w);
    return map;
  };
  const ca = conns(A);
  const cb = conns(B);
  const connections: ConnectionDiff[] = [];
  for (const [k, v] of cb) {
    if (!ca.has(k)) connections.push({ name: v.name, status: 'added', lines: v.wires.map((w) => `Wire ${wireText(w)}`) });
  }
  for (const [k, v] of ca) {
    if (!cb.has(k)) connections.push({ name: v.name, status: 'removed', lines: v.wires.map((w) => `Wire ${wireText(w)}`) });
  }
  for (const [k, vb] of cb) {
    const va = ca.get(k);
    if (!va) continue;
    const lines: string[] = [];
    const wa = new Map<string, ResolvedWire[]>();
    for (const w of va.wires) wa.set(wireKey(w), [...(wa.get(wireKey(w)) ?? []), w]);
    const matched = new Set<ResolvedWire>();
    for (const w of vb.wires) {
      const cands = (wa.get(wireKey(w)) ?? []).filter((x) => !matched.has(x));
      const old = cands[0];
      if (!old) {
        lines.push(`Added wire ${wireText(w)}`);
        continue;
      }
      matched.add(old);
      const ch = propChanges(old, w);
      if (ch.length) lines.push(`Wire ${w.from.short} → ${w.to.short}: ${ch.join(', ')}`);
    }
    for (const w of va.wires) if (!matched.has(w)) lines.push(`Removed wire ${wireText(w)}`);
    if (lines.length) connections.push({ name: vb.name, status: 'changed', lines });
  }
  const order = { removed: 0, added: 1, changed: 2 };
  connections.sort((x, y) => order[x.status] - order[y.status] || collate(x.name, y.name));

  const total =
    components.added.length +
    components.removed.length +
    components.changed.length +
    connections.reduce((s, c) => s + (c.status === 'changed' ? c.lines.length : 1), 0);
  return {
    a: { id: aId, name: String(A.project.name) },
    b: { id: bId, name: String(B.project.name) },
    components,
    connections,
    total,
  };
}
