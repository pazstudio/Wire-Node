import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ConnectionMode, ReactFlow, useNodesState } from '@xyflow/react';
import { api, type Connection } from '../api';
import { buildEdges, edgeTypes, nodesFromDtos, nodeTypes, type ConnFlowNode } from './flow';
import { zoneFlowNode, ZoneNode, type ZoneFlowNode } from './zones';

const previewNodeTypes = { ...nodeTypes, zone: ZoneNode };
const isConnector = (n: ConnFlowNode | ZoneFlowNode): n is ConnFlowNode => n.type === 'connector';

/**
 * The connections in this project that use a connector on a component, each as a small diagram
 * with the connector highlighted. Clicking a diagram opens that connection.
 */
export function ConnectorConnections({ connectorId, projectId }: { connectorId: string; projectId: string }) {
  const usageQ = useQuery({
    queryKey: ['connectorUsage', connectorId, projectId],
    queryFn: () =>
      api.get<{ connections: { id: string; name: string }[] }>(
        `/api/pcb-connectors/${connectorId}/usage?projectId=${encodeURIComponent(projectId)}`,
      ),
    staleTime: 0,
  });
  const used = usageQ.data?.connections ?? [];
  const connQs = useQueries({
    queries: used.map((c) => ({
      queryKey: ['connection', c.id],
      queryFn: () => api.get<Connection>(`/api/connections/${c.id}`),
      staleTime: 0,
    })),
  });

  return (
    <div className="connector-conns">
      <h4>Connections</h4>
      {usageQ.isPending && <p className="small muted">Loading…</p>}
      {usageQ.isError && <p className="small muted">Could not load the connections.</p>}
      {usageQ.isSuccess && used.length === 0 && (
        <p className="small muted">
          Not used in any connection of this project yet.{' '}
          <Link to={`/projects/${projectId}?tab=connections&new=1`}>New connection</Link>
        </p>
      )}
      {used.map((c, i) => {
        const conn = connQs[i]?.data;
        return conn ? (
          <ConnectorUsage key={c.id} conn={conn} connectorId={connectorId} to={`/projects/${projectId}/connections/${c.id}`} />
        ) : (
          <div key={c.id} className="mini-diagram">
            <div className="mini-diagram-head">
              <strong>{c.name}</strong>
            </div>
            <div className="mini-diagram-flow mini-diagram-loading small muted">
              {connQs[i]?.isError ? 'Could not load this connection.' : 'Loading…'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConnectorUsage({ conn, connectorId, to }: { conn: Connection; connectorId: string; to: string }) {
  const { here, wiresHere } = useMemo(() => {
    const here = new Set(conn.nodes.filter((n) => n.pcbConnectorId === connectorId).map((n) => n.id));
    return { here, wiresHere: conn.wires.filter((w) => here.has(w.fromNodeId) || here.has(w.toNodeId)).length };
  }, [conn, connectorId]);
  return (
    <MiniDiagram
      conn={conn}
      highlight={here}
      to={to}
      info={
        <span className="small muted">
          {wiresHere} wire{wiresHere === 1 ? '' : 's'} on this connector
        </span>
      }
    />
  );
}

/** A connection as a small read-only diagram with some connectors highlighted. Clicking it opens the connection. */
export function MiniDiagram({
  conn,
  highlight,
  to,
  info,
  children,
}: {
  conn: Connection;
  /** Ids of the connection nodes to highlight. */
  highlight: Set<string>;
  to: string;
  /** Shown next to the connection name. */
  info?: ReactNode;
  /** Shown under the heading, above the diagram. */
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const [nodes, setNodes, onNodesChange] = useNodesState<ConnFlowNode | ZoneFlowNode>([
    ...(conn.zones ?? []).map((z) => zoneFlowNode(z, false)),
    ...nodesFromDtos(conn.nodes).map((n) => ({ ...n, selected: highlight.has(n.id) })),
  ]);
  // The card stays mounted while a search changes which connectors match.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (isConnector(n) && n.selected !== highlight.has(n.id) ? { ...n, selected: highlight.has(n.id) } : n)));
  }, [highlight, setNodes]);
  const connNodes = useMemo(() => nodes.filter(isConnector), [nodes]);
  const edges = useMemo(() => buildEdges(connNodes, conn.wires), [connNodes, conn.wires]);

  return (
    <div
      className="mini-diagram"
      role="link"
      tabIndex={0}
      title={`Open connection "${conn.name}"`}
      onClick={() => navigate(to)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(to);
      }}
    >
      <div className="mini-diagram-head">
        <strong>{conn.name}</strong>
        {info}
      </div>
      {children}
      <div className="mini-diagram-flow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={previewNodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          // Every pin handle is a "source"; wires ending on one are only drawn in loose mode.
          connectionMode={ConnectionMode.Loose}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          fitView
          fitViewOptions={{ padding: 0.08 }}
          minZoom={0.05}
          proOptions={{ hideAttribution: true }}
        />
      </div>
      <div className="node-preview-action">Click to open the connection →</div>
    </div>
  );
}
