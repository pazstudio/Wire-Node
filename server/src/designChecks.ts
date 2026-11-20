/**
 * Design checks of a project's wiring: mistakes that are easy to make and expensive to find on the
 * bench. Each issue has a severity:
 *   error   - almost certainly wrong (a short between two supplies, a pin that does not exist,
 *             a wire too thin for the current its pins declare)
 *   warning - probably wrong or incomplete (a pin wired in two connections, missing gauge or length)
 *   info    - worth a look (free connectors, nets whose pin names differ)
 */

import { createHash } from 'node:crypto';
import type { WiringRows } from './wiringReport.js';
import { buildProjectModel, type Net } from './projectModel.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  /** Identifies the finding (its kind and the pins or items involved), for dismissing it. */
  key: string;
  severity: Severity;
  /** Stable kind, e.g. "supply-short". */
  code: string;
  title: string;
  /** Details, one line each. */
  items: string[];
  connectionId?: string;
  /** Connections the finding is in, when it spans wires (a net can run through several). */
  connections?: { id: string; name: string }[];
  placementId?: string;
  pcbId?: string;
}

export interface CheckResult {
  issues: Issue[];
  counts: Record<Severity, number>;
  /** Nets with their names and ends (shown on the Nets view). */
  nets: { id: string; names: string[]; ends: string[]; wires: number; maxCurrent: number | null }[];
}

// ---- Wire size ----

const AWG_MM2: Record<number, number> = {
  32: 0.03, 30: 0.05, 28: 0.08, 26: 0.13, 24: 0.2, 22: 0.33, 20: 0.52, 18: 0.82, 16: 1.31, 14: 2.08, 12: 3.31, 10: 5.26, 8: 8.37,
};

/** Cross-section in mm² from "22 AWG", "AWG22", "0.5 mm²", "0.5mm2" or "0,5"; null if it cannot be read. */
export function gaugeToMm2(gauge: string): number | null {
  const g = gauge.trim().toLowerCase().replace(',', '.');
  if (!g) return null;
  const awg = /^(?:awg\s*(\d+)|(\d+)\s*(?:awg|ga|g))$/.exec(g);
  if (awg) return AWG_MM2[Number(awg[1] ?? awg[2])] ?? null;
  const mm = /^(\d*\.?\d+)\s*(?:mm²|mm2|mm\^2|qmm|sqmm)?$/.exec(g);
  if (mm) {
    const v = Number(mm[1]);
    return v > 0 && v < 200 ? v : null;
  }
  return null;
}

// Rough current a copper wire in a bundle can carry continuously (PVC, around 30 °C). A guide only:
// short runs and good airflow allow more, hot enclosures less.
const AMPACITY: [number, number][] = [
  [0.03, 0.5], [0.05, 0.8], [0.08, 1], [0.14, 1.5], [0.25, 3], [0.34, 4], [0.5, 6], [0.75, 8],
  [1, 10], [1.5, 14], [2.5, 20], [4, 27], [6, 35], [10, 50], [16, 68],
];

