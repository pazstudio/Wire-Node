import { memo, useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { NodeResizer, useReactFlow, type Node, type NodeProps, type XYPosition } from '@xyflow/react';
import type { ZoneShape } from '../api';
import { withAlpha } from '../colors';

type ResizeParams = { x: number; y: number; width: number; height: number };
export type ZoneNodeData = { zone: ZoneShape; edit: boolean; onResized?: (zoneId: string, p: ResizeParams) => void };
export type ZoneFlowNode = Node<ZoneNodeData, 'zone'>;

export const ZONE_PREFIX = 'zone-';
export const ZONE_COLOR = '#3b82f6';

/**
 * Semi-transparent rectangle that groups blocks by machine part (e.g. "Frame", "Toolhead").
 * It is grabbed by its label: the inside lets clicks through, so a selection box can start there.
 */
export const ZoneNode = memo(function ZoneNode({ data, selected }: NodeProps<ZoneFlowNode>) {
  const { zone } = data;
  return (
    <>
      <NodeResizer
        isVisible={data.edit && selected}
        minWidth={120}
        minHeight={80}
        color={zone.color}
        onResizeEnd={(_, p) => data.onResized?.(zone.id, p)}
      />
      <div
        className={`map-zone ${selected ? 'map-zone-selected' : ''}`}
        style={{ background: withAlpha(zone.color, 0.12), borderColor: withAlpha(zone.color, 0.7) }}
      >
        <span className="map-zone-label" style={{ color: zone.color }} title={data.edit ? 'Drag to move the zone and what is in it' : undefined}>
          {zone.name}
        </span>
      </div>
    </>
  );
});

export function zoneFlowNode(z: ZoneShape, edit: boolean, onResized?: ZoneNodeData['onResized']): ZoneFlowNode {
  return {
    id: ZONE_PREFIX + z.id,
    type: 'zone',
    position: { x: z.x, y: z.y },
    width: z.w,
    height: z.h,
    zIndex: -1,
    draggable: edit,
    selectable: edit,
    className: edit ? '' : 'zone-locked',
    data: { zone: z, edit, onResized },
  };
}

/** The zone as stored: name and color from the data, position and size from the node. */
export function zoneFromNode(n: ZoneFlowNode): ZoneShape {
  return {
    ...n.data.zone,
    x: n.position.x,
    y: n.position.y,
    w: n.width ?? n.measured?.width ?? n.data.zone.w,
    h: n.height ?? n.measured?.height ?? n.data.zone.h,
  };
}

type Rect = { x: number; y: number; w: number; h: number };

function rectOf(n: Node): Rect {
  return { x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? 0, h: n.measured?.height ?? n.height ?? 0 };
}

const containsPoint = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** A block belongs to a zone when its center is inside; a zone when it lies wholly inside. */
function inZone(zone: Rect, n: Node) {
  const r = rectOf(n);
  if (n.type === 'zone') return containsPoint(zone, r.x, r.y) && containsPoint(zone, r.x + r.w, r.y + r.h);
  return containsPoint(zone, r.x + r.w / 2, r.y + r.h / 2);
}

/** Smallest zone around the given nodes, with room for the label. */
export function zoneAround(nodes: Node[], pad = 40): Rect | null {
  if (!nodes.length) return null;
  const rs = nodes.map(rectOf);
  const x = Math.min(...rs.map((r) => r.x)) - pad;
  const y = Math.min(...rs.map((r) => r.y)) - pad - 24;
  const right = Math.max(...rs.map((r) => r.x + r.w)) + pad;
  const bottom = Math.max(...rs.map((r) => r.y + r.h)) + pad;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Dragging a zone moves the blocks (and smaller zones) inside it along with it.
 * Pass the handlers to React Flow; `onNodeDragStop` returns the nodes that were carried
 * (with their new positions) so the caller can save them.
 */
export function useZoneCarry<N extends Node>(setNodes: Dispatch<SetStateAction<N[]>>) {
  const rf = useReactFlow();
  const carry = useRef<{ refId: string; start: XYPosition; items: Map<string, XYPosition> } | null>(null);

  const onNodeDragStart = useCallback(
    (_e: unknown, _n: Node, dragged: Node[]) => {
      carry.current = null;
      const zones = dragged.filter((n) => n.type === 'zone');
      if (!zones.length) return;
      const moving = new Set(dragged.map((n) => n.id));
      const items = new Map<string, XYPosition>();
      for (const n of rf.getNodes()) {
        if (!moving.has(n.id) && zones.some((z) => inZone(rectOf(z), n))) items.set(n.id, { ...n.position });
      }
      if (items.size) carry.current = { refId: zones[0].id, start: { ...zones[0].position }, items };
    },
    [rf],
  );

  /** Moves the carried nodes by as much as the dragged zone moved; returns them with their new positions. */
  const move = useCallback(
    (dragged: Node[]): N[] => {
      const c = carry.current;
      const ref = c && dragged.find((n) => n.id === c.refId);
      if (!c || !ref) return [];
      const dx = ref.position.x - c.start.x;
      const dy = ref.position.y - c.start.y;
      const at = (n: N): N => {
        const s = c.items.get(n.id)!;
        return { ...n, position: { x: s.x + dx, y: s.y + dy } };
      };
      setNodes((ns) => ns.map((n) => (c.items.has(n.id) ? at(n) : n)));
      return (rf.getNodes() as N[]).filter((n) => c.items.has(n.id)).map(at);
    },
    [rf, setNodes],
  );

  const onNodeDrag = useCallback((_e: unknown, _n: Node, dragged: Node[]) => void move(dragged), [move]);

  const onNodeDragStop = useCallback(
    (_e: unknown, _n: Node, dragged: Node[]) => {
      const moved = move(dragged);
      carry.current = null;
      return moved;
    },
    [move],
  );

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}

/**
 * Left-drag on empty canvas draws a selection box; the right or middle mouse button
 * (or holding Space) pans. Ctrl/Cmd-click or Shift-click adds to the selection.
 */
export const boxSelectProps: { selectionOnDrag: boolean; panOnDrag: number[] } = { selectionOnDrag: true, panOnDrag: [1, 2] };
