import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { api, errorMessage, imgUrl, type MapData, type MapEdge, type Placement, type Zone } from '../api';
import { Loading } from '../components/ui';
import {
  boxSelectProps,
  useZoneCarry,
  ZONE_COLOR,
  ZONE_PREFIX,
  zoneFlowNode,
  ZoneNode,
  type ZoneFlowNode,
  type ZoneNodeData,
} from '../components/zones';

type PcbNodeData = { placement: Placement };
type PcbFlowNode = Node<PcbNodeData, 'pcb'>;
type MapNode = PcbFlowNode | ZoneFlowNode;

const SIDES = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left } as const;

const PcbNode = memo(function PcbNode({ data, selected }: NodeProps<PcbFlowNode>) {
  return (
    <div className={`map-pcb ${selected ? 'map-pcb-selected' : ''}`}>
      {(Object.keys(SIDES) as (keyof typeof SIDES)[]).map((k) => (
        <Handle key={k} id={k} type="source" position={SIDES[k]} className="map-handle" isConnectable={false} />
      ))}
      <img src={imgUrl(data.placement.pcb.thumbPath)} alt="" draggable={false} />
      <div className="map-pcb-name">{data.placement.name}</div>
      {data.placement.name !== data.placement.pcb.name && <div className="small muted">{data.placement.pcb.name}</div>}
      <div className="small muted">{data.placement.pcb._count?.connectors ?? 0} connectors</div>
    </div>
  );
});

const nodeTypes = { pcb: PcbNode, zone: ZoneNode };

export default function ProjectMapPage() {
  const { pid } = useParams() as { pid: string };
  const [edit, setEdit] = useState(false);
  const q = useQuery({
    queryKey: ['map', pid],
    queryFn: () => api.get<MapData>(`/api/projects/${pid}/map`),
    staleTime: 0,
    gcTime: 0,
  });
  if (!q.data) return <Loading error={q.error} />;
  return (
    <ReactFlowProvider>
      {/* Rebuilt after "Arrange by folders" reloads the map; the View/Edit mode stays. */}
      <MapEditor key={q.dataUpdatedAt} projectId={pid} data={q.data} edit={edit} setEdit={setEdit} reload={() => q.refetch()} />
    </ReactFlowProvider>
  );
}

type MapEditorProps = {
  projectId: string;
  data: MapData;
  edit: boolean;
  setEdit: (edit: boolean) => void;
  reload: () => Promise<unknown>;
};

