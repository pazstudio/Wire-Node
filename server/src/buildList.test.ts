import { describe, expect, it } from 'vitest';
import type { WiringRows } from './wiringReport.js';
import { buildBuildList } from './buildList.js';
import { ampacity, gaugeToMm2, runDesignChecks, supplyOf } from './designChecks.js';
import { buildProjectModel } from './projectModel.js';

function rows(): WiringRows {
  return {
    projects: [{ id: 'p', name: 'Printer' }],
    cables: [{ id: 'cab', name: '4x0.25 LiYY', gauge: '0.25 mm²', coreCount: 4, cores: [{ color: 'black' }, { color: 'brown' }], shielded: false }],
    connectorTypes: [
      { id: 'xh2', name: 'JST-XH 2P', pinCount: 2, crimpName: 'SXH-001T' },
      { id: 'mf2', name: 'Micro-Fit 2P', pinCount: 2, crimpName: '43030' },
    ],
    pcbs: [
      { id: 'board', name: 'Board' },
      { id: 'psu', name: 'PSU' },
      { id: 'fan', name: 'Fan' },
    ],
    folders: [],
    projectPcbs: [
      { id: 'pb', projectId: 'p', pcbId: 'board', name: '' },
      { id: 'pp', projectId: 'p', pcbId: 'psu', name: '' },
      { id: 'pf', projectId: 'p', pcbId: 'fan', name: '' },
    ],
    pcbConnectors: [
      { id: 'bin', pcbId: 'board', connectorTypeId: 'mf2', label: 'PWR', name: '', pins: [{ n: 1, name: '24V', current: 8 }, { n: 2, name: 'GND' }] },
      { id: 'bfan', pcbId: 'board', connectorTypeId: 'xh2', label: 'FAN0', name: '', pins: [{ n: 1, name: '24V' }, { n: 2, name: 'GND' }] },
      { id: 'bfree', pcbId: 'board', connectorTypeId: 'xh2', label: 'FAN1', name: '', pins: [] },
      { id: 'pout', pcbId: 'psu', connectorTypeId: null, label: 'OUT', name: '', pins: [{ n: 1, name: '+24V' }, { n: 2, name: '0V' }] },
      { id: 'fj', pcbId: 'fan', connectorTypeId: 'xh2', label: 'J1', name: '', pins: [{ n: 1, name: '5V' }, { n: 2, name: 'GND' }] },
    ],
    connections: [
      { id: 'c1', projectId: 'p', name: 'Power', kind: 'direct', lengthMm: 300 },
      { id: 'c2', projectId: 'p', name: 'Fan', kind: 'direct', lengthMm: null },
    ],
    connectionNodes: [
      { id: 'n1', connectionId: 'c1', pcbConnectorId: 'pout', projectPcbId: 'pp' },
      { id: 'n2', connectionId: 'c1', pcbConnectorId: 'bin', projectPcbId: 'pb' },
      { id: 'n3', connectionId: 'c2', pcbConnectorId: 'bfan', projectPcbId: 'pb' },
      { id: 'n4', connectionId: 'c2', pcbConnectorId: null, projectPcbId: null, connectorTypeId: 'xh2', label: 'Plug', pinCount: 2 },
      { id: 'n5', connectionId: 'c2', pcbConnectorId: 'fj', projectPcbId: 'pf' },
    ],
    wires: [
      { id: 'w1', connectionId: 'c1', fromNodeId: 'n1', fromPin: 1, toNodeId: 'n2', toPin: 1, color: 'red', gauge: '22 AWG' },
      { id: 'w2', connectionId: 'c1', fromNodeId: 'n1', fromPin: 2, toNodeId: 'n2', toPin: 2, color: 'black', gauge: '1.5 mm²', lengthMm: 320 },
      { id: 'w3', connectionId: 'c2', fromNodeId: 'n3', fromPin: 1, toNodeId: 'n4', toPin: 1, cableId: 'cab', coreIndex: 1, lengthMm: 200 },
      { id: 'w4', connectionId: 'c2', fromNodeId: 'n3', fromPin: 2, toNodeId: 'n4', toPin: 2, cableId: 'cab', coreIndex: 0, lengthMm: 250 },
      { id: 'w5', connectionId: 'c2', fromNodeId: 'n4', fromPin: 1, toNodeId: 'n5', toPin: 1, color: 'red' },
      { id: 'w6', connectionId: 'c2', fromNodeId: 'n4', fromPin: 2, toNodeId: 'n5', toPin: 3, color: 'black' },
    ],
  };
}

