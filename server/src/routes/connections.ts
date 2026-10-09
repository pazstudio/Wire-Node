import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const fullInclude = {
  nodes: {
    include: {
      pcbConnector: { include: { pcb: { select: { id: true, name: true } }, connectorType: true } },
      projectPcb: { select: { id: true, name: true } },
      connectorType: true,
    },
  },
  wires: { include: { cable: true } },
} as const;

const LengthMm = z.number().nonnegative().max(1e7).nullable().optional();

const CreateBody = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().default(''),
  lengthMm: LengthMm,
});

const NodeSchema = z.object({
  id: z.string().min(1),
  pcbConnectorId: z.string().nullable().optional(),
  /** Which placement of the component in the project; required for new connectors on components. */
  projectPcbId: z.string().uuid().nullable().optional(),
  connectorTypeId: z.string().nullable().optional(),
  label: z.string().default(''),
  pinCount: z.number().int().min(0).max(1000).default(0),
  x: z.number().default(0),
  y: z.number().default(0),
});

const WireSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  fromPin: z.number().int().min(1),
  toNodeId: z.string().min(1),
  toPin: z.number().int().min(1),
  cableId: z.string().nullable().optional(),
  coreIndex: z.number().int().min(0).nullable().optional(),
  color: z.string().default(''),
  lengthMm: LengthMm,
  note: z.string().default(''),
});

const SaveBody = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().default(''),
  lengthMm: LengthMm,
  nodes: z.array(NodeSchema),
  wires: z.array(WireSchema),
});

type P = { Params: { id: string } };

/** Each placement must be in this project and be the component the connector is drawn on. */
async function checkPlacements(projectId: string, nodes: z.infer<typeof NodeSchema>[]) {
  const linked = nodes.filter((n) => n.pcbConnectorId && n.projectPcbId);
  if (!linked.length) return null;
  const [placements, connectors] = await Promise.all([
    prisma.projectPcb.findMany({
      where: { id: { in: linked.map((n) => n.projectPcbId!) }, projectId },
      select: { id: true, pcbId: true },
    }),
    prisma.pcbConnector.findMany({
      where: { id: { in: linked.map((n) => n.pcbConnectorId!) } },
      select: { id: true, pcbId: true },
    }),
  ]);
  const placementPcb = new Map(placements.map((p) => [p.id, p.pcbId]));
  const connectorPcb = new Map(connectors.map((c) => [c.id, c.pcbId]));
  for (const n of linked) {
    const pcbId = placementPcb.get(n.projectPcbId!);
    if (!pcbId) return 'A connector belongs to a component that is no longer in this project';
    if (pcbId !== connectorPcb.get(n.pcbConnectorId!)) return 'A connector does not belong to the component it was placed on';
  }
  return null;
}

export default async function connectionRoutes(app: FastifyInstance) {
  app.get<P>('/api/projects/:id/connections', async (req) => {
    const list = await prisma.connection.findMany({
      where: { projectId: req.params.id },
      orderBy: { name: 'asc' },
      include: {
        nodes: {
          include: {
            pcbConnector: { select: { label: true, name: true, pcb: { select: { name: true } } } },
            projectPcb: { select: { name: true } },
          },
        },
        _count: { select: { wires: true } },
      },
    });
    return list.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      kind: c.kind,
      lengthMm: c.lengthMm,
      wireCount: c._count.wires,
      endpoints: c.nodes.map((n) =>
        n.pcbConnector
          ? `${n.projectPcb?.name || n.pcbConnector.pcb.name}: ${[n.pcbConnector.label, n.pcbConnector.name].filter(Boolean).join(' ') || 'connector'}`
          : `${n.label || 'free'} (free)`,
      ),
    }));
  });

  app.post<P>('/api/projects/:id/connections', async (req, reply) => {
    const data = CreateBody.parse(req.body);
    const conn = await prisma.connection.create({ data: { ...data, projectId: req.params.id } });
    return reply.code(201).send(conn);
  });

  app.get<P>('/api/connections/:id', async (req) =>
    prisma.connection.findUniqueOrThrow({ where: { id: req.params.id }, include: fullInclude }),
  );

  // Saves the whole diagram (nodes + wires) as one document.
  app.put<P>('/api/connections/:id', async (req, reply) => {
    const b = SaveBody.parse(req.body);
    const id = req.params.id;
    const nodeIds = new Set(b.nodes.map((n) => n.id));
    for (const w of b.wires) {
      if (!nodeIds.has(w.fromNodeId) || !nodeIds.has(w.toNodeId)) {
        return reply.code(400).send({ message: 'A wire references a connector that is not in this connection' });
      }
    }
    const conn = await prisma.connection.findUniqueOrThrow({ where: { id } });
    const problem = await checkPlacements(conn.projectId, b.nodes);
    if (problem) return reply.code(400).send({ message: problem });
    await prisma.$transaction([
      prisma.connection.update({
        where: { id },
        data: {
          name: b.name,
          description: b.description,
          lengthMm: b.lengthMm ?? null,
          kind: b.nodes.length > 2 ? 'harness' : 'direct',
        },
      }),
      prisma.wire.deleteMany({ where: { connectionId: id } }),
      prisma.connectionNode.deleteMany({ where: { connectionId: id } }),
      prisma.connectionNode.createMany({
        data: b.nodes.map((n) => ({
          ...n,
          pcbConnectorId: n.pcbConnectorId ?? null,
          projectPcbId: n.pcbConnectorId ? (n.projectPcbId ?? null) : null,
          connectorTypeId: n.connectorTypeId ?? null,
          connectionId: id,
        })),
      }),
      prisma.wire.createMany({
        data: b.wires.map((w) => ({
          ...w,
          cableId: w.cableId ?? null,
          coreIndex: w.coreIndex ?? null,
          lengthMm: w.lengthMm ?? null,
          connectionId: id,
        })),
      }),
    ]);
    return prisma.connection.findUniqueOrThrow({ where: { id }, include: fullInclude });
  });

  app.delete<P>('/api/connections/:id', async (req) => {
    await prisma.connection.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}
