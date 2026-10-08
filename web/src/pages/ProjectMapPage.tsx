import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { api, errorMessage, imgUrl, type MapData, type MapEdge, type Pcb, type Zone } from '../api';
import { Loading } from '../components/ui';
import { withAlpha } from '../colors';

type ResizeParams = { x: number; y: number; width: number; height: number };
type PcbNodeData = { pcb: Pcb };
type ZoneNodeData = { zone: Zone; edit: boolean; onResized: (zoneId: string, p: ResizeParams) => void };
type PcbFlowNode = Node<PcbNodeData, 'pcb'>;
type ZoneFlowNode = Node<ZoneNodeData, 'zone'>;
type MapNode = PcbFlowNode | ZoneFlowNode;

const SIDES = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left } as const;
const ZONE_PREFIX = 'zone-';

const PcbNode = memo(function PcbNode({ data, selected }: NodeProps<PcbFlowNode>) {
  return (
    <div className={`map-pcb ${selected ? 'map-pcb-selected' : ''}`}>
      {(Object.keys(SIDES) as (keyof typeof SIDES)[]).map((k) => (
        <Handle key={k} id={k} type="source" position={SIDES[k]} className="map-handle" isConnectable={false} />
      ))}
      <img src={imgUrl(data.pcb.thumbPath)} alt="" draggable={false} />
      <div className="map-pcb-name">{data.pcb.name}</div>
      <div className="small muted">{data.pcb._count?.connectors ?? 0} connectors</div>
    </div>
  );
});

const ZoneNode = memo(function ZoneNode({ data, selected }: NodeProps<ZoneFlowNode>) {
  const { zone } = data;
  return (
    <>
      <NodeResizer
        isVisible={data.edit && selected}
        minWidth={120}
        minHeight={80}
        color={zone.color}
        onResizeEnd={(_, p) => data.onResized(zone.id, p)}
      />
      <div className="map-zone" style={{ background: withAlpha(zone.color, 0.12), borderColor: withAlpha(zone.color, 0.7) }}>
        <span className="map-zone-label" style={{ color: zone.color }}>
          {zone.name}
        </span>
      </div>
    </>
  );
});

const nodeTypes = { pcb: PcbNode, zone: ZoneNode };

export default function ProjectMapPage() {
  const { pid } = useParams() as { pid: string };
  const q = useQuery({
    queryKey: ['map', pid],
    queryFn: () => api.get<MapData>(`/api/projects/${pid}/map`),
    staleTime: 0,
    gcTime: 0,
  });
  if (!q.data) return <Loading error={q.error} />;
  return (
    <ReactFlowProvider>
      <MapEditor projectId={pid} data={q.data} />
    </ReactFlowProvider>
  );
}

