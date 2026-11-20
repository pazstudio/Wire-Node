import { describe, expect, it } from 'vitest';
import type { WiringRows } from './wiringReport.js';
import { axisOf, deviceOf, firmwareConfig, fitPort, portOf } from './firmwareExport.js';
import { runDesignChecks } from './designChecks.js';

describe('recognising ports and devices', () => {
  it('reads connector labels', () => {
    expect(portOf('Driver 0')).toEqual({ kind: 'driver', n: 0 });
    expect(portOf('TEMP_1')).toEqual({ kind: 'temp', n: 1 });
    expect(portOf('IO_0')).toEqual({ kind: 'io', n: 0 });
    expect(portOf('OUT 3')).toEqual({ kind: 'out', n: 3 });
    expect(portOf('M2')).toEqual({ kind: 'driver', n: 2 });
    expect(portOf('HE0')).toEqual({ kind: 'heater', n: 0 });
    expect(portOf('CAN BUS')).toBeNull();
  });
  it('reads device names and axes', () => {
    expect(deviceOf('Y-Axis Right Endstop')).toBe('endstop');
    expect(deviceOf('Printbed - Motor Nema17')).toBe('motor');
    expect(deviceOf('Heatsink thermistor')).toBe('sensor');
    expect(deviceOf('Cooling fan printbed')).toBe('fan');
    expect(axisOf('Y-Axis Right Endstop')).toBe('Y');
    expect(axisOf('X motor')).toBe('X');
    expect(axisOf('Door motor')).toBeNull();
  });
});

function rows(): WiringRows {
  return {
    projects: [{ id: 'p', name: 'Printer' }],
    cables: [],
    connectorTypes: [],
    pcbs: [{ id: 'duet', name: 'Duet 3HC' }, { id: 'mot', name: 'Nema17' }, { id: 'es', name: 'Endstop' }, { id: 'th', name: 'Thermistor' }],
    folders: [],
    projectPcbs: [
      { id: 'pd', projectId: 'p', pcbId: 'duet', name: 'Duet 3HC', fwAddress: '1' },
      { id: 'pm', projectId: 'p', pcbId: 'mot', name: 'X motor' },
      { id: 'pe', projectId: 'p', pcbId: 'es', name: 'X endstop' },
      { id: 'pt', projectId: 'p', pcbId: 'th', name: 'Bed thermistor' },
    ],
    pcbConnectors: [
      { id: 'd2', pcbId: 'duet', label: 'Driver 2', pins: [{ n: 1 }, { n: 2 }] },
      { id: 'io0', pcbId: 'duet', label: 'IO_0', pins: [{ n: 1, name: 'GND' }, { n: 2, name: 'IN' }] },
      { id: 't1', pcbId: 'duet', label: 'TEMP 1', pins: [{ n: 1 }, { n: 2 }] },
      { id: 'mc', pcbId: 'mot', label: 'J1', pins: [{ n: 1 }, { n: 2 }] },
      { id: 'ec', pcbId: 'es', label: 'J1', pins: [{ n: 1 }, { n: 2 }] },
      { id: 'tc', pcbId: 'th', label: 'J1', pins: [{ n: 1 }, { n: 2 }] },
    ],
    connections: [
      { id: 'c1', projectId: 'p', name: 'X motor' },
      { id: 'c2', projectId: 'p', name: 'X endstop' },
      { id: 'c3', projectId: 'p', name: 'Bed temp' },
    ],
    connectionNodes: [
      { id: 'a1', connectionId: 'c1', pcbConnectorId: 'd2', projectPcbId: 'pd' },
      { id: 'a2', connectionId: 'c1', pcbConnectorId: 'mc', projectPcbId: 'pm' },
      { id: 'b1', connectionId: 'c2', pcbConnectorId: 'io0', projectPcbId: 'pd' },
      { id: 'b2', connectionId: 'c2', pcbConnectorId: 'ec', projectPcbId: 'pe' },
      { id: 'e1', connectionId: 'c3', pcbConnectorId: 't1', projectPcbId: 'pd' },
      { id: 'e2', connectionId: 'c3', pcbConnectorId: 'tc', projectPcbId: 'pt' },
    ],
    wires: [
      { id: 'w1', connectionId: 'c1', fromNodeId: 'a1', fromPin: 1, toNodeId: 'a2', toPin: 1 },
      { id: 'w2', connectionId: 'c2', fromNodeId: 'b1', fromPin: 2, toNodeId: 'b2', toPin: 1 },
      { id: 'w3', connectionId: 'c3', fromNodeId: 'e1', fromPin: 1, toNodeId: 'e2', toPin: 1 },
    ],
  };
}

