/**
 * Draft firmware configuration from the wiring: which device is on which controller port.
 *
 * RepRapFirmware (Duet): config.g lines with port names such as "1.temp0", "out3", "20.io1.in" and
 * drives "0.2". A board's CAN address is set per placement (fwAddress): "" or "0" = the main board,
 * "1" an expansion board, "20" a toolboard.
 * Klipper: section skeletons with the connector each device is on; the MCU pin names (e.g. PF13)
 * are not in the wiring, so they are left as placeholders to fill in from the board's pinout.
 *
 * It is a draft to check, not a config to run: port and device types are recognised from connector
 * labels (Driver 0, TEMP 1, OUT 3, IO_0, FAN0, HE0, M0…) and from the names of what is wired to them.
 */

import type { WiringRows } from './wiringReport.js';
import { buildProjectModel } from './projectModel.js';
import { supplyOf } from './designChecks.js';

type Row = Record<string, any>;
type PortKind = 'driver' | 'temp' | 'out' | 'io' | 'fan' | 'heater';
type Device = 'motor' | 'endstop' | 'probe' | 'fan' | 'heater' | 'sensor' | 'input' | 'output' | 'unknown';

/** Port of a connector label, e.g. "Driver 0" -> driver 0, "TEMP_1" -> temp 1, "IO_0" -> io 0. */
export function portOf(label: string): { kind: PortKind; n: number } | null {
  const l = label.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const m =
    /^(driver|drv|motor|mot|m)(\d+)$/.exec(l) ??
    /^(temp|th|tb)(\d+)$/.exec(l) ??
    /^(out|o)(\d+)$/.exec(l) ??
    /^(io|gpio)(\d+)$/.exec(l) ??
    /^(fan|fn)(\d+)$/.exec(l) ??
    /^(he|heater|hb|bed)(\d*)$/.exec(l);
  if (!m) return null;
  const k = m[1];
  const n = m[2] === '' ? 0 : Number(m[2]);
  if (['driver', 'drv', 'motor', 'mot', 'm'].includes(k)) return { kind: 'driver', n };
  if (['temp', 'th', 'tb'].includes(k)) return { kind: 'temp', n };
  if (['out', 'o'].includes(k)) return { kind: 'out', n };
  if (['io', 'gpio'].includes(k)) return { kind: 'io', n };
  if (['fan', 'fn'].includes(k)) return { kind: 'fan', n };
  return { kind: 'heater', n };
}

/** What kind of device a name describes, e.g. "X endstop" -> endstop. */
export function deviceOf(name: string): Device {
  const n = name.toLowerCase();
  if (/endstop|end stop|limit|homing|switch/.test(n)) return 'endstop';
  if (/probe|bltouch|cr-?touch|klicky|inductive/.test(n)) return 'probe';
  if (/thermistor|pt100|pt1000|ntc|temp(erature)? sensor|thermocouple/.test(n)) return 'sensor';
  if (/fan|blower/.test(n)) return 'fan';
  if (/heat|cartridge|peltier|\bbed\b|hotend|silicone/.test(n)) return 'heater';
  if (/motor|nema|stepper/.test(n)) return 'motor';
  if (/light barrier|sensor|button|door|detect/.test(n)) return 'input';
  if (/led|light|relay|valve|solenoid|buzzer|pump|laser/.test(n)) return 'output';
  return 'unknown';
}

/**
 * What a device can be on a kind of port: a driver port drives a motor, a temp port reads a sensor,
 * an IO port reads an input (or drives a small output), an OUT/FAN/heater port switches power.
 * E.g. an endstop wired to an OUT port is being powered from it, so it counts as an output there.
 */
export function fitPort(device: Device, kind: PortKind): Device {
  switch (kind) {
    case 'driver':
      return 'motor';
    case 'temp':
      return 'sensor';
    case 'io':
      if (device === 'endstop' || device === 'probe' || device === 'input') return device;
      return device === 'heater' || device === 'fan' || device === 'output' ? 'output' : 'input';
    case 'fan':
      return 'fan';
    default:
      return device === 'fan' || device === 'heater' || device === 'output' ? device : kind === 'heater' ? 'heater' : 'output';
  }
}

