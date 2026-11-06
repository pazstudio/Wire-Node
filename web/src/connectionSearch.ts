import { connectorDisplayName, resizePins, type Connection, type ConnectionNodeDto, type Folder } from './api';

/** A pin that matched the search, and where its wires go. */
export interface PinHit {
  n: number;
  name: string;
  to: string[];
}

/** A connector in the connection that matched the search. */
export interface NodeHit {
  nodeId: string;
  /** e.g. "1LC Duet - Master › IO1 · syringe empty" */
  name: string;
  pins: PinHit[];
}

export interface SearchResult {
  conn: Connection;
  /** Connectors to highlight: those matching the most search words. */
  highlight: Set<string>;
  hits: NodeHit[];
  /** How many search words the best single connector matched (used for ranking). */
  best: number;
}

/** Splits a query into lowercase words; "6HC Motor" -> ["6hc", "motor"]. */
export function searchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

function nodeName(n: ConnectionNodeDto) {
  if (n.pcbConnector) {
    const placement = n.projectPcb?.name || n.pcbConnector.pcb.name;
    const connector = connectorDisplayName(n.pcbConnector) || n.pcbConnector.connectorType?.name || 'Connector';
    return `${placement} › ${connector}`;
  }
  return `${n.label || n.connectorType?.name || 'Inline connector'} (inline)`;
}

function nodePins(n: ConnectionNodeDto) {
  if (n.pcbConnector) {
    const c = n.pcbConnector;
    return resizePins(c.pins, Math.max(c.pins.length, c.connectorType?.pinCount ?? 0));
  }
  return resizePins([], n.connectorType?.pinCount ?? n.pinCount);
}

/** Text of a connector itself (not its pins) that the search looks in. */
function nodeText(n: ConnectionNodeDto) {
  const c = n.pcbConnector;
  return [
    n.label,
    n.projectPcb?.name,
    c?.pcb.name,
    c?.label,
    c?.name,
    c?.connectorType?.name,
    n.connectorType?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Connections in which every search word appears somewhere: in a connector (component, connector label or
 * purpose, connector type, pin names), the connection name or description, its folder or zones, or a wire
 * (color, note, cable). Connections where one connector matches all words come first.
 */
export function searchConnections(connections: Connection[], folders: Folder[], query: string): SearchResult[] {
  const words = searchWords(query);
  if (!words.length) return [];
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const results: SearchResult[] = [];

  for (const conn of connections) {
    const connText = [conn.name, conn.description, conn.folderId ? folderName.get(conn.folderId) : '', ...(conn.zones ?? []).map((z) => z.name)]
      .join(' ')
      .toLowerCase();
    const wireText = conn.wires
      .map((w) => [w.color, w.note, w.cable?.name].filter(Boolean).join(' '))
      .join(' ')
      .toLowerCase();

    const nodeById = new Map(conn.nodes.map((n) => [n.id, n]));
    const pinsById = new Map(conn.nodes.map((n) => [n.id, nodePins(n)]));
    const scored = conn.nodes.map((n) => {
      const text = nodeText(n);
      const pins = pinsById.get(n.id)!;
      const pinMatches = (p: { name: string }) => words.some((w) => p.name.toLowerCase().includes(w));
      const matched = words.filter((w) => text.includes(w) || pins.some((p) => p.name.toLowerCase().includes(w)));
      return { n, matched, pins: pins.filter(pinMatches) };
    });

    const covered = words.every(
      (w) => connText.includes(w) || wireText.includes(w) || scored.some((s) => s.matched.includes(w)),
    );
    if (!covered) continue;

    const best = Math.max(0, ...scored.map((s) => s.matched.length));
    const top = best ? scored.filter((s) => s.matched.length === best) : [];

    const pinName = (nodeId: string, pin: number) => {
      const p = pinsById.get(nodeId)?.find((x) => x.n === pin);
      return `pin ${pin}${p?.name ? ` ${p.name}` : ''}`;
    };
    const hits: NodeHit[] = top.map(({ n, pins }) => ({
      nodeId: n.id,
      name: nodeName(n),
      pins: pins.map((p) => ({
        n: p.n,
        name: p.name,
        to: conn.wires.flatMap((w) => {
          if (w.fromNodeId === n.id && w.fromPin === p.n) return [`${nodeName(nodeById.get(w.toNodeId)!)} ${pinName(w.toNodeId, w.toPin)}`];
          if (w.toNodeId === n.id && w.toPin === p.n) return [`${nodeName(nodeById.get(w.fromNodeId)!)} ${pinName(w.fromNodeId, w.fromPin)}`];
          return [];
        }),
      })),
    }));

    results.push({ conn, highlight: new Set(top.map((s) => s.n.id)), hits, best });
  }

  return results.sort(
    (a, b) => b.best - a.best || b.hits.length - a.hits.length || a.conn.name.localeCompare(b.conn.name, undefined, { numeric: true }),
  );
}
