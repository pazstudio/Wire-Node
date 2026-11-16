import { describe, expect, it } from 'vitest';
import { diffComponent, diffConnection, MAX_SUMMARY_LINES, type ComponentSnapshot, type ConnectionSnapshot } from './historyDiff.js';

const conn = (over: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot => ({
  name: 'Hotend harness',
  description: '',
  lengthMm: 1000,
  zones: [],
  nodes: [
    { id: 'n1', name: 'Mainboard: J3', pinCount: 2 },
    { id: 'n2', name: 'Fan: P1', pinCount: 2 },
  ],
  wires: [{ id: 'w1', from: 'Mainboard: J3 pin 1', to: 'Fan: P1 pin 1', color: 'red', cable: '', lengthMm: null, note: '' }],
  ...over,
});

describe('diffConnection', () => {
  it('reports nothing for identical snapshots', () => {
    expect(diffConnection(conn(), conn())).toEqual([]);
  });

  it('reports renames, length, connectors, wires and zones', () => {
    const after = conn({
      name: 'Hotend harness v2',
      lengthMm: 1200,
      nodes: [conn().nodes[0], { id: 'n3', name: 'Splice (free)', pinCount: 3 }],
      wires: [
        { id: 'w1', from: 'Mainboard: J3 pin 1', to: 'Fan: P1 pin 1', color: 'black', cable: '', lengthMm: 500, note: '' },
        { id: 'w2', from: 'Mainboard: J3 pin 2', to: 'Splice (free) pin 1', color: '', cable: '', lengthMm: null, note: '' },
      ],
      zones: [{ id: 'z1', name: 'Toolhead' }],
    });
    expect(diffConnection(conn(), after)).toEqual([
      'Renamed: "Hotend harness" → "Hotend harness v2"',
      'Cable length: 1000 mm → 1200 mm',
      'Added connector Splice (free)',
      'Removed connector Fan: P1',
      'Wire Mainboard: J3 pin 1 → Fan: P1 pin 1: color red → black, length not set → 500 mm',
      'Added wire Mainboard: J3 pin 2 → Splice (free) pin 1',
      'Added zone "Toolhead"',
    ]);
  });

  it('reports removed wires and rewiring', () => {
    const rewired = conn({ wires: [{ ...conn().wires[0], to: 'Fan: P1 pin 2' }] });
    expect(diffConnection(conn(), rewired)).toEqual([
      'Wire Mainboard: J3 pin 1 → Fan: P1 pin 2: rewired from Mainboard: J3 pin 1 → Fan: P1 pin 1',
    ]);
    expect(diffConnection(conn(), conn({ wires: [] }))).toEqual(['Removed wire Mainboard: J3 pin 1 → Fan: P1 pin 1']);
  });

  it('caps very long summaries', () => {
    const many = conn({
      wires: Array.from({ length: 500 }, (_, i) => ({ id: `x${i}`, from: 'a', to: 'b', color: '', cable: '', lengthMm: null, note: '' })),
    });
    const lines = diffConnection(conn({ wires: [] }), many);
    expect(lines).toHaveLength(MAX_SUMMARY_LINES);
    expect(lines.at(-1)).toBe('…and 301 more changes');
  });
});

const comp = (over: Partial<ComponentSnapshot> = {}): ComponentSnapshot => ({
  name: 'Peltier Driver',
  description: '',
  image: 'a.webp',
  connectors: [
    {
      id: 'c1',
      name: 'J1 · Power',
      type: 'XT30',
      rect: '0.1,0.1,0.2,0.2',
      pins: [
        { n: 1, name: 'VCC', color: 'red' },
        { n: 2, name: 'GND', color: 'black' },
      ],
    },
  ],
  ...over,
});

describe('diffComponent', () => {
  it('reports nothing for identical snapshots', () => {
    expect(diffComponent(comp(), comp())).toEqual([]);
  });

  it('reports picture, connector and pin changes', () => {
    const c = comp().connectors[0];
    const after = comp({
      image: 'b.webp',
      connectors: [
        { ...c, type: 'XT60', rect: '0.2,0.1,0.2,0.2', pins: [{ n: 1, name: '24V', color: 'red' }, c.pins[1]] },
        { id: 'c2', name: 'J2', type: '', rect: '0,0,0.1,0.1', pins: [] },
      ],
    });
    expect(diffComponent(comp(), after)).toEqual([
      'Picture replaced',
      'Connector J1 · Power: type "XT30" → "XT60", moved or resized, pin 1 name "VCC" → "24V"',
      'Added connector J2',
    ]);
    expect(diffComponent(comp(), comp({ connectors: [] }))).toEqual(['Removed connector J1 · Power']);
  });
});
