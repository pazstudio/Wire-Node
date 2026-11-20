import { describe, expect, it } from 'vitest';
import { normalizeColor, parseCsv, planImport, type ImportContext } from './csvImport.js';

const ctx: ImportContext = {
  placements: [
    { id: 'pb', name: 'Main board', pcbId: 'board' },
    { id: 'pf', name: 'Fan', pcbId: 'fan' },
  ],
  connectors: [
    { id: 'fan0', pcbId: 'board', label: 'FAN0', name: 'Part fan', pins: [{ n: 1, name: '24V' }, { n: 2, name: 'GND' }], pinCount: 2 },
    { id: 'j1', pcbId: 'fan', label: 'J1', name: '', pins: [], pinCount: 2 },
  ],
  connections: [],
};

describe('parseCsv', () => {
  it('reads quotes, semicolons and a BOM', () => {
    expect(parseCsv('﻿a;b\r\n"x;1";"say ""hi"""\n')).toEqual([['a', 'b'], ['x;1', 'say "hi"']]);
  });
  it('normalizes colors', () => {
    expect(normalizeColor('Red')).toBe('red');
    expect(normalizeColor('GN-YE')).toBe('green/yellow');
    expect(normalizeColor('Gray / White')).toBe('grey/white');
    expect(normalizeColor('teal')).toBe('teal');
  });
});

describe('planImport', () => {
  const csv = [
    'Connection,From component,From connector,From pin,To component,To connector,To pin,Color,Gauge,Length',
    'Fan cable,Main board,FAN0,24V,Fan,J1,1,Red,22 AWG,450',
    'Fan cable,main board,Part fan,2,Fan,J1,2,black,,450 mm',
    'Fan cable,,Splice,1,Fan,J1,1,red,,',
    'Fan cable,Main board,FAN0,5,Fan,J1,2,,,',
    'Fan cable,Nope,X,1,Fan,J1,1,,,',
  ].join('\n');
  const plan = planImport(csv, ctx);

  it('matches components, connectors and pins by name or number', () => {
    expect(plan.connections).toHaveLength(1);
    const c = plan.connections[0];
    expect(c.existingId).toBeNull();
    expect(c.newWires).toBe(3);
    expect(c.nodes.map((n) => n.pcbConnectorId ?? n.label)).toEqual(['fan0', 'j1', 'Splice']);
    expect(c.wires[0]).toMatchObject({ fromPin: 1, toPin: 1, color: 'red', gauge: '22 AWG', lengthMm: 450 });
    expect(c.wires[1].lengthMm).toBe(450);
  });

  it('reports rows it cannot place', () => {
    expect(plan.errors).toEqual(['Row 5: Main board FAN0 has no pin 5 (it has 2)', 'Row 6: no component "Nope" in this project']);
  });

  it('adds to an existing connection without duplicating its wires', () => {
    const c = plan.connections[0];
    const again = planImport(csv, { ...ctx, connections: [{ id: 'c1', name: 'FAN CABLE', nodes: c.nodes, wires: c.wires }] });
    expect(again.connections).toHaveLength(0);
  });

  it('needs the key columns', () => {
    expect(planImport('Connection,Color\nx,red', ctx).errors[0]).toMatch(/^Missing column\(s\): from connector, from pin/);
  });
});
