import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  ConnectionMode,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection as FlowConnection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import {
  api,
  errorMessage,
  imgUrl,
  uuid,
  type Cable,
  type Connection,
  type ConnectorType,
  type Placement,
  type ProjectConnector,
  type WireModel,
  type ZoneShape,
  parseLength,
} from '../api';
import {
  buildEdges,
  edgeTypes,
  nodeDataFree,
  nodeDataFromPcbConnector,
  nodesFromDtos,
  nodeTypes,
  pinLabel,
  type ConnFlowNode,
} from '../components/flow';
import { useProject } from '../components/lock';
import { PlacementPicker } from '../components/placements';
import {
  boxSelectProps,
  useZoneCarry,
  ZONE_COLOR,
  zoneAround,
  zoneFlowNode,
  zoneFromNode,
  ZoneNode,
  type ZoneFlowNode,
} from '../components/zones';
import { ColorPicker, Loading, Modal, SaveIndicator, Swatch } from '../components/ui';
import { colorLabel } from '../colors';

const availableKey = (placementId: string | null, connectorId: string | null) => `${placementId}:${connectorId}`;

type EditorNode = ConnFlowNode | ZoneFlowNode;
const editorNodeTypes = { ...nodeTypes, zone: ZoneNode };
const isConnector = (n: EditorNode): n is ConnFlowNode => n.type === 'connector';
const isZone = (n: EditorNode): n is ZoneFlowNode => n.type === 'zone';

export default function ConnectionEditorPage() {
  const { pid, cid } = useParams() as { pid: string; cid: string };
  const connQ = useQuery({
    queryKey: ['connection', cid],
    queryFn: () => api.get<Connection>(`/api/connections/${cid}`),
    gcTime: 0,
    staleTime: 0,
  });
  const availQ = useQuery({
    queryKey: ['projectConnectors', pid],
    queryFn: () => api.get<ProjectConnector[]>(`/api/projects/${pid}/connectors`),
    staleTime: 0,
  });
  const placementsQ = useQuery({
    queryKey: ['projectPcbs', pid],
    queryFn: () => api.get<Placement[]>(`/api/projects/${pid}/pcbs`),
  });
  const typesQ = useQuery({ queryKey: ['connectorTypes'], queryFn: () => api.get<ConnectorType[]>('/api/connector-types') });
  const cablesQ = useQuery({ queryKey: ['cables'], queryFn: () => api.get<Cable[]>('/api/cables') });
  const projectQ = useProject(pid);

  if (!connQ.data || !availQ.data || !placementsQ.data || !typesQ.data || !cablesQ.data || !projectQ.data)
    return (
      <Loading error={connQ.error || availQ.error || placementsQ.error || typesQ.error || cablesQ.error || projectQ.error} />
    );
  // A locked project's connections can only be viewed.
  if (projectQ.data.lockedAt) return <Navigate to={`/projects/${pid}/connections/${cid}`} replace />;

  return (
    <ReactFlowProvider>
      <Editor
        key={connQ.data.id}
        projectId={pid}
        conn={connQ.data}
        available={availQ.data}
        placements={placementsQ.data}
        types={typesQ.data}
        cables={cablesQ.data}
      />
    </ReactFlowProvider>
  );
}