/** Approximate safe current (A) for a cross-section in mm², interpolated from the table. */
export function ampacity(mm2: number): number {
  if (mm2 <= AMPACITY[0][0]) return AMPACITY[0][1] * (mm2 / AMPACITY[0][0]);
  for (let i = 1; i < AMPACITY.length; i++) {
    const [x1, y1] = AMPACITY[i];
    if (mm2 <= x1) {
      const [x0, y0] = AMPACITY[i - 1];
      return y0 + ((mm2 - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return AMPACITY[AMPACITY.length - 1][1];
}

// ---- Supply names ----

/**
 * The supply a pin name stands for, or null if it is not a supply: "24V", "+24V", "V24", "24 VDC"
 * -> "24V"; "GND", "0V", "PGND", "GND1" -> "GND"; "3V3", "3.3V" -> "3.3V". VCC / VIN / VMOT etc. are
 * left out on purpose: their voltage differs between boards.
 */
export function supplyOf(name: string): string | null {
  const n = name.trim().toUpperCase().replace(/\s+/g, '');
  if (!n) return null;
  if (/^(?:[AP]?GND|GROUND|0V|V-|VSS)\d*$/.test(n)) return 'GND';
  const vv = /^\+?(\d+)V(\d+)$/.exec(n); // 3V3, 1V8
  if (vv) return `${Number(`${vv[1]}.${vv[2]}`)}V`;
  const v = /^(?:\+?(\d+(?:\.\d+)?)V(?:DC)?|V(\d+(?:\.\d+)?))$/.exec(n);
  if (v) return `${Number(v[1] ?? v[2])}V`;
  return null;
}

export function runDesignChecks(rows: WiringRows, projectId: string): CheckResult | null {
  const m = buildProjectModel(rows, projectId);
  if (!m) return null;
  const issues: Omit<Issue, 'key'>[] = [];
  const connName = new Map(m.connections.map((c) => [c.id, String(c.name ?? '')]));
  const wireConn = new Map(m.wires.map((w) => [w.id, w.connectionId]));
  /** Connections the wires of some nets belong to, in name order. */
  const connsOf = (...nets: Net[]) =>
    [...new Set(nets.flatMap((n) => n.wireIds.map((id) => wireConn.get(id)!)))]
      .map((id) => ({ id, name: connName.get(id) ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  // Max declared current per net.
  const netCurrent = new Map<Net, number>();
  for (const net of m.nets) {
    let max: number | null = null;
    for (const e of net.ends) {
      if (e.inline) continue;
      const node = m.nodes.find((n) => n.id === e.nodeId);
      const pc = node?.pcbConnectorId ? m.pcbConnById.get(node.pcbConnectorId) : undefined;
      const cur = pc ? m.pinsOf(pc).find((p) => p.n === e.pin)?.current : null;
      if (cur != null) max = Math.max(max ?? 0, cur);
    }
    if (max != null) netCurrent.set(net, max);
  }

  // 1. Two different supplies on one net.
  for (const net of m.nets) {
    const supplies = new Map<string, string[]>();
    for (const e of net.ends) {
      const s = supplyOf(e.pinName);
      if (s) supplies.set(s, [...(supplies.get(s) ?? []), e.text]);
    }
    if (supplies.size > 1) {
      issues.push({
        severity: 'error',
        code: 'supply-short',
        title: `Short: ${[...supplies.keys()].join(' and ')} are wired together`,
        items: [...supplies.entries()].flatMap(([s, ends]) => ends.map((t) => `${s}: ${t}`)),
        connections: connsOf(net),
      });
    }
  }

  // 2. Wire on a pin the connector does not have.
  for (const w of m.wires) {
    for (const e of [w.from, w.to]) {
      const node = m.nodes.find((n) => n.id === e.nodeId)!;
      const pc = node.pcbConnectorId ? m.pcbConnById.get(node.pcbConnectorId) : undefined;
      const count = pc ? m.pinsOf(pc).length : Number(node.pinCount || m.nodeType(node)?.pinCount || 0);
      if (count > 0 && e.pin > count) {
        issues.push({
          severity: 'error',
          code: 'pin-out-of-range',
          title: `${w.ref} ends on pin ${e.pin}, but ${e.short.replace(/\.\d+$/, '')} has ${count} pins`,
          items: [`${w.from.text} → ${w.to.text}`],
          connectionId: w.connectionId,
        });
      }
    }
  }

  // 3. Wire too thin for the current declared on its pins.
  for (const w of m.wires) {
    const net = m.netOf(w.from.nodeId, w.from.pin);
    const amps = net ? netCurrent.get(net) : undefined;
    if (amps == null) continue;
    const mm2 = gaugeToMm2(w.gauge);
    if (mm2 == null) {
      if (w.gauge) continue; // gauge given in a form we cannot read
      issues.push({
        severity: 'warning',
        code: 'current-no-gauge',
        title: `${w.ref} carries up to ${amps} A but has no gauge`,
        items: [`${w.from.text} → ${w.to.text}`],
        connectionId: w.connectionId,
      });
      continue;
    }
    const max = ampacity(mm2);
    if (amps > max) {
      issues.push({
        severity: 'error',
        code: 'gauge-too-thin',
        title: `${w.ref} (${w.gauge}, about ${max.toFixed(1)} A) is too thin for ${amps} A`,
        items: [`${w.from.text} → ${w.to.text}`, `Connection "${w.connectionName}"`],
        connectionId: w.connectionId,
      });
    }
  }

  // 4. A board pin wired in more than one connection.
  const pinConns = new Map<string, { text: string; conns: Set<string> }>();
  for (const w of m.wires) {
    for (const e of [w.from, w.to]) {
      if (e.inline) continue;
      const k = `${e.placementId}|${e.short}`;
      const v = pinConns.get(k) ?? { text: e.text, conns: new Set<string>() };
      v.conns.add(w.connectionId);
      pinConns.set(k, v);
    }
  }
  for (const v of pinConns.values()) {
    if (v.conns.size < 2) continue;
    issues.push({
      severity: 'warning',
      code: 'pin-in-several-connections',
      title: `${v.text} is wired in ${v.conns.size} connections`,
      items: [...v.conns].map((id) => `Connection "${connName.get(id)}"`),
      connections: [...v.conns].map((id) => ({ id, name: connName.get(id) ?? '' })),
    });
  }

  // 5. Missing gauge / length / color, one issue per connection.
  for (const c of m.connections) {
    const ws = m.wires.filter((w) => w.connectionId === c.id);
    const noGauge = ws.filter((w) => !w.gauge);
    const noLength = ws.filter((w) => w.lengthMm == null);
    const noColor = ws.filter((w) => !w.color);
    const missing: string[] = [];
    if (noGauge.length) missing.push(`gauge (${noGauge.map((w) => w.ref).join(', ')})`);
    if (noLength.length) missing.push(`length (${noLength.map((w) => w.ref).join(', ')})`);
    if (noColor.length) missing.push(`color (${noColor.map((w) => w.ref).join(', ')})`);
    if (missing.length) {
      issues.push({
        severity: 'warning',
        code: 'incomplete-wires',
        title: `"${c.name}": wires without ${[noGauge.length && 'gauge', noLength.length && 'length', noColor.length && 'color']
          .filter(Boolean)
          .join(', ')}`,
        items: missing.map((s) => `Missing ${s}`),
        connectionId: c.id,
      });
    }
    if (!ws.length) {
      issues.push({ severity: 'info', code: 'empty-connection', title: `"${c.name}" has no wires`, items: [], connectionId: c.id });
    }
  }

  // 6. Same pin of one node with more than one wire (double crimp).
  const endCount = new Map<string, { n: number; text: string; connectionId: string }>();
  for (const w of m.wires) {
    for (const e of [w.from, w.to]) {
      if (e.inline) continue;
      const k = `${e.nodeId}#${e.pin}`;
      const v = endCount.get(k) ?? { n: 0, text: e.text, connectionId: w.connectionId };
      v.n++;
      endCount.set(k, v);
    }
  }
  for (const v of endCount.values()) {
    if (v.n > 1) {
      issues.push({
        severity: 'info',
        code: 'double-crimp',
        title: `${v.n} wires end on ${v.text}`,
        items: ['They need a double crimp or a splice before the connector.'],
        connectionId: v.connectionId,
      });
    }
  }

  // 7. Nets whose pin names differ (not supplies; that is check 1). Very common (a board's "M1A"
  // wired to a motor's "A+"), so one issue lists them all.
  const mismatches: string[] = [];
  const mismatchNets: Net[] = [];
  for (const net of m.nets) {
    const named = net.ends.filter((e) => e.pinName);
    const distinct = new Set(named.map((e) => e.pinName.toUpperCase()));
    if (distinct.size < 2) continue;
    if (new Set(named.map((e) => supplyOf(e.pinName)).filter(Boolean)).size > 1) continue;
    mismatches.push(named.map((e) => `${e.short} "${e.pinName}"`).join(' ⟷ '));
    mismatchNets.push(net);
  }
  if (mismatches.length) {
    issues.push({
      severity: 'info',
      code: 'name-mismatch',
      title: `${mismatches.length} net${mismatches.length > 1 ? 's join pins' : ' joins pins'} with different names`,
      items: mismatches,
      connections: connsOf(...mismatchNets),
    });
  }

  // 9. Pin roles: set on the component (or recognised from names such as CAN_H, 24V, GND).
  const roleOf = (e: { pinRole: string; pinName: string; inline: boolean }) => {
    if (e.pinRole) return e.pinRole;
    const n = e.pinName.toUpperCase().replace(/[\s_-]/g, '');
    if (/^CANH\d*$/.test(n)) return 'can_h';
    if (/^CANL\d*$/.test(n)) return 'can_l';
    const sup = supplyOf(e.pinName);
    return sup === 'GND' ? 'ground' : sup ? 'power' : '';
  };
  for (const net of m.nets) {
    const ends = net.ends.filter((e) => !e.inline);
    const role = (r: string) => ends.filter((e) => roleOf(e) === r);
    const canH = role('can_h');
    const canL = role('can_l');
    if (canH.length && canL.length) {
      issues.push({
        severity: 'error',
        code: 'can-swapped',
        title: 'CAN_H is wired to CAN_L',
        items: [...canH, ...canL].map((e) => `${roleOf(e) === 'can_h' ? 'CAN_H' : 'CAN_L'}: ${e.text}`),
        connections: connsOf(net),
      });
    }
    const outs = ends.filter((e) => e.pinRole === 'output');
    if (outs.length > 1) {
      issues.push({
        severity: 'error',
        code: 'outputs-joined',
        title: `${outs.length} outputs drive the same net`,
        items: outs.map((e) => e.text),
        connections: connsOf(net),
      });
    }
    const explicitPower = ends.filter((e) => e.pinRole === 'power');
    const explicitGround = ends.filter((e) => e.pinRole === 'ground');
    const namedSupplies = new Set(ends.map((e) => supplyOf(e.pinName)).filter(Boolean));
    if (explicitPower.length && explicitGround.length && namedSupplies.size < 2) {
      issues.push({
        severity: 'error',
        code: 'power-ground',
        title: 'A power pin is wired to a ground pin',
        items: [...explicitPower.map((e) => `power: ${e.text}`), ...explicitGround.map((e) => `ground: ${e.text}`)],
        connections: connsOf(net),
      });
    }
    const supplyEnds = ends.filter((e) => ['power', 'ground'].includes(roleOf(e)));
    if (outs.length && supplyEnds.length) {
      issues.push({
        severity: 'warning',
        code: 'output-on-supply',
        title: 'An output is wired straight to a supply or ground',
        items: [...outs.map((e) => `output: ${e.text}`), ...supplyEnds.map((e) => `${roleOf(e)}: ${e.text}`)],
        connections: connsOf(net),
      });
    }
  }

  // 10. Voltage drop: wires on a supply net with a known current, length and gauge. The return wire
  // is assumed to be as long and thick, so the loop loses twice the drop of one wire.
  for (const w of m.wires) {
    const net = m.netOf(w.from.nodeId, w.from.pin);
    const amps = net ? netCurrent.get(net) : undefined;
    const mm2 = gaugeToMm2(w.gauge);
    if (!net || amps == null || mm2 == null || w.lengthMm == null) continue;
    const volts = net.names.map((n) => supplyOf(n)).find((x) => x && x !== 'GND');
    if (!volts) continue;
    const v = parseFloat(volts);
    const loop = 2 * amps * 0.0175 * (w.lengthMm / 1000) / mm2;
    if (loop > 0.03 * v) {
      issues.push({
        severity: 'warning',
        code: 'voltage-drop',
        title: `${w.ref} loses about ${loop.toFixed(2)} V (${((loop / v) * 100).toFixed(1)} % of ${volts}) at ${amps} A`,
        items: [
          `${w.from.text} → ${w.to.text}`,
          `${w.lengthMm} mm of ${w.gauge}, there and back. Over 3 % is worth a thicker wire.`,
        ],
        connectionId: w.connectionId,
      });
    }
  }

  // 8. Free connectors on placed components.
  const usedConn = new Set(m.nodes.filter((n) => m.wires.some((w) => w.from.nodeId === n.id || w.to.nodeId === n.id)).map((n) => `${n.projectPcbId}|${n.pcbConnectorId}`));
  for (const pp of m.placements) {
    const free = [...m.pcbConnById.values()]
      .filter((c) => c.pcbId === pp.pcbId && !usedConn.has(`${pp.id}|${c.id}`))
      .map((c) => m.connectorName(c) + (c.name && String(c.name).trim() !== m.connectorName(c) ? ` (${String(c.name).trim()})` : ''))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (free.length) {
      issues.push({
        severity: 'info',
        code: 'free-connectors',
        title: `${m.placementName(pp)}: ${free.length} connector${free.length > 1 ? 's' : ''} not wired`,
        items: free,
        placementId: pp.id,
        pcbId: pp.pcbId,
      });
    }
  }

  const keyed: Issue[] = issues.map((i) => ({
    ...i,
    key: createHash('sha1')
      .update([i.code, i.connectionId ?? '', i.placementId ?? '', ...i.items].join('\n'))
      .digest('hex')
      .slice(0, 20),
  }));
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  keyed.sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code) || a.title.localeCompare(b.title, undefined, { numeric: true }));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of keyed) counts[i.severity]++;

  return {
    issues: keyed,
    counts,
    nets: m.nets.map((n) => ({
      id: n.id,
      names: n.names,
      ends: n.ends.map((e) => e.text),
      wires: n.wireIds.length,
      maxCurrent: netCurrent.get(n) ?? null,
    })),
  };
}