describe('fitPort', () => {
  it('keeps devices to what a port can do', () => {
    expect(fitPort('heater', 'io')).toBe('output'); // a Peltier driver switched by an IO pin
    expect(fitPort('probe', 'out')).toBe('output'); // a sensor powered from an OUT port
    expect(fitPort('endstop', 'io')).toBe('endstop');
    expect(fitPort('unknown', 'temp')).toBe('sensor');
    expect(fitPort('heater', 'out')).toBe('heater');
  });
});

describe('firmwareConfig', () => {
  it('warns when several boards have no address', () => {
    const r = rows();
    r.projectPcbs[0].fwAddress = '';
    r.pcbs.push({ id: 'duet2', name: 'Duet 6HC' });
    r.projectPcbs.push({ id: 'pd2', projectId: 'p', pcbId: 'duet2', name: 'Duet 6HC' });
    r.pcbConnectors.push({ id: 'o3', pcbId: 'duet2', label: 'OUT 3', pins: [{ n: 1 }] });
    r.connectionNodes.push(
      { id: 'f1', connectionId: 'c3', pcbConnectorId: 'o3', projectPcbId: 'pd2' },
      { id: 'f2', connectionId: 'c3', pcbConnectorId: 'tc', projectPcbId: 'pt' },
    );
    r.wires.push({ id: 'w9', connectionId: 'c3', fromNodeId: 'f1', fromPin: 1, toNodeId: 'f2', toPin: 2 });
    expect(firmwareConfig(r, 'p', 'rrf')).toContain('; WARNING: 2 boards have no address');
  });

  it('writes RepRapFirmware lines with the board address', () => {
    const cfg = firmwareConfig(rows(), 'p', 'rrf')!;
    expect(cfg).toContain('M584 X1.2 ; axis to drive mapping');
    expect(cfg).toContain('M574 X1 S1 P"1.io0.in"');
    expect(cfg).toContain('M308 S0 P"1.temp1" Y"thermistor"');
  });
  it('writes Klipper sections with pin placeholders', () => {
    const cfg = firmwareConfig(rows(), 'p', 'klipper')!;
    expect(cfg).toContain('[stepper_x]');
    expect(cfg).toContain('step_pin: 1:<Driver 2 STEP>');
    expect(cfg).toContain('[temperature_sensor bed_thermistor]');
  });
});

describe('pin roles and voltage drop', () => {
  it('finds CAN_H wired to CAN_L, joined outputs, and a long thin supply wire', () => {
    const r = rows();
    r.pcbConnectors.push(
      { id: 'can1', pcbId: 'duet', label: 'CAN', pins: [{ n: 1, name: 'CAN_H' }, { n: 2, name: '24V', current: 5 }, { n: 3, role: 'output' }] },
      { id: 'can2', pcbId: 'mot', label: 'CAN', pins: [{ n: 1, name: 'CAN_L' }, { n: 2, name: '24V' }, { n: 3, role: 'output' }] },
    );
    r.connections.push({ id: 'c4', projectId: 'p', name: 'CAN', lengthMm: 3000 });
    r.connectionNodes.push(
      { id: 'n1', connectionId: 'c4', pcbConnectorId: 'can1', projectPcbId: 'pd' },
      { id: 'n2', connectionId: 'c4', pcbConnectorId: 'can2', projectPcbId: 'pm' },
    );
    r.wires.push(
      { id: 'x1', connectionId: 'c4', fromNodeId: 'n1', fromPin: 1, toNodeId: 'n2', toPin: 1 },
      { id: 'x2', connectionId: 'c4', fromNodeId: 'n1', fromPin: 2, toNodeId: 'n2', toPin: 2, gauge: '24 AWG' },
      { id: 'x3', connectionId: 'c4', fromNodeId: 'n1', fromPin: 3, toNodeId: 'n2', toPin: 3 },
    );
    const codes = runDesignChecks(r, 'p')!.issues.map((i) => i.code);
    expect(codes).toContain('can-swapped');
    expect(codes).toContain('outputs-joined');
    const drop = runDesignChecks(r, 'p')!.issues.find((i) => i.code === 'voltage-drop')!;
    // 2 × 5 A × 0.0175 × 3 m / 0.2 mm² = 2.63 V, 10.9 % of 24 V
    expect(drop.title).toMatch(/2\.63 V \(10\.9 % of 24V\)/);
  });
});