describe('buildProjectModel', () => {
  const m = buildProjectModel(rows(), 'p')!;

  it('numbers wires by connection name and resolves gauge, color and length', () => {
    expect(m.wires.map((w) => `${w.ref}:${w.id}`)).toEqual(['W1:w3', 'W2:w4', 'W3:w5', 'W4:w6', 'W5:w1', 'W6:w2']);
    const w3 = m.wires.find((w) => w.id === 'w3')!;
    expect(w3.color).toBe('brown'); // from the cable core
    expect(w3.gauge).toBe('0.25 mm²');
    expect(m.wires.find((w) => w.id === 'w1')!.lengthMm).toBe(300); // from the connection
  });

  it('joins nets through inline connectors and across connections at a shared board pin', () => {
    const net = m.netOf('n1', 1)!;
    expect(net.names).toEqual(['+24V', '24V']);
    expect(m.netOf('n5', 1)).toBe(m.netOf('n3', 1));
    expect(m.netOf('n5', 1)!.ends.map((e) => e.short)).toEqual(['Board:FAN0.1', 'Plug.1', 'Fan:J1.1']);
  });
});

describe('buildBuildList', () => {
  const b = buildBuildList(rows(), 'p')!;

  it('groups loose wires by gauge and color and flags missing lengths', () => {
    const red = b.cutList.filter((g) => g.color === 'red');
    expect(red.map((g) => [g.gauge, g.count, g.totalMm, g.missingLength])).toEqual([
      ['22 AWG', 1, 300, 0],
      ['', 1, 0, 1],
    ]);
  });

  it('counts each cable once per connection at its longest core', () => {
    expect(b.cables).toHaveLength(1);
    expect(b.cables[0].pieces).toEqual([{ connection: 'Fan', lengthMm: 250, coresUsed: 2 }]);
  });

  it('counts housings, a pair for inline connectors, and crimps per wire end', () => {
    const find = (kind: string, name: string) => b.parts.find((p) => p.kind === kind && p.name === name)?.count;
    expect(find('housing', 'JST-XH 2P (2 pins)')).toBe(4); // board FAN0, fan J1, inline pair
    expect(find('housing', 'Micro-Fit 2P (2 pins)')).toBe(1);
    expect(find('crimp', 'SXH-001T')).toBe(2 + 2 + 4);
    expect(find('crimp', '43030')).toBe(2);
  });
});

describe('design checks', () => {
  it('reads gauges and supplies', () => {
    expect(gaugeToMm2('22 AWG')).toBe(0.33);
    expect(gaugeToMm2('AWG18')).toBe(0.82);
    expect(gaugeToMm2('0,5 mm²')).toBe(0.5);
    expect(gaugeToMm2('thick')).toBeNull();
    expect(ampacity(0.5)).toBe(6);
    expect(supplyOf('+24V')).toBe('24V');
    expect(supplyOf('3V3')).toBe('3.3V');
    expect(supplyOf('0V')).toBe('GND');
    expect(supplyOf('VCC')).toBeNull();
  });

  const r = runDesignChecks(rows(), 'p')!;
  const codes = r.issues.map((i) => i.code);

  it('finds a short between two supplies', () => {
    const short = r.issues.find((i) => i.code === 'supply-short')!;
    expect(short.severity).toBe('error');
    expect(short.title).toContain('24V and 5V');
    // Linked to the connection the shorted net runs through.
    expect(short.connections!.map((c) => c.name)).toEqual(['Fan']);
    const twice = r.issues.find((i) => i.code === 'pin-in-several-connections');
    expect(twice?.connections ?? []).toEqual(twice ? expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]) : []);
  });

  it('finds a pin the connector does not have and a wire too thin for its current', () => {
    expect(codes).toContain('pin-out-of-range');
    const thin = r.issues.find((i) => i.code === 'gauge-too-thin')!;
    expect(thin.title).toMatch(/^W5 \(22 AWG/);
  });

  it('lists free connectors and incomplete wires', () => {
    expect(r.issues.find((i) => i.code === 'free-connectors')!.items).toEqual(['FAN1']);
    expect(r.issues.find((i) => i.code === 'incomplete-wires' && i.connectionId === 'c2')!.items).toEqual([
      'Missing gauge (W3, W4)',
      'Missing length (W3, W4)',
    ]);
    expect(r.counts.error).toBeGreaterThan(0);
  });
});