function Editor({
  projectId,
  conn,
  available,
  placements,
  types,
  cables,
}: {
  projectId: string;
  conn: Connection;
  available: ProjectConnector[];
  placements: Placement[];
  types: ConnectorType[];
  cables: Cable[];
}) {
  const qc = useQueryClient();
  const rf = useReactFlow();
  const flowWrap = useRef<HTMLDivElement>(null);

  const [wires, setWires] = useState<WireModel[]>(() =>
    conn.wires.map(({ id, fromNodeId, fromPin, toNodeId, toPin, cableId, coreIndex, color, lengthMm, note }) => ({
      id,
      fromNodeId,
      fromPin,
      toNodeId,
      toPin,
      cableId,
      coreIndex,
      color,
      lengthMm: lengthMm ?? null,
      note,
    })),
  );
  const [name, setName] = useState(conn.name);
  const [description, setDescription] = useState(conn.description);
  const [lengthInput, setLengthInput] = useState(conn.lengthMm != null ? String(conn.lengthMm) : '');
  const connectionLength = parseLength(lengthInput);
  // Components this connection uses; placements that already have connectors in the diagram always count.
  const [placementIds, setPlacementIds] = useState<string[]>(() => [
    ...new Set([...conn.placementIds, ...conn.nodes.flatMap((n) => (n.projectPcbId ? [n.projectPcbId] : []))]),
  ]);
  const [pickingComponents, setPickingComponents] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const [selectedWireId, setSelectedWireId] = useState<string | null>(null);
  const [defaultCableId, setDefaultCableId] = useState('');
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(0);
  const markDirty = useCallback(() => setDirty((d) => d + 1), []);

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<EditorNode>([
    ...(conn.zones ?? []).map((z) => zoneFlowNode(z, true, markDirty)),
    ...nodesFromDtos(conn.nodes),
  ]);
  // Connector nodes only (zones are nodes too, drawn behind them).
  const connNodes = useMemo(() => nodes.filter(isConnector), [nodes]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const wiresRef = useRef(wires);
  wiresRef.current = wires;
  const stateRef = useRef({ name, description, lengthMm: connectionLength, placementIds });
  stateRef.current = { name, description, lengthMm: connectionLength, placementIds };

  const edges = useMemo(() => buildEdges(connNodes, wires, selectedWireId), [connNodes, wires, selectedWireId]);
  const nodeById = useMemo(() => new Map(connNodes.map((n) => [n.id, n])), [connNodes]);
  const carry = useZoneCarry(setNodes);

  // ----- Autosave (debounced, serialized) -----
  const pending = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const save = useCallback(() => {
    pending.current = false;
    chain.current = chain.current.then(async () => {
      const s = stateRef.current;
      try {
        await api.put(`/api/connections/${conn.id}`, {
          name: s.name.trim() || 'Untitled connection',
          description: s.description,
          lengthMm: s.lengthMm,
          placementIds: s.placementIds,
          zones: nodesRef.current.filter(isZone).map(zoneFromNode),
          nodes: nodesRef.current.filter(isConnector).map((n) => ({
            id: n.id,
            pcbConnectorId: n.data.pcbConnectorId,
            projectPcbId: n.data.projectPcbId,
            connectorTypeId: n.data.connectorTypeId,
            label: n.data.label,
            pinCount: n.data.pinCount,
            x: n.position.x,
            y: n.position.y,
          })),
          wires: wiresRef.current,
        });
        if (!pending.current) setStatus('saved');
        setSaveError(null);
        qc.invalidateQueries({ queryKey: ['connections', projectId] });
        qc.invalidateQueries({ queryKey: ['map', projectId] });
      } catch (e) {
        setStatus('error');
        setSaveError(errorMessage(e));
      }
    });
  }, [conn.id, projectId, qc]);

  useEffect(() => {
    if (dirty === 0) return;
    pending.current = true;
    setStatus('saving');
    const t = setTimeout(save, 700);
    return () => clearTimeout(t);
  }, [dirty, save]);

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      if (pending.current) saveRef.current(); // flush when leaving the page
    },
    [],
  );

  // ----- Graph changes -----
  const onNodesChange = useCallback(
    (changes: NodeChange<EditorNode>[]) => {
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      onNodesChangeBase(changes);
      if (removed.length) {
        setWires((ws) => ws.filter((w) => !removed.includes(w.fromNodeId) && !removed.includes(w.toNodeId)));
        markDirty();
      }
    },
    [onNodesChangeBase, markDirty],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (removed.length) {
        setWires((ws) => ws.filter((w) => !removed.includes(w.id)));
        setSelectedWireId(null);
        markDirty();
      }
    },
    [markDirty],
  );

  const addWire = useCallback(
    (fromNodeId: string, fromPin: number, toNodeId: string, toPin: number) => {
      if (fromNodeId === toNodeId && fromPin === toPin) return;
      const ws = wiresRef.current;
      const cable = cables.find((c) => c.id === defaultCableId) ?? null;
      let coreIndex: number | null = null;
      let color = '';
      if (cable) {
        const used = new Set(ws.filter((w) => w.cableId === cable.id).map((w) => w.coreIndex));
        const free = cable.cores.findIndex((_, i) => !used.has(i));
        if (free >= 0) {
          coreIndex = free;
          color = cable.cores[free].color;
        }
      }
      if (!color) {
        const conns = nodesRef.current.filter(isConnector);
        const a = conns.find((n) => n.id === fromNodeId)?.data.pins.find((p) => p.n === fromPin);
        const b = conns.find((n) => n.id === toNodeId)?.data.pins.find((p) => p.n === toPin);
        color = a?.color || b?.color || '';
      }
      const wire: WireModel = {
        id: uuid(),
        fromNodeId,
        fromPin,
        toNodeId,
        toPin,
        cableId: cable?.id ?? null,
        coreIndex,
        color,
        lengthMm: null,
        note: '',
      };
      setWires((prev) => [...prev, wire]);
      setSelectedWireId(wire.id);
      markDirty();
    },
    [cables, defaultCableId, markDirty],
  );

  const onConnect = useCallback(
    (c: FlowConnection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      addWire(c.source, parseInt(c.sourceHandle, 10), c.target, parseInt(c.targetHandle, 10));
    },
    [addWire],
  );

  // Dragging a wire end onto another pin moves that end; dropping it elsewhere leaves the wire as it was.
  const onReconnect = useCallback(
    (old: { id: string }, c: FlowConnection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      const a = { node: c.source, pin: parseInt(c.sourceHandle, 10) };
      const b = { node: c.target, pin: parseInt(c.targetHandle, 10) };
      if (a.node === b.node && a.pin === b.pin) return;
      const same = (p: { node: string; pin: number }, node: string, pin: number) => p.node === node && p.pin === pin;
      setWires((ws) =>
        ws.map((w) => {
          if (w.id !== old.id) return w;
          // Keep From/To the same way round: the end that did not move stays where it was.
          const flip = same(b, w.fromNodeId, w.fromPin) || same(a, w.toNodeId, w.toPin);
          const [from, to] = flip ? [b, a] : [a, b];
          return { ...w, fromNodeId: from.node, fromPin: from.pin, toNodeId: to.node, toPin: to.pin };
        }),
      );
      setSelectedWireId(old.id);
      markDirty();
    },
    [markDirty],
  );

  function updateWire(id: string, patch: Partial<WireModel>) {
    setWires((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
    markDirty();
  }

  function removeWire(id: string) {
    setWires((ws) => ws.filter((w) => w.id !== id));
    if (selectedWireId === id) setSelectedWireId(null);
    markDirty();
  }

  function viewCenter(dy = 1 / 2) {
    const el = flowWrap.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height * dy });
  }

  function dropPosition() {
    const offset = (nodesRef.current.filter(isConnector).length % 5) * 24;
    const p = viewCenter(1 / 3);
    return { x: p.x - 110 + offset, y: p.y + offset };
  }

  /** Adds a zone around the selected connectors, or in the middle of the view when none are selected. */
  function addZone() {
    const around = zoneAround(nodesRef.current.filter((n) => isConnector(n) && n.selected));
    const c = viewCenter();
    const rect = around ?? { x: c.x - 200, y: c.y - 150, w: 400, h: 300 };
    const zone: ZoneShape = { id: uuid(), name: 'New zone', color: ZONE_COLOR, ...rect };
    setNodes((ns) => [{ ...zoneFlowNode(zone, true, markDirty), selected: true }, ...ns.map((n) => ({ ...n, selected: false }))]);
    setSelectedWireId(null);
    markDirty();
  }

  function updateZone(nodeId: string, patch: Partial<ZoneShape>) {
    setNodes((ns) =>
      ns.map((n) => (n.id === nodeId && isZone(n) ? { ...n, data: { ...n.data, zone: { ...n.data.zone, ...patch } } } : n)),
    );
    markDirty();
  }

  function addPcbConnector(c: ProjectConnector) {
    const node: ConnFlowNode = { id: uuid(), type: 'connector', position: dropPosition(), data: nodeDataFromPcbConnector(c, c.placement) };
    setNodes((ns) => [...ns, node]);
    markDirty();
  }

  function addFreeConnector(label: string, typeId: string, pinCount: number) {
    const type = types.find((t) => t.id === typeId) ?? null;
    const node: ConnFlowNode = {
      id: uuid(),
      type: 'connector',
      position: dropPosition(),
      data: nodeDataFree(label, type, pinCount),
    };
    setNodes((ns) => [...ns, node]);
    markDirty();
  }

  function removeNode(id: string) {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setWires((ws) => ws.filter((w) => w.fromNodeId !== id && w.toNodeId !== id));
    markDirty();
  }

  const placementById = new Map(placements.map((p) => [p.id, p]));

  /** Sets the chosen components; connectors of removed components leave the diagram (after confirming). */
  function changeComponents(ids: string[]) {
    const keep = new Set(ids);
    const dropped = nodesRef.current.filter(isConnector).filter((n) => n.data.projectPcbId && !keep.has(n.data.projectPcbId));
    if (dropped.length) {
      const names = [...new Set(dropped.map((n) => placementById.get(n.data.projectPcbId!)?.name ?? '?'))];
      const msg = `${dropped.length} connector(s) of ${names.join(', ')} are in this diagram.\nRemoving the component also removes them and their wires. Continue?`;
      if (!confirm(msg)) return false;
      const gone = new Set(dropped.map((n) => n.id));
      setNodes((ns) => ns.filter((n) => !gone.has(n.id)));
      setWires((ws) => ws.filter((w) => !gone.has(w.fromNodeId) && !gone.has(w.toNodeId)));
    }
    setPlacementIds(ids);
    markDirty();
    return true;
  }

  function toggleCollapsed(id: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const used = new Set(
    connNodes.filter((n) => n.data.pcbConnectorId).map((n) => availableKey(n.data.projectPcbId, n.data.pcbConnectorId)),
  );
  const chosen = new Set(placementIds);
  const included = placements.filter((p) => chosen.has(p.id));
  const includedConnectors = available.filter((c) => chosen.has(c.placement.id));
  // Search: every word must match the component, designator, name on board or connector type.
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (c: ProjectConnector) => {
    if (!terms.length) return true;
    const hay = [c.placement.name, c.pcb.name, c.label, c.name, c.connectorType?.name, c.connectorType?.crimpName]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
  const byPlacement = new Map<string, { all: ProjectConnector[]; shown: ProjectConnector[] }>();
  for (const c of includedConnectors) {
    if (!byPlacement.has(c.placement.id)) byPlacement.set(c.placement.id, { all: [], shown: [] });
    const g = byPlacement.get(c.placement.id)!;
    g.all.push(c);
    if (matches(c)) g.shown.push(c);
  }
  const shownCount = [...byPlacement.values()].reduce((n, g) => n + g.shown.length, 0);
  const selectedWire = wires.find((w) => w.id === selectedWireId) ?? null;
  const selectedNodes = connNodes.filter((n) => n.selected);
  const selectedZones = nodes.filter((n): n is ZoneFlowNode => isZone(n) && !!n.selected);

  return (
    <div className="editor-page">
      <div className="editor-toolbar">
        <div className="crumbs">
          <Link to={`/projects/${projectId}?tab=connections`}>Connections</Link> /
        </div>
        <input
          className="title-input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            markDirty();
          }}
          aria-label="Connection name"
        />
        <SaveIndicator status={status} onRetry={save} />
        <button
          className="btn btn-sm"
          onClick={addZone}
          title="Group connectors by machine part, e.g. Frame, Printbed, Toolhead. With connectors selected, the zone is drawn around them."
        >
          + Zone
        </button>
        <Link className="btn btn-sm" to={`/projects/${projectId}/connections/${conn.id}`}>
          View wiring diagram
        </Link>
      </div>
      {saveError && <p className="error">{saveError}</p>}

      <div className="editor-layout">
        <div className="flow-wrap" ref={flowWrap}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={editorNodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            reconnectRadius={14}
            onNodeDragStart={carry.onNodeDragStart}
            onNodeDrag={carry.onNodeDrag}
            onNodeDragStop={(e, n, dragged) => {
              carry.onNodeDragStop(e, n, dragged);
              markDirty();
            }}
            onEdgeClick={(_, e) => setSelectedWireId(e.id)}
            onPaneClick={() => setSelectedWireId(null)}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={['Delete', 'Backspace']}
            {...boxSelectProps}
            elevateNodesOnSelect={false}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls />
          </ReactFlow>
          {connNodes.length === 0 && (
            <div className="flow-empty">Add connectors from the panel, then drag from a pin to a pin to draw a wire.</div>
          )}
        </div>

        <aside className="editor-side">
          {selectedWire ? (
            <WirePanel
              wire={selectedWire}
              fromLabel={pinLabel(nodeById.get(selectedWire.fromNodeId), selectedWire.fromPin)}
              toLabel={pinLabel(nodeById.get(selectedWire.toNodeId), selectedWire.toPin)}
              cables={cables}
              connectionLength={connectionLength}
              onChange={(patch) => updateWire(selectedWire.id, patch)}
              onRemove={() => removeWire(selectedWire.id)}
              onClose={() => setSelectedWireId(null)}
            />
          ) : (
            <>
              {selectedZones.map((zn) => (
                <ZonePanel
                  key={zn.id}
                  zone={zn.data.zone}
                  onChange={(patch) => updateZone(zn.id, patch)}
                  onRemove={() => onNodesChange([{ type: 'remove', id: zn.id }])}
                />
              ))}
              <div className="panel">
                <h3>Connection</h3>
                <div className="form">
                  <label>
                    Description
                    <textarea
                      rows={2}
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        markDirty();
                      }}
                    />
                  </label>
                  <label>
                    Cable length (mm)
                    <input
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      value={lengthInput}
                      onChange={(e) => {
                        setLengthInput(e.target.value);
                        markDirty();
                      }}
                      placeholder="e.g. 450"
                    />
                  </label>
                  <label>
                    Cable for new wires
                    <select value={defaultCableId} onChange={(e) => setDefaultCableId(e.target.value)}>
                      <option value="">— none (use pin color) —</option>
                      {cables.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.coreCount} cores)
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="small muted">
                    New wires take the next free core of this cable and its color. Drag from a pin to another pin to draw a
                    wire, or grab the end of a wire next to its pin and drop it on another pin to move it. Select a wire or
                    connector and press Delete to remove it. Drag on empty space to select several connectors and move
                    them together; pan with the right mouse button or by holding Space. Zones group connectors by machine
                    part: drag a zone by its name to move it with everything inside.
                  </p>
                </div>
              </div>
              {selectedNodes.length > 0 && (
                <div className="panel">
                  <h3>Selected</h3>
                  {selectedNodes.map((n) => (
                    <div key={n.id} className="row-between">
                      <span>{n.data.title}</span>
                      <button className="btn btn-sm btn-danger" onClick={() => removeNode(n.id)}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="panel">
                <div className="panel-head">
                  <h3>Components</h3>
                  <button className="btn btn-sm" onClick={() => setPickingComponents(true)}>
                    {included.length ? 'Add / remove' : 'Choose components'}
                  </button>
                </div>
                {included.length === 0 && (
                  <p className="small muted">
                    Choose the components this connection links. Their connectors are listed here to add to the diagram.
                  </p>
                )}
                {includedConnectors.length > 8 && (
                  <div className="search-box">
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search J3, Power, JST…"
                      aria-label="Search connectors"
                    />
                    {search && (
                      <span className="small muted">
                        {shownCount} of {includedConnectors.length}
                      </span>
                    )}
                  </div>
                )}
                {terms.length > 0 && shownCount === 0 && <p className="small muted">No connectors match “{search}”.</p>}
                {included.map((pl) => {
                  const group = byPlacement.get(pl.id) ?? { all: [], shown: [] };
                  if (terms.length && !group.shown.length) return null;
                  const open = terms.length > 0 || !collapsed.has(pl.id);
                  const added = group.all.filter((c) => used.has(availableKey(pl.id, c.id))).length;
                  return (
                    <div key={pl.id} className="comp-group">
                      <div className="comp-head">
                        <button className="comp-toggle" onClick={() => toggleCollapsed(pl.id)} aria-expanded={open}>
                          <span className="comp-chevron">{open ? '▾' : '▸'}</span>
                          <img src={imgUrl(pl.pcb.thumbPath)} alt="" />
                          <span className="comp-name">{pl.name}</span>
                          <span className="small muted nowrap" title="Connectors in the diagram / on the component">
                            {added}/{group.all.length}
                          </span>
                        </button>
                        <button
                          className="btn-icon"
                          title="Remove component from this connection"
                          aria-label={`Remove ${pl.name}`}
                          onClick={() => changeComponents(placementIds.filter((id) => id !== pl.id))}
                        >
                          ×
                        </button>
                      </div>
                      {open && group.all.length === 0 && (
                        <p className="small muted comp-empty">
                          No connectors drawn yet.{' '}
                          <Link to={`/projects/${projectId}/pcbs/${pl.pcbId}?edit=1`}>Draw them on the photo</Link>
                        </p>
                      )}
                      {open &&
                        group.shown.map((c) => {
                          const isUsed = used.has(availableKey(pl.id, c.id));
                          return (
                            <div key={c.id} className="row-between comp-item">
                              <span>
                                <strong>{c.label || '?'}</strong>
                                {c.name && <> {c.name}</>}
                                {c.connectorType && <span className="muted small"> · {c.connectorType.name}</span>}
                              </span>
                              <button className="btn btn-sm" disabled={isUsed} onClick={() => addPcbConnector(c)}>
                                {isUsed ? 'Added' : '+ Add'}
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
              </div>
              <FreeConnectorForm types={types} onAdd={addFreeConnector} />
            </>
          )}
        </aside>
      </div>

      {pickingComponents && (
        <ComponentsModal
          projectId={projectId}
          placements={placements}
          initial={placementIds}
          onClose={() => setPickingComponents(false)}
          onApply={(ids) => {
            if (changeComponents(ids)) setPickingComponents(false);
          }}
        />
      )}

      <WireTable
        nodes={connNodes}
        wires={wires}
        cables={cables}
        connectionLength={connectionLength}
        selectedId={selectedWireId}
        onSelect={setSelectedWireId}
        onUpdate={updateWire}
        onAdd={addWire}
        onRemove={removeWire}
      />
    </div>
  );
}

function ZonePanel({
  zone,
  onChange,
  onRemove,
}: {
  zone: ZoneShape;
  onChange: (patch: Partial<ZoneShape>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="panel">
      <h3>Zone</h3>
      <div className="form">
        <label>
          Name
          <input value={zone.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. Toolhead" />
        </label>
        <label>
          Color
          <input type="color" value={zone.color} onChange={(e) => onChange({ color: e.target.value })} />
        </label>
        <p className="small muted">Drag the zone by its name to move it with the connectors inside. Drag a corner to resize it.</p>
        <button className="btn btn-sm btn-danger" onClick={onRemove}>
          Delete zone
        </button>
      </div>
    </div>
  );
}

function ComponentsModal({
  projectId,
  placements,
  initial,
  onClose,
  onApply,
}: {
  projectId: string;
  placements: Placement[];
  initial: string[];
  onClose: () => void;
  onApply: (ids: string[]) => void;
}) {
  const [ids, setIds] = useState(initial);
  return (
    <Modal title="Components in this connection" onClose={onClose} wide>
      <div className="form">
        <PlacementPicker projectId={projectId} placements={placements} selected={ids} onChange={setIds} />
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onApply(ids)}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function WirePanel({
  wire,
  fromLabel,
  toLabel,
  cables,
  connectionLength,
  onChange,
  onRemove,
  onClose,
}: {
  wire: WireModel;
  fromLabel: string;
  toLabel: string;
  cables: Cable[];
  connectionLength: number | null;
  onChange: (patch: Partial<WireModel>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const cable = cables.find((c) => c.id === wire.cableId) ?? null;
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Wire</h3>
        <button className="btn-icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p className="small">
        <strong>From:</strong> {fromLabel}
        <br />
        <strong>To:</strong> {toLabel}
      </p>
      <div className="form">
        <label>
          Cable
          <select
            value={wire.cableId ?? ''}
            onChange={(e) => onChange({ cableId: e.target.value || null, coreIndex: null })}
          >
            <option value="">— none —</option>
            {cables.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {cable && (
          <label>
            Core
            <select
              value={wire.coreIndex ?? ''}
              onChange={(e) => {
                const idx = e.target.value === '' ? null : Number(e.target.value);
                onChange({ coreIndex: idx, ...(idx !== null ? { color: cable.cores[idx]?.color ?? wire.color } : {}) });
              }}
            >
              <option value="">— choose core —</option>
              {cable.cores.map((core, i) => (
                <option key={i} value={i}>
                  Core {i + 1} {core.color ? `· ${colorLabel(core.color)}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Color
          <ColorPicker value={wire.color} onChange={(v) => onChange({ color: v })} />
        </label>
        <label>
          Length (mm)
          <LengthInput
            key={wire.id}
            value={wire.lengthMm}
            onChange={(v) => onChange({ lengthMm: v })}
            placeholder={connectionLength != null ? `${connectionLength} (connection)` : 'same as connection'}
          />
          <span className="small muted">Leave empty to use the connection length. Set it for harness branches that differ.</span>
        </label>
        <label>
          Note
          <input value={wire.note} onChange={(e) => onChange({ note: e.target.value })} />
        </label>
      </div>
      <div className="btn-row panel-foot">
        <button className="btn btn-sm btn-danger" onClick={onRemove}>
          Delete wire
        </button>
      </div>
    </div>
  );
}

/** Number input for a length in mm that keeps partial typing like "12." intact. */
function LengthInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(value != null ? String(value) : '');
  useEffect(() => {
    if (parseLength(text) !== value) setText(value != null ? String(value) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="number"
      min={0}
      step="any"
      inputMode="decimal"
      className={className}
      value={text}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseLength(e.target.value));
      }}
    />
  );
}

function FreeConnectorForm({
  types,
  onAdd,
}: {
  types: ConnectorType[];
  onAdd: (label: string, typeId: string, pinCount: number) => void;
}) {
  const [label, setLabel] = useState('');
  const [typeId, setTypeId] = useState('');
  const [pins, setPins] = useState(2);
  return (
    <div className="panel">
      <h3>Inline connector / splice</h3>
      <p className="small muted">For harness parts that are not on a component, such as an inline plug or a splice.</p>
      <div className="form">
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Splice 1" />
        </label>
        <label>
          Type
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">— none —</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.pinCount} pins)
              </option>
            ))}
          </select>
        </label>
        {!typeId && (
          <label>
            Pins
            <input type="number" min={1} max={200} value={pins} onChange={(e) => setPins(Math.max(1, +e.target.value))} />
          </label>
        )}
        <button
          className="btn btn-sm"
          onClick={() => {
            onAdd(label, typeId, pins);
            setLabel('');
          }}
        >
          + Add inline connector
        </button>
      </div>
    </div>
  );
}

function WireTable({
  nodes,
  wires,
  cables,
  connectionLength,
  selectedId,
  onSelect,
  onUpdate,
  onAdd,
  onRemove,
}: {
  nodes: ConnFlowNode[];
  wires: WireModel[];
  cables: Cable[];
  connectionLength: number | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<WireModel>) => void;
  onAdd: (fromNodeId: string, fromPin: number, toNodeId: string, toPin: number) => void;
  onRemove: (id: string) => void;
}) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const [from, setFrom] = useState({ node: '', pin: 1 });
  const [to, setTo] = useState({ node: '', pin: 1 });
  const pinsOf = (id: string) => nodeById.get(id)?.data.pins ?? [];

  return (
    <section className="panel wire-table">
      <h3>Wires ({wires.length})</h3>
      <div className="table-wrap">
        <table className="table clickable">
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Cable</th>
              <th>Color</th>
              <th>Length (mm)</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wires.map((w) => {
              const cable = cables.find((c) => c.id === w.cableId);
              return (
                <tr key={w.id} className={w.id === selectedId ? 'row-selected' : ''} onClick={() => onSelect(w.id)}>
                  <td>{pinLabel(nodeById.get(w.fromNodeId), w.fromPin)}</td>
                  <td>{pinLabel(nodeById.get(w.toNodeId), w.toPin)}</td>
                  <td>
                    {cable ? `${cable.name}${w.coreIndex != null ? ` · core ${w.coreIndex + 1}` : ''}` : ''}
                  </td>
                  <td>
                    <span className="swatches">
                      <Swatch color={w.color} /> {colorLabel(w.color)}
                    </span>
                  </td>
                  <td>
                    <LengthInput
                      className="length-input"
                      value={w.lengthMm}
                      onChange={(v) => onUpdate(w.id, { lengthMm: v })}
                      placeholder={connectionLength != null ? String(connectionLength) : '—'}
                    />
                  </td>
                  <td>{w.note}</td>
                  <td className="right">
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(w.id);
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr className="add-row">
              <td>
                <span className="input-row">
                  <select value={from.node} onChange={(e) => setFrom({ node: e.target.value, pin: 1 })}>
                    <option value="">connector…</option>
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.data.title}
                      </option>
                    ))}
                  </select>
                  <select value={from.pin} onChange={(e) => setFrom({ ...from, pin: +e.target.value })}>
                    {pinsOf(from.node).map((p) => (
                      <option key={p.n} value={p.n}>
                        {p.n}
                        {p.name ? ` ${p.name}` : ''}
                      </option>
                    ))}
                  </select>
                </span>
              </td>
              <td>
                <span className="input-row">
                  <select value={to.node} onChange={(e) => setTo({ node: e.target.value, pin: 1 })}>
                    <option value="">connector…</option>
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.data.title}
                      </option>
                    ))}
                  </select>
                  <select value={to.pin} onChange={(e) => setTo({ ...to, pin: +e.target.value })}>
                    {pinsOf(to.node).map((p) => (
                      <option key={p.n} value={p.n}>
                        {p.n}
                        {p.name ? ` ${p.name}` : ''}
                      </option>
                    ))}
                  </select>
                </span>
              </td>
              <td colSpan={5}>
                <button
                  className="btn btn-sm"
                  disabled={!from.node || !to.node || !pinsOf(from.node).length || !pinsOf(to.node).length}
                  onClick={() => onAdd(from.node, from.pin, to.node, to.pin)}
                >
                  + Add wire
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
