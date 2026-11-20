import { describe, expect, it } from 'vitest';
import type { WiringRows } from './wiringReport.js';
import { compareProjects } from './compareProjects.js';

/** Two copies of the same small project, with their own ids, as a duplicate would have. */
function rows(): WiringRows {
  const project = (p: string) => ({
    placements: [
      { id: `${p}b`, projectId: p, pcbId: 'board', name: '' },
      { id: `${p}f`, projectId: p, pcbId: 'fan', name: '' },
    ],
    connections: [{ id: `${p}c`, projectId: p, name: 'Fan cable', kind: 'direct', lengthMm: 300 }],
    nodes: [
      { id: `${p}n1`, connectionId: `${p}c`, pcbConnectorId: 'bj', projectPcbId: `${p}b` },
      { id: `${p}n2`, connectionId: `${p}c`, pcbConnectorId: 'fj', projectPcbId: `${p}f` },
    ],
    wires: [
      { id: `${p}w1`, connectionId: `${p}c`, fromNodeId: `${p}n1`, fromPin: 1, toNodeId: `${p}n2`, toPin: 1, color: 'red' },
      { id: `${p}w2`, connectionId: `${p}c`, fromNodeId: `${p}n1`, fromPin: 2, toNodeId: `${p}n2`, toPin: 2, color: 'black' },
    ],
  });
  const a = project('A');
  const b = project('B');
  return {
    projects: [{ id: 'A', name: 'Rev 1' }, { id: 'B', name: 'Rev 2' }],
    cables: [],
    connectorTypes: [],
    pcbs: [{ id: 'board', name: 'Board' }, { id: 'fan', name: 'Fan' }],
    folders: [],
    projectPcbs: [...a.placements, ...b.placements],
    pcbConnectors: [
      { id: 'bj', pcbId: 'board', label: 'FAN', pins: [{ n: 1, name: '24V' }, { n: 2, name: 'GND' }] },
      { id: 'fj', pcbId: 'fan', label: 'J1', pins: [{ n: 1 }, { n: 2 }] },
    ],
    connections: [...a.connections, ...b.connections],
    connectionNodes: [...a.nodes, ...b.nodes],
    wires: [...a.wires, ...b.wires],
  };
}

describe('compareProjects', () => {
  it('finds no differences between a project and its duplicate', () => {
    expect(compareProjects(rows(), 'A', 'B')!.total).toBe(0);
  });

  it('reports changed, added and removed wires, connections and components', () => {
    const r = rows();
    r.wires.find((w) => w.id === 'Bw1')!.color = 'orange';
    r.wires.find((w) => w.id === 'Bw2')!.toPin = 3; // moved: one removed, one added
    r.connections.push({ id: 'Bc2', projectId: 'B', name: 'New cable', kind: 'direct' });
    r.projectPcbs.push({ id: 'Bx', projectId: 'B', pcbId: 'fan', name: 'Second fan' });
    const d = compareProjects(r, 'A', 'B')!;
    expect(d.components.added).toEqual(['Second fan']);
    const fan = d.connections.find((c) => c.name === 'Fan cable')!;
    expect(fan.status).toBe('changed');
    expect(fan.lines).toEqual([
      'Wire Board:FAN.1 → Fan:J1.1: color red → orange',
      'Added wire Board:FAN.2 → Fan:J1.3 (black, 300 mm)',
      'Removed wire Board:FAN.2 → Fan:J1.2 (black, 300 mm)',
    ]);
    expect(d.connections.find((c) => c.name === 'New cable')!.status).toBe('added');
  });
});
