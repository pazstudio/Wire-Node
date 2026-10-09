import { memo } from 'react';
import {
  BaseEdge,
  Handle,
  Position,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { colorParts } from '../colors';
import { connectorDisplayName, resizePins, type ConnectionNodeDto, type ConnectorType, type PcbConnector, type Pin, type WireModel } from '../api';
import { Swatch } from './ui';

export type ConnNodeData = {
  title: string;
  subtitle: string;
  pins: Pin[];
  free: boolean;
  pcbConnectorId: string | null;
  projectPcbId: string | null;
  connectorTypeId: string | null;
  label: string;
  pinCount: number;
};
export type ConnFlowNode = Node<ConnNodeData, 'connector'>;

export type WireEdgeData = { color: string };
export type WireFlowEdge = Edge<WireEdgeData, 'wire'>;

/** A connector block with one handle per pin on each side (connect by dragging pin to pin). */
export const ConnectorNode = memo(function ConnectorNode({ data, selected }: NodeProps<ConnFlowNode>) {
  return (
    <div className={`cn ${selected ? 'cn-selected' : ''} ${data.free ? 'cn-free' : ''}`}>
      <div className="cn-head">
        <strong>{data.title}</strong>
        <small>{data.subtitle}</small>
      </div>
      {data.pins.length === 0 && <div className="cn-empty">No pins defined</div>}
      {data.pins.map((p) => (
        <div className="cn-pin" key={p.n}>
          <Handle type="source" position={Position.Left} id={`${p.n}-L`} className="pin-handle" />
          <span className="pin-num">{p.n}</span>
          <span className="pin-name">{p.name}</span>
          {p.color && <Swatch color={p.color} size={10} />}
          <Handle type="source" position={Position.Right} id={`${p.n}-R`} className="pin-handle" />
        </div>
      ))}
    </div>
  );
});

/** A wire drawn in its insulation color (with stripe for two-tone colors). */
export const WireEdge = memo(function WireEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<WireFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const parts = colorParts(data?.color);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={18}
        style={{ stroke: selected ? '#f97316' : '#334155', strokeWidth: selected ? 9 : 6 }}
      />
      <path d={path} fill="none" stroke={parts?.base ?? '#cbd5e1'} strokeWidth={4} pointerEvents="none" />
      {parts?.stripe && (
        <path d={path} fill="none" stroke={parts.stripe} strokeWidth={4} strokeDasharray="7 7" pointerEvents="none" />
      )}
    </>
  );
});

export const nodeTypes = { connector: ConnectorNode };
export const edgeTypes = { wire: WireEdge };

/** A connector drawn on a component, on one placement of that component in the project. */
export function nodeDataFromPcbConnector(c: PcbConnector, placement: { id: string | null; name: string }): ConnNodeData {
  const type = c.connectorType ?? null;
  const count = Math.max(c.pins.length, type?.pinCount ?? 0);
  return {
    title: connectorDisplayName(c) || type?.name || 'Connector',
    subtitle: [placement.name, type?.name].filter(Boolean).join(' · '),
    pins: resizePins(c.pins, count),
    free: false,
    pcbConnectorId: c.id,
    projectPcbId: placement.id,
    connectorTypeId: null,
    label: '',
    pinCount: 0,
  };
}

export function nodeDataFree(label: string, type: ConnectorType | null, pinCount: number): ConnNodeData {
  const count = type?.pinCount ?? pinCount;
  return {
    title: label || type?.name || 'Inline connector',
    subtitle: `inline${type ? ` · ${type.name}` : ''}`,
    pins: resizePins([], count),
    free: true,
    pcbConnectorId: null,
    projectPcbId: null,
    connectorTypeId: type?.id ?? null,
    label,
    pinCount: count,
  };
}

export function nodeDataFromDto(n: ConnectionNodeDto): ConnNodeData {
  if (n.pcbConnector) {
    return nodeDataFromPcbConnector(n.pcbConnector, {
      id: n.projectPcbId,
      name: n.projectPcb?.name || n.pcbConnector.pcb.name,
    });
  }
  return nodeDataFree(n.label, n.connectorType ?? null, n.pinCount);
}

export function nodesFromDtos(nodes: ConnectionNodeDto[]): ConnFlowNode[] {
  return nodes.map((n) => ({ id: n.id, type: 'connector', position: { x: n.x, y: n.y }, data: nodeDataFromDto(n) }));
}

/** Builds edges, choosing the pin handle side so wires leave toward the other connector. */
export function buildEdges(nodes: ConnFlowNode[], wires: WireModel[], selectedId?: string | null): WireFlowEdge[] {
  const centers = new Map(nodes.map((n) => [n.id, n.position.x + (n.measured?.width ?? 220) / 2]));
  const edges: WireFlowEdge[] = [];
  for (const w of wires) {
    const a = centers.get(w.fromNodeId);
    const b = centers.get(w.toNodeId);
    if (a === undefined || b === undefined) continue;
    let s: 'L' | 'R' = 'R';
    let t: 'L' | 'R' = 'L';
    if (w.fromNodeId === w.toNodeId) {
      t = 'R';
    } else if (a > b) {
      s = 'L';
      t = 'R';
    }
    edges.push({
      id: w.id,
      source: w.fromNodeId,
      target: w.toNodeId,
      sourceHandle: `${w.fromPin}-${s}`,
      targetHandle: `${w.toPin}-${t}`,
      type: 'wire',
      data: { color: w.color },
      selected: w.id === selectedId,
    });
  }
  return edges;
}

export function pinLabel(node: ConnFlowNode | undefined, pin: number) {
  if (!node) return `? pin ${pin}`;
  const p = node.data.pins.find((x) => x.n === pin);
  return `${node.data.title} · ${pin}${p?.name ? ` (${p.name})` : ''}`;
}
