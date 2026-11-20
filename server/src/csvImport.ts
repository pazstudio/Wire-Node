/**
 * Importing wires from a spreadsheet (CSV), one wire per row:
 *
 *   Connection, From component, From connector, From pin, To component, To connector, To pin,
 *   Color, Gauge, Length, Note
 *
 * Components are matched by their name in the project, connectors by label (e.g. "J3") or name,
 * pins by number or pin name. An empty component (or "inline") makes an inline connector named by
 * the connector column, e.g. a splice or a plug in the middle of a harness. Rows are grouped by
 * connection: new names make new connections, existing ones get the wires added.
 */

import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;

// ---------- CSV ----------

/** Parses CSV text (comma, semicolon or tab separated; quoted fields; BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const COLUMNS = {
  connection: ['connection', 'cable', 'harness', 'connection name'],
  fromComponent: ['from component', 'from', 'component a', 'from board', 'from part'],
  fromConnector: ['from connector', 'connector a', 'from conn'],
  fromPin: ['from pin', 'pin a'],
  toComponent: ['to component', 'to', 'component b', 'to board', 'to part'],
  toConnector: ['to connector', 'connector b', 'to conn'],
  toPin: ['to pin', 'pin b'],
  color: ['color', 'colour', 'wire color'],
  gauge: ['gauge', 'awg', 'size', 'cross section', 'mm2', 'mm²'],
  length: ['length', 'length mm', 'length (mm)', 'mm'],
  note: ['note', 'notes', 'comment'],
} as const;
type Column = keyof typeof COLUMNS;

export const CSV_TEMPLATE =
  'Connection,From component,From connector,From pin,To component,To connector,To pin,Color,Gauge,Length,Note\r\n' +
  'Fan cable,Main board,FAN0,1,Fan,J1,1,red,22 AWG,450,\r\n' +
  'Fan cable,Main board,FAN0,GND,Fan,J1,2,black,22 AWG,450,\r\n' +
  'Fan cable,,Splice A,1,Fan 2,J1,1,red,22 AWG,120,inline splice\r\n';

const COLOR_ALIASES: Record<string, string> = {
  gray: 'grey', purple: 'violet', bk: 'black', bn: 'brown', rd: 'red', og: 'orange', ye: 'yellow', gn: 'green',
  bu: 'blue', vt: 'violet', gy: 'grey', wh: 'white', pk: 'pink', tq: 'turquoise', 'green-yellow': 'green/yellow',
};
const COLORS = new Set(['black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey', 'white', 'pink', 'turquoise']);

/** "Red", "green/yellow", "GN-YE", "RD" -> stored color; unknown colors are kept as typed. */
export function normalizeColor(v: string): string {
  const t = v.trim().toLowerCase();
  if (!t) return '';
  if (COLOR_ALIASES[t]) return COLOR_ALIASES[t];
  const parts = t.split(/\s*[/\-+]\s*/).map((p) => COLOR_ALIASES[p] ?? p);
  if (parts.length <= 2 && parts.every((p) => COLORS.has(p))) return parts.join('/');
  return v.trim();
}

// ---------- Planning ----------

export interface ImportContext {
  placements: { id: string; name: string; pcbId: string }[];
  connectors: { id: string; pcbId: string; label: string; name: string; pins: { n: number; name: string }[]; pinCount: number }[];
  connections: { id: string; name: string; nodes: Row[]; wires: Row[] }[];
}

export interface PlannedConnection {
  name: string;
  /** Id of the existing connection the wires are added to; null for a new connection. */
  existingId: string | null;
  nodes: Row[];
  wires: Row[];
  newWires: number;
}

export interface ImportPlan {
  connections: PlannedConnection[];
  /** "Row 4: no component "Fan 3" in this project". */
  errors: string[];
  rows: number;
}

const norm = (s: string) => s.trim().toLowerCase();