function MapEditor({ projectId, data }: { projectId: string; data: MapData }) {
  const navigate = useNavigate();
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [edit, setEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ edge: MapEdge; x: number; y: number } | null>(null);

  const report = (e: unknown) => setError(`Could not save: ${errorMessage(e)}`);

  const onResized = useCallback((zoneId: string, p: ResizeParams) => {
    api.put(`/api/zones/${zoneId}`, { x: p.x, y: p.y, w: p.width, h: p.height }).catch(report);
  }, []);

  const zoneNode = useCallback(
    (z: Zone, editing: boolean): ZoneFlowNode => ({
      id: ZONE_PREFIX + z.id,
      type: 'zone',
      position: { x: z.x, y: z.y },
      width: z.w,
      height: z.h,
      zIndex: -1,
      draggable: editing,
      selectable: editing,
      className: editing ? '' : 'zone-locked',
      data: { zone: z, edit: editing, onResized },
    }),
    [onResized],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([
    ...data.zones.map((z) => zoneNode(z, false)),
    ...data.pcbs.map(
      (p): PcbFlowNode => ({
        id: p.id,
        type: 'pcb',
        position: { x: p.mapX ?? 0, y: p.mapY ?? 0 },
        draggable: false,
        data: { pcb: p },
      }),
    ),
  ]);

  // Switch between view and edit mode.
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) =>
        n.type === 'zone'
          ? { ...n, draggable: edit, selectable: edit, selected: edit ? n.selected : false, className: edit ? '' : 'zone-locked', data: { ...n.data, edit } }
          : { ...n, draggable: edit },
      ),
    );
    setPicker(null);
  }, [edit, setNodes]);

  // Edges between component blocks; handle sides follow the relative block positions.
  const edges: Edge[] = useMemo(() => {
    const centers = new Map(
      nodes
        .filter((n) => n.type === 'pcb')
        .map((n) => [
          n.id,
          { x: n.position.x + (n.measured?.width ?? 200) / 2, y: n.position.y + (n.measured?.height ?? 160) / 2 },
        ]),
    );
    return data.edges
      .filter((e) => centers.has(e.source) && centers.has(e.target))
      .map((e) => {
        const a = centers.get(e.source)!;
        const b = centers.get(e.target)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const [s, t] = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? ['r', 'l'] : ['l', 'r']) : dy >= 0 ? ['b', 't'] : ['t', 'b'];
        const label =
          e.connections.length === 1
            ? `${e.connections[0].name} · ${e.wireCount} wire${e.wireCount === 1 ? '' : 's'}`
            : `${e.connections.length} connections · ${e.wireCount} wires`;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: s,
          targetHandle: t,
          label,
          data: { edge: e },
          style: { stroke: '#2563eb', strokeWidth: 3 },
          labelStyle: { fontSize: 12, fontWeight: 600 },
          labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
          labelBgPadding: [6, 3] as [number, number],
          interactionWidth: 24,
          selectable: false,
        };
      });
  }, [nodes, data.edges]);

  function saveNodePosition(n: Node) {
    if (n.type === 'pcb') {
      api.patch(`/api/projects/${projectId}/pcbs/${n.id}`, { mapX: n.position.x, mapY: n.position.y }).catch(report);
    } else if (n.type === 'zone') {
      api.put(`/api/zones/${n.id.slice(ZONE_PREFIX.length)}`, { x: n.position.x, y: n.position.y }).catch(report);
    }
  }

  async function addZone() {
    const el = wrapRef.current;
    const r = el?.getBoundingClientRect();
    const center = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    try {
      const z = await api.post<Zone>(`/api/projects/${projectId}/zones`, {
        name: 'New zone',
        color: '#3b82f6',
        x: center.x - 200,
        y: center.y - 150,
        w: 400,
        h: 300,
      });
      setNodes((ns) => [{ ...zoneNode(z, true), selected: true }, ...ns.map((n) => ({ ...n, selected: false }))]);
    } catch (e) {
      report(e);
    }
  }

  function updateZone(zoneId: string, patch: Partial<Zone>) {
    setNodes((ns) =>
      ns.map((n) =>
        n.type === 'zone' && n.data.zone.id === zoneId ? { ...n, data: { ...n.data, zone: { ...n.data.zone, ...patch } } } : n,
      ),
    );
  }

  async function deleteZone(zoneId: string) {
    if (!confirm('Delete this zone?')) return;
    try {
      await api.del(`/api/zones/${zoneId}`);
      setNodes((ns) => ns.filter((n) => n.id !== ZONE_PREFIX + zoneId));
    } catch (e) {
      report(e);
    }
  }

  const selectedZone = nodes.find((n): n is ZoneFlowNode => n.type === 'zone' && !!n.selected)?.data.zone ?? null;

  return (
    <div className="editor-page">
      <div className="editor-toolbar">
        <div className="crumbs">
          <Link to={`/projects/${projectId}`}>{data.project.name}</Link> /
        </div>
        <h1 className="diagram-title">Project map</h1>
        <div className="seg">
          <button className={!edit ? 'active' : ''} onClick={() => setEdit(false)}>
            View
          </button>
          <button className={edit ? 'active' : ''} onClick={() => setEdit(true)}>
            Edit
          </button>
        </div>
        {edit && (
          <button className="btn btn-sm" onClick={addZone}>
            + Zone
          </button>
        )}
      </div>
      <p className="hint">
        {edit
          ? 'Drag component blocks to organize them. Add zones to group parts of the machine; select a zone to rename, recolor or resize it.'
          : 'Click a component to open it. Click a line to open the connection with its cable and pin details.'}
      </p>
      {error && (
        <p className="error">
          {error}{' '}
          <button className="btn-link" onClick={() => setError(null)}>
            dismiss
          </button>
        </p>
      )}

      <div className="editor-layout">
        <div className="flow-wrap map-wrap" ref={wrapRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={(_e, _n, dragged) => dragged.forEach(saveNodePosition)}
            onNodeClick={(_e, n) => {
              if (!edit && n.type === 'pcb') navigate(`/projects/${projectId}/pcbs/${n.id}`);
            }}
            onEdgeClick={(e, edge) => {
              const me = (edge.data as { edge: MapEdge }).edge;
              if (me.connections.length === 1) {
                navigate(`/projects/${projectId}/connections/${me.connections[0].id}`);
                return;
              }
              const r = wrapRef.current!.getBoundingClientRect();
              setPicker({ edge: me, x: e.clientX - r.left, y: e.clientY - r.top });
            }}
            onPaneClick={() => setPicker(null)}
            nodesConnectable={false}
            elevateNodesOnSelect={false}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={null}
            fitView
            minZoom={0.05}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {data.pcbs.length === 0 && (
            <div className="flow-empty">No components in this project yet. Add components on the project page first.</div>
          )}
          {picker && (
            <div className="edge-picker" style={{ left: picker.x, top: picker.y }}>
              <strong>Connections</strong>
              {picker.edge.connections.map((c) => (
                <Link key={c.id} to={`/projects/${projectId}/connections/${c.id}`}>
                  {c.name} <span className="muted small">({c.wireCount} wires)</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {edit && selectedZone && (
          <aside className="editor-side">
            <div className="panel">
              <h3>Zone</h3>
              <div className="form">
                <label>
                  Name
                  <input
                    value={selectedZone.name}
                    onChange={(e) => updateZone(selectedZone.id, { name: e.target.value })}
                    onBlur={(e) => api.put(`/api/zones/${selectedZone.id}`, { name: e.target.value }).catch(report)}
                  />
                </label>
                <label>
                  Color
                  <input
                    type="color"
                    value={selectedZone.color}
                    onChange={(e) => {
                      updateZone(selectedZone.id, { color: e.target.value });
                      api.put(`/api/zones/${selectedZone.id}`, { color: e.target.value }).catch(report);
                    }}
                  />
                </label>
                <button className="btn btn-sm btn-danger" onClick={() => deleteZone(selectedZone.id)}>
                  Delete zone
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