function MapEditor({ projectId, data, edit, setEdit, reload }: MapEditorProps) {
  const navigate = useNavigate();
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [arranging, setArranging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ edge: MapEdge; x: number; y: number } | null>(null);
  /** Component or line under the mouse: its lines are highlighted and the rest of the map fades. */
  const [hover, setHover] = useState<{ node: string } | { edge: string } | null>(null);
  const [allLabels, setAllLabels] = useState(() => {
    try {
      return localStorage.getItem('map-all-labels') === '1';
    } catch {
      return false;
    }
  });
  function toggleLabels(on: boolean) {
    setAllLabels(on);
    try {
      localStorage.setItem('map-all-labels', on ? '1' : '0');
    } catch {
      /* not stored */
    }
  }

  const report = (e: unknown) => setError(`Could not save: ${errorMessage(e)}`);

  const onResized = useCallback<NonNullable<ZoneNodeData['onResized']>>((zoneId, p) => {
    api.put(`/api/zones/${zoneId}`, { x: p.x, y: p.y, w: p.width, h: p.height }).catch(report);
  }, []);

  const zoneNode = useCallback((z: Zone, editing: boolean) => zoneFlowNode(z, editing, onResized), [onResized]);

  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([
    ...data.zones.map((z) => zoneNode(z, edit)),
    ...data.placements.map(
      (p): PcbFlowNode => ({
        id: p.id,
        type: 'pcb',
        position: { x: p.mapX, y: p.mapY },
        draggable: edit,
        data: { placement: p },
      }),
    ),
  ]);
  const carry = useZoneCarry(setNodes);

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

  // What the hover highlights: the lines and the components at both ends.
  const lit = useMemo(() => {
    if (!hover) return null;
    const lines = data.edges.filter((e) => ('node' in hover ? e.source === hover.node || e.target === hover.node : e.id === hover.edge));
    return {
      lines: new Set(lines.map((e) => e.id)),
      blocks: new Set([...lines.flatMap((e) => [e.source, e.target]), ...('node' in hover ? [hover.node] : [])]),
    };
  }, [hover, data.edges]);

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
        const on = lit?.lines.has(e.id) ?? false;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: s,
          targetHandle: t,
          label: on || allLabels ? label : undefined,
          data: { edge: e },
          // Highlighted lines are drawn on top of the others and of the blocks.
          zIndex: on ? 1000 : 0,
          style: on
            ? { stroke: '#f97316', strokeWidth: 4 }
            : { stroke: '#2563eb', strokeWidth: 2.5, opacity: lit ? 0.12 : 0.7 },
          labelStyle: { fontSize: 12, fontWeight: 600 },
          labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
          labelBgPadding: [6, 3] as [number, number],
          interactionWidth: 24,
          selectable: false,
        };
      });
  }, [nodes, data.edges, lit, allLabels]);

  // Components not at the end of a highlighted line fade too.
  const shownNodes = useMemo(
    () =>
      lit
        ? nodes.map((n) => (n.type === 'pcb' ? { ...n, className: lit.blocks.has(n.id) ? 'map-lit' : 'map-dim' } : n))
        : nodes,
    [nodes, lit],
  );

  function saveNodePosition(n: Node) {
    if (n.type === 'pcb') {
      api.patch(`/api/project-pcbs/${n.id}`, { mapX: n.position.x, mapY: n.position.y }).catch(report);
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
        color: ZONE_COLOR,
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

  async function arrangeByFolders() {
    const used = new Set(data.placements.map((p) => p.folderId));
    const folders = data.folders.filter((f) => used.has(f.id));
    if (!folders.length) {
      alert('No component is in a folder yet. Put components in folders on the Components tab of the project first.');
      return;
    }
    const names = new Set(folders.map((f) => f.name.trim().toLowerCase()));
    const other = data.zones.filter((z) => !names.has(z.name.trim().toLowerCase())).length;
    const msg =
      `Arrange the map by folders?

Every component is moved: each of the ${folders.length} folder${folders.length === 1 ? '' : 's'} gets a zone ` +
      'with its components inside (a zone with the folder name is reused), components outside folders go below.' +
      (other ? `

${other} zone${other === 1 ? '' : 's'} not named after a folder ${other === 1 ? 'is' : 'are'} moved to the right of the layout.` : '');
    if (!confirm(msg)) return;
    setArranging(true);
    try {
      await api.post(`/api/projects/${projectId}/map/arrange-by-folders`, {});
      await reload();
    } catch (e) {
      report(e);
      setArranging(false);
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
        {data.project.lockedAt ? (
          <span className="badge badge-locked">🔒 Locked</span>
        ) : (
          <div className="seg">
            <button className={!edit ? 'active' : ''} onClick={() => setEdit(false)}>
              View
            </button>
            <button className={edit ? 'active' : ''} onClick={() => setEdit(true)}>
              Edit
            </button>
          </div>
        )}
        <label className="small map-labels-toggle">
          <input type="checkbox" checked={allLabels} onChange={(e) => toggleLabels(e.target.checked)} /> All line labels
        </label>
        {edit && (
          <>
            <button className="btn btn-sm" onClick={addZone}>
              + Zone
            </button>
            <button
              className="btn btn-sm"
              onClick={arrangeByFolders}
              disabled={arranging}
              title="Make a zone for each folder on the Components tab and place its components inside"
            >
              {arranging ? 'Arranging…' : 'Arrange by folders'}
            </button>
          </>
        )}
      </div>
      <p className="hint">
        {edit
          ? 'Drag component blocks to organize them; drag on empty space to select several and move them together (pan with the right mouse button or by holding Space). Add zones to group parts of the machine, or let "Arrange by folders" make one per component folder: drag a zone by its name to move it with everything inside, select it to rename, recolor or resize it.'
          : 'Point at a component to highlight its lines and what they lead to; point at a line to see which connection it is. Click a component to open it, or a line to open the connection with its cable and pin details.'}
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
            nodes={shownNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDrag={carry.onNodeDrag}
            onNodeDragStop={(e, n, dragged) => [...dragged, ...carry.onNodeDragStop(e, n, dragged)].forEach(saveNodePosition)}
            onNodeClick={(_e, n) => {
              if (!edit && n.type === 'pcb') navigate(`/projects/${projectId}/pcbs/${(n as PcbFlowNode).data.placement.pcbId}`);
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
            onNodeMouseEnter={(_e, n) => n.type === 'pcb' && setHover({ node: n.id })}
            onNodeMouseLeave={() => setHover(null)}
            onEdgeMouseEnter={(_e, ed) => setHover({ edge: ed.id })}
            onEdgeMouseLeave={() => setHover(null)}
            onNodeDragStart={(e, n, dragged) => {
              setHover(null);
              carry.onNodeDragStart(e, n, dragged);
            }}
            nodesConnectable={false}
            elevateNodesOnSelect={false}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={null}
            {...(edit ? boxSelectProps : {})}
            fitView
            minZoom={0.05}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {data.placements.length === 0 && (
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