export function planImport(text: string, ctx: ImportContext): ImportPlan {
  const table = parseCsv(text);
  const errors: string[] = [];
  if (table.length < 2) return { connections: [], errors: ['The file needs a header row and at least one wire.'], rows: 0 };

  const header = table[0].map((h) => norm(h).replace(/\s+/g, ' '));
  const col = {} as Record<Column, number>;
  for (const [key, names] of Object.entries(COLUMNS) as [Column, readonly string[]][]) {
    col[key] = header.findIndex((h) => names.includes(h));
  }
  const required: Column[] = ['connection', 'fromConnector', 'fromPin', 'toConnector', 'toPin'];
  const missing = required.filter((c) => col[c] < 0);
  if (missing.length) {
    return {
      connections: [],
      errors: [`Missing column(s): ${missing.map((c) => c.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')}. Download the template to see the format.`],
      rows: 0,
    };
  }
  const get = (r: string[], c: Column) => (col[c] >= 0 ? (r[col[c]] ?? '').trim() : '');

  const placementByName = new Map(ctx.placements.map((p) => [norm(p.name), p]));
  const connectorsOf = new Map<string, ImportContext['connectors']>();
  for (const c of ctx.connectors) connectorsOf.set(c.pcbId, [...(connectorsOf.get(c.pcbId) ?? []), c]);
  const existing = new Map(ctx.connections.map((c) => [norm(c.name), c]));
  const plans = new Map<string, PlannedConnection>();

  /** Finds or adds the node for one end, returning its id and pin number (or an error). */
  function end(plan: PlannedConnection, compName: string, connName: string, pinText: string): { nodeId: string; pin: number } | string {
    if (!connName) return 'the connector is empty';
    const inline = !compName || norm(compName) === 'inline';
    if (inline) {
      const pin = Number(pinText);
      if (!Number.isInteger(pin) || pin < 1) return `pin "${pinText}" of inline connector "${connName}" must be a number`;
      let node = plan.nodes.find((n) => !n.pcbConnectorId && norm(String(n.label ?? '')) === norm(connName));
      if (!node) {
        node = { id: randomUUID(), pcbConnectorId: null, projectPcbId: null, connectorTypeId: null, label: connName, pinCount: pin, x: 0, y: 0 };
        plan.nodes.push(node);
      }
      node.pinCount = Math.max(Number(node.pinCount ?? 0), pin);
      return { nodeId: node.id, pin };
    }
    const placement = placementByName.get(norm(compName));
    if (!placement) return `no component "${compName}" in this project`;
    const conns = connectorsOf.get(placement.pcbId) ?? [];
    const matches = conns.filter((c) => norm(c.label) === norm(connName));
    const connector = matches.length === 1 ? matches[0] : conns.find((c) => !matches.length && norm(c.name) === norm(connName));
    if (!connector) {
      return matches.length > 1 ? `"${compName}" has several connectors labelled "${connName}"` : `"${compName}" has no connector "${connName}"`;
    }
    let pin = Number(pinText);
    if (!Number.isInteger(pin)) {
      const byName = connector.pins.filter((p) => norm(p.name) === norm(pinText));
      if (byName.length !== 1) return `${compName} ${connName} has ${byName.length ? 'several pins' : 'no pin'} named "${pinText}"`;
      pin = byName[0].n;
    }
    const count = connector.pins.length || connector.pinCount;
    if (pin < 1 || (count > 0 && pin > count)) return `${compName} ${connName} has no pin ${pin} (it has ${count})`;
    let node = plan.nodes.find((n) => n.pcbConnectorId === connector.id && n.projectPcbId === placement.id);
    if (!node) {
      node = { id: randomUUID(), pcbConnectorId: connector.id, projectPcbId: placement.id, connectorTypeId: null, label: '', pinCount: 0, x: 0, y: 0 };
      plan.nodes.push(node);
    }
    return { nodeId: node.id, pin };
  }

  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const name = get(r, 'connection');
    if (!name) return void errors.push(`Row ${line}: the connection name is empty`);
    let plan = plans.get(norm(name));
    if (!plan) {
      const ex = existing.get(norm(name));
      plan = {
        name: ex?.name ?? name,
        existingId: ex?.id ?? null,
        nodes: ex ? ex.nodes.map((n) => ({ ...n })) : [],
        wires: ex ? ex.wires.map((w) => ({ ...w })) : [],
        newWires: 0,
      };
      plans.set(norm(name), plan);
    }
    const a = end(plan, get(r, 'fromComponent'), get(r, 'fromConnector'), get(r, 'fromPin'));
    const b = end(plan, get(r, 'toComponent'), get(r, 'toConnector'), get(r, 'toPin'));
    if (typeof a === 'string' || typeof b === 'string') {
      errors.push(`Row ${line}: ${[a, b].filter((x) => typeof x === 'string').join('; ')}`);
      return;
    }
    if (a.nodeId === b.nodeId && a.pin === b.pin) return void errors.push(`Row ${line}: both ends are the same pin`);
    const lengthText = get(r, 'length').replace(',', '.').replace(/\s*mm$/i, '');
    const length = lengthText ? Number(lengthText) : null;
    if (length != null && !(Number.isFinite(length) && length >= 0)) return void errors.push(`Row ${line}: length "${get(r, 'length')}" is not a number of mm`);
    const dupe = plan.wires.some(
      (w) =>
        (w.fromNodeId === a.nodeId && w.fromPin === a.pin && w.toNodeId === b.nodeId && w.toPin === b.pin) ||
        (w.fromNodeId === b.nodeId && w.fromPin === b.pin && w.toNodeId === a.nodeId && w.toPin === a.pin),
    );
    if (dupe) return; // already there (e.g. the same file imported twice)
    plan.wires.push({
      id: randomUUID(),
      fromNodeId: a.nodeId,
      fromPin: a.pin,
      toNodeId: b.nodeId,
      toPin: b.pin,
      cableId: null,
      coreIndex: null,
      color: normalizeColor(get(r, 'color')),
      lengthMm: length,
      gauge: get(r, 'gauge').slice(0, 50),
      shielded: null,
      note: get(r, 'note'),
    });
    plan.newWires++;
  });

  // Lay new nodes out left to right, below any that already have a position.
  for (const plan of plans.values()) {
    const placed = plan.nodes.filter((n) => n.x || n.y);
    const baseY = placed.length ? Math.max(...placed.map((n) => Number(n.y))) + 260 : 0;
    plan.nodes.filter((n) => !n.x && !n.y).forEach((n, i) => {
      n.x = i * 320;
      n.y = baseY;
    });
  }

  return { connections: [...plans.values()].filter((p) => p.newWires > 0), errors, rows: table.length - 1 };
}
