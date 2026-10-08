import { describe, expect, it } from 'vitest';
import { computeMapEdges } from './mapEdges.js';

describe('computeMapEdges', () => {
  const allowed = new Set(['A', 'B', 'C']);

  it('creates one edge for a direct connection', () => {
    const edges = computeMapEdges(
      [
        {
          id: 'c1',
          name: 'A-B',
          nodes: [
            { id: 'n1', pcbId: 'A' },
            { id: 'n2', pcbId: 'B' },
          ],
          wires: [
            { fromNodeId: 'n1', toNodeId: 'n2' },
            { fromNodeId: 'n1', toNodeId: 'n2' },
          ],
        },
      ],
      allowed,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'A', target: 'B', wireCount: 2 });
  });

  it('follows wires through free connectors (harness splice)', () => {
    const edges = computeMapEdges(
      [
        {
          id: 'c1',
          name: 'harness',
          nodes: [
            { id: 'n1', pcbId: 'A' },
            { id: 'splice', pcbId: null },
            { id: 'n2', pcbId: 'B' },
            { id: 'n3', pcbId: 'C' },
          ],
          wires: [
            { fromNodeId: 'n1', toNodeId: 'splice' },
            { fromNodeId: 'splice', toNodeId: 'n2' },
            { fromNodeId: 'splice', toNodeId: 'n3' },
          ],
        },
      ],
      allowed,
    );
    const pairs = edges.map((e) => `${e.source}-${e.target}`).sort();
    expect(pairs).toEqual(['A-B', 'A-C', 'B-C']);
  });

  it('ignores PCBs that are not attached to the project and connections without wires', () => {
    const edges = computeMapEdges(
      [
        {
          id: 'c1',
          name: 'x',
          nodes: [
            { id: 'n1', pcbId: 'A' },
            { id: 'n2', pcbId: 'Z' },
          ],
          wires: [{ fromNodeId: 'n1', toNodeId: 'n2' }],
        },
        { id: 'c2', name: 'empty', nodes: [{ id: 'm1', pcbId: 'A' }, { id: 'm2', pcbId: 'B' }], wires: [] },
      ],
      allowed,
    );
    expect(edges).toHaveLength(0);
  });

  it('merges multiple connections between the same pair', () => {
    const conn = (id: string) => ({
      id,
      name: id,
      nodes: [
        { id: `${id}a`, pcbId: 'B' },
        { id: `${id}b`, pcbId: 'A' },
      ],
      wires: [{ fromNodeId: `${id}a`, toNodeId: `${id}b` }],
    });
    const edges = computeMapEdges([conn('c1'), conn('c2')], allowed);
    expect(edges).toHaveLength(1);
    expect(edges[0].connections.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(edges[0].wireCount).toBe(2);
  });
});
