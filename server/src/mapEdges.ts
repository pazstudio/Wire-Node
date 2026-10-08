export interface EdgeConnection {
  id: string;
  name: string;
  wireCount: number;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  wireCount: number;
  connections: EdgeConnection[];
}

export interface ConnectionGraph {
  id: string;
  name: string;
  /** pcbId is null for free (inline) connectors. */
  nodes: { id: string; pcbId: string | null }[];
  wires: { fromNodeId: string; toNodeId: string }[];
}

/**
 * Computes PCB-to-PCB edges for the project map.
 * Wires are followed through free (inline) connectors, so a harness
 * A -> splice -> B still produces an edge between PCB A and PCB B.
 */
export function computeMapEdges(connections: ConnectionGraph[], allowedPcbIds: Set<string>): MapEdge[] {
  const edges = new Map<string, MapEdge>();

  for (const c of connections) {
    const parent = new Map<string, string>();
    for (const n of c.nodes) parent.set(n.id, n.id);
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };

    const validWires = c.wires.filter((w) => parent.has(w.fromNodeId) && parent.has(w.toNodeId));
    for (const w of validWires) {
      const a = find(w.fromNodeId);
      const b = find(w.toNodeId);
      if (a !== b) parent.set(a, b);
    }

    const pcbsByRoot = new Map<string, Set<string>>();
    for (const n of c.nodes) {
      if (!n.pcbId || !allowedPcbIds.has(n.pcbId)) continue;
      const root = find(n.id);
      if (!pcbsByRoot.has(root)) pcbsByRoot.set(root, new Set());
      pcbsByRoot.get(root)!.add(n.pcbId);
    }
    const wiresByRoot = new Map<string, number>();
    for (const w of validWires) {
      const root = find(w.fromNodeId);
      wiresByRoot.set(root, (wiresByRoot.get(root) ?? 0) + 1);
    }

    for (const [root, pcbSet] of pcbsByRoot) {
      const pcbs = [...pcbSet].sort();
      const wireCount = wiresByRoot.get(root) ?? 0;
      if (wireCount === 0) continue;
      for (let i = 0; i < pcbs.length; i++) {
        for (let j = i + 1; j < pcbs.length; j++) {
          const key = `${pcbs[i]}__${pcbs[j]}`;
          let edge = edges.get(key);
          if (!edge) {
            edge = { id: key, source: pcbs[i], target: pcbs[j], wireCount: 0, connections: [] };
            edges.set(key, edge);
          }
          let entry = edge.connections.find((e) => e.id === c.id);
          if (!entry) {
            entry = { id: c.id, name: c.name, wireCount: 0 };
            edge.connections.push(entry);
          }
          entry.wireCount += wireCount;
          edge.wireCount += wireCount;
        }
      }
    }
  }

  return [...edges.values()];
}
