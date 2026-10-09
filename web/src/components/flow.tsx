import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
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
import {
  connectorDisplayName,
  imgUrl,
  resizePins,
  type ConnectionNodeDto,
  type ConnectorType,
  type PcbConnector,
  type Pin,
  type WireModel,
} from '../api';
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
  preview: NodePreview | null;
};
export type ConnFlowNode = Node<ConnNodeData, 'connector'>;

export type WireEdgeData = { color: string };
export type WireFlowEdge = Edge<WireEdgeData, 'wire'>;

/** Picture shown when hovering a connector node: the component photo with the connector highlighted. */
export type NodePreview = {
  image: string;
  /** Natural picture size; 0 when unknown. */
  width: number;
  height: number;
  /** Where the connector is on the picture (0..1), or null to show the picture only. */
  rect: { x: number; y: number; w: number; h: number } | null;
  caption: string;
};

const PREVIEW_DELAY_MS = 350;
const PREVIEW_MAX_W = 320;
const PREVIEW_MAX_H = 240;

/** Opens the preview after the pointer rests on the node; closes on leave, press, scroll or zoom. */
function useHoverPreview(enabled: boolean) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number>();
  const close = () => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const onWheel = () => setAnchor(null);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, [anchor]);
  if (!enabled) return { anchor: null, handlers: {} };
  return {
    anchor,
    handlers: {
      onMouseEnter: (e: MouseEvent<HTMLDivElement>) => {
        if (e.buttons) return; // dragging a wire or the canvas across this node
        const el = e.currentTarget;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setAnchor(el.getBoundingClientRect()), PREVIEW_DELAY_MS);
      },
      onMouseLeave: close,
      onMouseDown: close,
    },
  };
}

function PreviewPopup({ preview, anchor }: { preview: NodePreview; anchor: DOMRect }) {
  const known = preview.width > 0 && preview.height > 0;
  const scale = known ? Math.min(PREVIEW_MAX_W / preview.width, PREVIEW_MAX_H / preview.height) : 1;
  const boxW = known ? Math.round(preview.width * scale) : PREVIEW_MAX_W;
  const boxH = known ? Math.round(preview.height * scale) : PREVIEW_MAX_H;
  const popW = boxW + 16;
  const popH = boxH + 48;
  let left = anchor.right + 12;
  if (left + popW > window.innerWidth - 8) left = anchor.left - 12 - popW;
  left = Math.max(8, left);
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - popH - 8));
  const r = preview.rect;
  return createPortal(
    <div className="node-preview no-print" style={{ left, top, width: popW }} role="tooltip">
      {known ? (
        <div className="node-preview-img" style={{ width: boxW, height: boxH }}>
          <img src={preview.image} alt="" />
          {r && (
            <div
              className="node-preview-hl"
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            />
          )}
        </div>
      ) : (
        <img className="node-preview-plain" src={preview.image} alt="" />
      )}
      <div className="node-preview-caption">{preview.caption}</div>
    </div>,
    document.body,
  );
}

/** A connector block with one handle per pin on each side (connect by dragging pin to pin). */
export const ConnectorNode = memo(function ConnectorNode({ data, selected }: NodeProps<ConnFlowNode>) {
  const hover = useHoverPreview(!!data.preview);
  return (
    <div className={`cn ${selected ? 'cn-selected' : ''} ${data.free ? 'cn-free' : ''}`} {...hover.handlers}>
      {hover.anchor && data.preview && <PreviewPopup preview={data.preview} anchor={hover.anchor} />}
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
  const title = connectorDisplayName(c) || type?.name || 'Connector';
  return {
    title,
    subtitle: [placement.name, type?.name].filter(Boolean).join(' · '),
    pins: resizePins(c.pins, count),
    free: false,
    pcbConnectorId: c.id,
    projectPcbId: placement.id,
    connectorTypeId: null,
    label: '',
    pinCount: 0,
    preview: c.pcb
      ? {
          image: imgUrl(c.pcb.thumbPath),
          width: c.pcb.imageWidth,
          height: c.pcb.imageHeight,
          rect: { x: c.x, y: c.y, w: c.w, h: c.h },
          caption: `${placement.name} · ${title}`,
        }
      : null,
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
    preview: type?.thumbPath ? { image: imgUrl(type.thumbPath), width: 0, height: 0, rect: null, caption: type.name } : null,
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