/** Axis from a name: "X motor", "Y-axis left", "Printbed - Motor Z" -> X / Y / Z. */
export function axisOf(name: string): string | null {
  const m = /(?:^|[^a-z])([xyzuvwabc])(?:[\s_-]*axis)?(?:[^a-z]|$)/i.exec(name.replace(/\bmotor\b|\bnema\s*\d*\b|\bendstop\b/gi, ' '));
  return m ? m[1].toUpperCase() : null;
}

const CONTROLLER = /duet|octopus|skr|spider|manta|ebb|toolboard|\b1lc\b|\b3hc\b|\b6hc\b|\b6xd\b|mini ?5|mainboard|controller/i;

interface Use {
  board: string;
  address: string;
  connector: string;
  port: { kind: PortKind; n: number };
  /** What is wired to the port: the far components / connectors. */
  far: string[];
  device: Device;
  axis: string | null;
  connection: string;
}

export function firmwareConfig(rows: WiringRows, projectId: string, format: 'rrf' | 'klipper'): string | null {
  const m = buildProjectModel(rows, projectId);
  if (!m) return null;
  const isController = (pp: Row) => !!String(pp.fwAddress ?? '').trim() || CONTROLLER.test(`${m.placementName(pp)} ${m.pcbById.get(pp.pcbId)?.name ?? ''}`);

  const uses: Use[] = [];
  const seen = new Set<string>();
  for (const pp of m.placements.filter(isController)) {
    for (const pc of [...m.pcbConnById.values()].filter((c) => c.pcbId === pp.pcbId)) {
      const port = portOf(String(pc.label ?? '')) ?? portOf(String(pc.name ?? ''));
      if (!port) continue;
      // Wires on this connector of this placement, and what their nets reach.
      const nodes = m.nodes.filter((n) => n.projectPcbId === pp.id && n.pcbConnectorId === pc.id);
      // What is on the far end of the port's signal pins. Supply and ground nets (GND, 24V…) are
      // shared by many devices, so they only count when the port has nothing else.
      const signalFar = new Set<string>();
      const supplyFar = new Set<string>();
      let connection = '';
      for (const n of nodes) {
        for (const w of m.wires.filter((x) => x.from.nodeId === n.id || x.to.nodeId === n.id)) {
          connection ||= w.connectionName;
          const here = w.from.nodeId === n.id ? w.from : w.to;
          const net = m.netOf(w.from.nodeId, w.from.pin);
          const isSupply = !!supplyOf(here.pinName) || (net?.names ?? []).some((x) => supplyOf(x)) || ['power', 'ground', 'shield'].includes(here.pinRole);
          for (const e of net?.ends ?? []) {
            if (e.inline || e.placementId === pp.id) continue;
            (isSupply ? supplyFar : signalFar).add(`${e.placementName}${e.connectorPurpose ? ` (${e.connectorPurpose})` : ''}`);
          }
        }
      }
      const far = signalFar.size ? signalFar : supplyFar;
      if (!far.size) continue;
      const key = `${pp.id}|${pc.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const farText = [...far];
      const desc = `${farText.join(' ')} ${pc.name ?? ''}`;
      let device = deviceOf(desc);
      device = fitPort(device, port.kind);
      uses.push({
        board: m.placementName(pp),
        address: String(pp.fwAddress ?? '').trim(),
        connector: m.connectorName(pc),
        port,
        far: farText,
        device,
        axis: device === 'motor' || device === 'endstop' ? axisOf(desc) : null,
        connection,
      });
    }
  }
  const sortKey = (u: Use) => `${u.address.padStart(3, '0')}|${u.board}|${u.port.kind}|${String(u.port.n).padStart(3, '0')}`;
  uses.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const date = new Date().toISOString().slice(0, 10);
  const header = (comment: string) => [
    `${comment} DRAFT ${format === 'rrf' ? 'RepRapFirmware config.g' : 'Klipper printer.cfg'} for "${m.project.name}", generated by Wire-Node on ${date}.`,
    `${comment} Generated from the wiring: check every line against your board's documentation before use.`,
    `${comment} Ports are recognised from connector labels, devices from the names of what is wired to them.`,
    '',
  ];
  if (!uses.length) {
    return [
      ...header(format === 'rrf' ? ';' : '#'),
      `${format === 'rrf' ? ';' : '#'} No controller ports found. Name controller connectors like "Driver 0", "TEMP 1", "OUT 3", "IO_0" (Duet) or "M0", "HE0", "FAN0", "T0" (Klipper boards),`,
      `${format === 'rrf' ? ';' : '#'} and set the board address of CAN boards on the component placement.`,
    ].join('\n');
  }
  // Several boards without an address all look like the main board, and their port names clash.
  const unaddressed = [...new Set(uses.filter((u) => !u.address).map((u) => u.board))];
  const c = format === 'rrf' ? ';' : '#';
  const warn =
    unaddressed.length > 1
      ? [
          `${c} WARNING: ${unaddressed.length} boards have no address (${unaddressed.join(', ')}).`,
          `${c} Set the CAN address${format === 'klipper' ? ' / MCU name' : ''} of each extra board in Wire-Node (Build → Firmware), or their ports below clash.`,
          '',
        ]
      : [];
  return format === 'rrf' ? rrf(uses, [...header(c), ...warn]) : klipper(uses, [...header(c), ...warn]);
}

function rrf(uses: Use[], out: string[]): string {
  const pre = (u: Use) => (u.address && u.address !== '0' ? `${u.address}.` : '');
  const portName = (u: Use) => {
    const p = pre(u);
    switch (u.port.kind) {
      case 'temp':
        return `${p}temp${u.port.n}`;
      case 'io':
        return `${p}io${u.port.n}.${u.device === 'output' ? 'out' : 'in'}`;
      case 'fan':
        return `${p}fan${u.port.n}`;
      case 'heater':
        return `${p}out${u.port.n}`;
      default:
        return `${p}out${u.port.n}`;
    }
  };
  const what = (u: Use) => `${u.far.join(', ')} — ${u.board} ${u.connector}${u.connection ? `, connection "${u.connection}"` : ''}`;
  const q = (s: string) => s.replace(/"/g, "'");

  out.push('; ---------- Ports used (board › connector → device) ----------');
  for (const u of uses) out.push(`; ${u.board} [${u.address || 'main'}] › ${u.connector} (${u.port.kind} ${u.port.n}) → ${u.far.join(', ')}`);
  out.push('');

  const motors = uses.filter((u) => u.device === 'motor' && u.port.kind === 'driver');
  if (motors.length) {
    out.push('; ---------- Drives ----------');
    const byAxis = new Map<string, string[]>();
    for (const u of motors) {
      const drive = `${u.address || '0'}.${u.port.n}`;
      out.push(`; drive ${drive}: ${what(u)}`);
      if (u.axis) byAxis.set(u.axis, [...(byAxis.get(u.axis) ?? []), drive]);
    }
    if (byAxis.size) out.push(`M584 ${[...byAxis.entries()].map(([a, d]) => `${a}${d.join(':')}`).join(' ')} ; axis to drive mapping (check axes)`);
    const unassigned = motors.filter((u) => !u.axis);
    if (unassigned.length) out.push(`; Not recognised as an axis: ${unassigned.map((u) => `${u.address || '0'}.${u.port.n}`).join(', ')} — add them to M584 by hand`);
    out.push('');
  }

  const endstops = uses.filter((u) => u.device === 'endstop' || u.device === 'probe');
  if (endstops.length) {
    out.push('; ---------- Endstops and probes ----------');
    for (const u of endstops) {
      const port = `${pre(u)}io${u.port.n}.in`;
      if (u.device === 'probe') out.push(`M558 P8 C"${port}" H5 F120 T6000 ; probe: ${what(u)} (check type P)`);
      else if (u.axis) out.push(`M574 ${u.axis}1 S1 P"${port}" ; ${what(u)} (check low/high end)`);
      else out.push(`; M574 ?1 S1 P"${port}" ; ${what(u)} — axis not recognised`);
    }
    out.push('');
  }

  const sensors = uses.filter((u) => u.device === 'sensor');
  const heaters = uses.filter((u) => u.device === 'heater');
  if (sensors.length || heaters.length) {
    out.push('; ---------- Temperature sensors and heaters ----------');
    sensors.forEach((u, i) => out.push(`M308 S${i} P"${pre(u)}temp${u.port.n}" Y"thermistor" T100000 B4138 A"${q(u.far[0] ?? 'sensor')}" ; ${what(u)} (check T and B)`));
    heaters.forEach((u, i) => out.push(`M950 H${i} C"${portName(u)}" T${i < sensors.length ? i : '?'} ; ${what(u)} (check which sensor T it uses)`));
    out.push('');
  }

  const fans = uses.filter((u) => u.device === 'fan');
  if (fans.length) {
    out.push('; ---------- Fans ----------');
    fans.forEach((u, i) => {
      out.push(`M950 F${i} C"${portName(u)}" Q500 ; ${what(u)}`);
      out.push(`M106 P${i} C"${q(u.far[0] ?? `Fan ${i}`)}" S0 H-1`);
    });
    out.push('');
  }

  const inputs = uses.filter((u) => u.device === 'input');
  const outputs = uses.filter((u) => u.device === 'output');
  if (inputs.length || outputs.length) {
    out.push('; ---------- Other inputs and outputs ----------');
    inputs.forEach((u, i) => out.push(`M950 J${i} C"${pre(u)}io${u.port.n}.in" ; ${what(u)}`));
    outputs.forEach((u, i) => out.push(`M950 P${i} C"${portName(u)}" ; ${what(u)}`));
    out.push('');
  }
  return out.join('\n');
}

function klipper(uses: Use[], out: string[]): string {
  const where = (u: Use) => `${u.board} ${u.connector}${u.connection ? ` (connection "${u.connection}")` : ''}`;
  const mcu = (u: Use) => (u.address ? `${u.address}:` : '');
  const ph = (u: Use, what: string) => `${mcu(u)}<${u.connector} ${what}>`;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item';

  out.push('# Pins are placeholders like <M0 STEP>: replace them with the MCU pins from your board pinout.');
  out.push('# Set the placement "board address" to the Klipper MCU name (e.g. "ebb") for boards other than the main MCU.');
  out.push('');
  out.push('# ---------- Ports used (board › connector → device) ----------');
  for (const u of uses) out.push(`# ${u.board} › ${u.connector} (${u.port.kind} ${u.port.n}) → ${u.far.join(', ')}`);
  out.push('');

  const used = new Set<string>();
  const name = (base: string) => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}${i}`;
    used.add(n);
    return n;
  };
  for (const u of uses) {
    const label = u.far.join(', ');
    switch (u.device) {
      case 'motor':
        out.push(`[${u.axis ? `stepper_${u.axis.toLowerCase()}` : name(`manual_stepper ${slug(label)}`)}]`, `# ${label} — ${where(u)}`);
        out.push(`step_pin: ${ph(u, 'STEP')}`, `dir_pin: ${ph(u, 'DIR')}`, `enable_pin: !${ph(u, 'EN')}`, '');
        break;
      case 'endstop':
        out.push(`# ${label} — ${where(u)}`, `# endstop_pin: ^${ph(u, 'signal')}${u.axis ? `   (in [stepper_${u.axis.toLowerCase()}])` : ''}`, '');
        break;
      case 'probe':
        out.push('[probe]', `# ${label} — ${where(u)}`, `pin: ^${ph(u, 'signal')}`, '');
        break;
      case 'sensor':
        out.push(`[${name(`temperature_sensor ${slug(label)}`)}]`, `# ${label} — ${where(u)}`, 'sensor_type: Generic 3950', `sensor_pin: ${ph(u, 'signal')}`, '');
        break;
      case 'heater':
        out.push(`[${name(`heater_generic ${slug(label)}`)}]`, `# ${label} — ${where(u)}`, `heater_pin: ${ph(u, 'output')}`, 'sensor_type: Generic 3950', 'sensor_pin: <sensor pin>', 'control: pid', 'min_temp: 0', 'max_temp: 120', '');
        break;
      case 'fan':
        out.push(`[${name(`fan_generic ${slug(label)}`)}]`, `# ${label} — ${where(u)}`, `pin: ${ph(u, 'output')}`, '');
        break;
      case 'input':
        out.push(`[${name(`gcode_button ${slug(label)}`)}]`, `# ${label} — ${where(u)}`, `pin: ^${ph(u, 'signal')}`, 'press_gcode:', '');
        break;
      default:
        out.push(`[${name(`output_pin ${slug(label)}`)}]`, `# ${label} — ${where(u)}`, `pin: ${ph(u, 'output')}`, '');
    }
  }
  return out.join('\n');
}
