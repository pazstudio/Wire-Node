import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Background, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, useNodesState } from '@xyflow/react';
import { api, formatLength, type Connection } from '../api';
import { buildEdges, edgeTypes, nodesFromDtos, nodeTypes, pinLabel, type ConnFlowNode } from '../components/flow';
import { useLocked } from '../components/lock';
import { Loading, Swatch } from '../components/ui';
import { zoneFlowNode, ZoneNode, type ZoneFlowNode } from '../components/zones';
import { colorLabel } from '../colors';

const diagramNodeTypes = { ...nodeTypes, zone: ZoneNode };
const isConnector = (n: ConnFlowNode | ZoneFlowNode): n is ConnFlowNode => n.type === 'connector';

export default function WiringDiagramPage() {
  const { pid, cid } = useParams() as { pid: string; cid: string };
  const q = useQuery({
    queryKey: ['connection', cid],
    queryFn: () => api.get<Connection>(`/api/connections/${cid}`),
    staleTime: 0,
  });
  if (!q.data) return <Loading error={q.error} />;
  return (
    <ReactFlowProvider>
      <Diagram key={q.data.id} projectId={pid} conn={q.data} />
    </ReactFlowProvider>
  );
}

function Diagram({ projectId, conn }: { projectId: string; conn: Connection }) {
  const locked = useLocked(projectId);
  // Read-only nodes get pointer-events: none from React Flow; keep them hoverable for the picture preview.
  const [nodes, , onNodesChange] = useNodesState<ConnFlowNode | ZoneFlowNode>([
    ...(conn.zones ?? []).map((z) => zoneFlowNode(z, false)),
    ...nodesFromDtos(conn.nodes).map((n) => ({ ...n, style: { pointerEvents: 'all' as const } })),
  ]);
  const connNodes = useMemo(() => nodes.filter(isConnector), [nodes]);
  const edges = useMemo(() => buildEdges(connNodes, conn.wires), [connNodes, conn.wires]);
  const nodeById = new Map(connNodes.map((n) => [n.id, n]));

  return (
    <div className="editor-page">
      <div className="editor-toolbar">
        <div className="crumbs no-print">
          <Link to={`/projects/${projectId}?tab=connections`}>Connections</Link> /
        </div>
        <h1 className="diagram-title">{conn.name}</h1>
        <span className={`badge ${conn.kind === 'harness' ? 'badge-harness' : ''}`}>{conn.kind}</span>
        <div className="btn-row no-print">
          {locked ? (
            <span className="badge badge-locked">🔒 Locked</span>
          ) : (
            <Link className="btn btn-sm btn-primary" to={`/projects/${projectId}/connections/${conn.id}/edit`}>
              Edit
            </Link>
          )}
          <button className="btn btn-sm" onClick={() => window.print()}>
            Print / PDF
          </button>
        </div>
      </div>
      {(conn.description || conn.lengthMm != null) && (
        <p className="muted">
          {conn.lengthMm != null && <strong>Cable length: {formatLength(conn.lengthMm)}</strong>}
          {conn.lengthMm != null && conn.description && ' · '}
          {conn.description}
        </p>
      )}

      <div className="flow-wrap diagram-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={diagramNodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable={false}
          connectionMode={ConnectionMode.Loose}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {connNodes.length === 0 && <div className="flow-empty">This connection is empty. Click Edit to add connectors and wires.</div>}
      </div>

      <section className="panel wire-table">
        <h3>Pin-to-pin list ({conn.wires.length} wires)</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Cable</th>
                <th>Gauge</th>
                <th>Color</th>
                <th>Length</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {conn.wires.map((w) => (
                <tr key={w.id}>
                  <td>{pinLabel(nodeById.get(w.fromNodeId), w.fromPin)}</td>
                  <td>{pinLabel(nodeById.get(w.toNodeId), w.toPin)}</td>
                  <td>
                    {w.cable ? `${w.cable.name}${w.coreIndex != null ? ` · core ${w.coreIndex + 1}` : ''}` : ''}
                    {w.cable?.shielded ? ' · shielded' : ''}
                  </td>
                  <td>{w.cable?.gauge}</td>
                  <td>
                    <span className="swatches">
                      <Swatch color={w.color} /> {colorLabel(w.color)}
                    </span>
                  </td>
                  <td>{formatLength(w.lengthMm ?? conn.lengthMm)}</td>
                  <td>{w.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
