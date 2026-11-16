/**
 * Readable "what changed" lines for the history, from a snapshot taken when an editing session
 * started and one taken after the latest save. Positions on the canvas are ignored: moving a
 * connector box around is not a change anybody needs to read about.
 */

export interface ConnectionSnapshot {
  name: string;
  description: string;
  lengthMm: number | null;
  zones: { id: string; name: string }[];
  /** name: e.g. "Mainboard: J3 · Power" or "Splice (free)" */
  nodes: { id: string; name: string; pinCount: number }[];
  /** from/to: e.g. "Mainboard: J3 · Power pin 2 (VCC)" */
  wires: { id: string; from: string; to: string; color: string; cable: string; lengthMm: number | null; note: string }[];
}

export interface ComponentSnapshot {
  name: string;
  description: string;
  image: string;
  connectors: {
    id: string;
    name: string;
    type: string;
    /** Rounded rectangle, to tell "moved or resized" without noise from tiny drags. */
    rect: string;
    pins: { n: number; name: string; color: string }[];
  }[];
}

/** At most this many lines are kept per entry. */
export const MAX_SUMMARY_LINES = 200;

const q = (s: string) => `"${s}"`;
const orNone = (s: string) => (s ? q(s) : 'none');
const mm = (v: number | null) => (v == null ? 'not set' : `${v} mm`);

function byId<T extends { id: string }>(items: T[]) {
  return new Map(items.map((i) => [i.id, i]));
}

function cap(lines: string[]) {
  if (lines.length <= MAX_SUMMARY_LINES) return lines;
  return [...lines.slice(0, MAX_SUMMARY_LINES - 1), `…and ${lines.length - MAX_SUMMARY_LINES + 1} more changes`];
}

function textChange(lines: string[], label: string, a: string, b: string) {
  if (a === b) return;
  lines.push(a && b ? `${label}: ${q(a)} → ${q(b)}` : b ? `${label} set to ${q(b)}` : `${label} cleared (was ${q(a)})`);
}

export function diffConnection(a: ConnectionSnapshot, b: ConnectionSnapshot): string[] {
  const lines: string[] = [];
  textChange(lines, 'Renamed', a.name, b.name);
  if (a.description !== b.description) lines.push(b.description ? 'Description changed' : 'Description removed');
  if (a.lengthMm !== b.lengthMm) lines.push(`Cable length: ${mm(a.lengthMm)} → ${mm(b.lengthMm)}`);

  const nodesA = byId(a.nodes);
  const nodesB = byId(b.nodes);
  for (const n of b.nodes) {
    const old = nodesA.get(n.id);
    if (!old) lines.push(`Added connector ${n.name}`);
    else {
      if (old.name !== n.name) lines.push(`Connector renamed: ${old.name} → ${n.name}`);
      if (old.pinCount !== n.pinCount) lines.push(`Connector ${n.name}: ${old.pinCount} → ${n.pinCount} pins`);
    }
  }
  for (const n of a.nodes) if (!nodesB.has(n.id)) lines.push(`Removed connector ${n.name}`);

  const wiresA = byId(a.wires);
  const wiresB = byId(b.wires);
  const wireName = (w: ConnectionSnapshot['wires'][number]) => `${w.from} → ${w.to}`;
  for (const w of b.wires) {
    const old = wiresA.get(w.id);
    if (!old) {
      lines.push(`Added wire ${wireName(w)}${w.color ? ` (${w.color})` : ''}`);
      continue;
    }
    const parts: string[] = [];
    if (old.from !== w.from || old.to !== w.to) parts.push(`rewired from ${wireName(old)}`);
    if (old.color !== w.color) parts.push(`color ${old.color || 'none'} → ${w.color || 'none'}`);
    if (old.cable !== w.cable) parts.push(`cable ${orNone(old.cable)} → ${orNone(w.cable)}`);
    if (old.lengthMm !== w.lengthMm) parts.push(`length ${mm(old.lengthMm)} → ${mm(w.lengthMm)}`);
    if (old.note !== w.note) parts.push(w.note ? `note ${q(w.note)}` : 'note removed');
    if (parts.length) lines.push(`Wire ${wireName(w)}: ${parts.join(', ')}`);
  }
  for (const w of a.wires) if (!wiresB.has(w.id)) lines.push(`Removed wire ${wireName(w)}`);

  const zonesA = byId(a.zones);
  const zonesB = byId(b.zones);
  for (const z of b.zones) {
    const old = zonesA.get(z.id);
    if (!old) lines.push(`Added zone ${q(z.name || 'Zone')}`);
    else if (old.name !== z.name) lines.push(`Zone renamed: ${q(old.name)} → ${q(z.name)}`);
  }
  for (const z of a.zones) if (!zonesB.has(z.id)) lines.push(`Removed zone ${q(z.name || 'Zone')}`);
  return cap(lines);
}

export function diffComponent(a: ComponentSnapshot, b: ComponentSnapshot): string[] {
  const lines: string[] = [];
  textChange(lines, 'Renamed', a.name, b.name);
  if (a.description !== b.description) lines.push(b.description ? 'Description changed' : 'Description removed');
  if (a.image !== b.image) lines.push('Picture replaced');

  const before = byId(a.connectors);
  const after = byId(b.connectors);
  for (const c of b.connectors) {
    const old = before.get(c.id);
    const label = c.name || 'unnamed connector';
    if (!old) {
      lines.push(`Added connector ${label}${c.type ? ` (${c.type})` : ''}`);
      continue;
    }
    const parts: string[] = [];
    if (old.name !== c.name) parts.push(`renamed from ${old.name || 'unnamed'}`);
    if (old.type !== c.type) parts.push(`type ${orNone(old.type)} → ${orNone(c.type)}`);
    if (old.rect !== c.rect) parts.push('moved or resized');
    const pinsA = new Map(old.pins.map((p) => [p.n, p]));
    const pinsB = new Map(c.pins.map((p) => [p.n, p]));
    if (old.pins.length !== c.pins.length) parts.push(`${old.pins.length} → ${c.pins.length} pins`);
    for (const p of c.pins) {
      const o = pinsA.get(p.n);
      if (!o) {
        if (p.name || p.color) parts.push(`pin ${p.n} ${[p.name && q(p.name), p.color].filter(Boolean).join(' ')}`);
        continue;
      }
      if (o.name !== p.name) parts.push(`pin ${p.n} name ${o.name ? q(o.name) : 'empty'} → ${p.name ? q(p.name) : 'empty'}`);
      if (o.color !== p.color) parts.push(`pin ${p.n} color ${o.color || 'none'} → ${p.color || 'none'}`);
    }
    for (const p of old.pins) if (!pinsB.has(p.n) && (p.name || p.color)) parts.push(`pin ${p.n} ${q(p.name)} removed`);
    if (parts.length) lines.push(`Connector ${label}: ${parts.join(', ')}`);
  }
  for (const c of a.connectors) if (!after.has(c.id)) lines.push(`Removed connector ${c.name || 'unnamed connector'}`);
  return cap(lines);
}
