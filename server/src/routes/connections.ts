import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const fullInclude = {
  nodes: {
    include: {
      pcbConnector: { include: { pcb: { select: { id: true, name: true } }, connectorType: true } },
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

export default async function connectionRoutes(app: FastifyInstance) {
  app.get<P>('/api/projects/:id/connections', async (req) => {
    const list = await prisma.connection.findMany({
      where: { projectId: req.params.id },
      orderBy: { name: 'asc' },
      include: {
        nodes: { include: { pcbConnector: { select: { label: true, name: true, pcb: { select: { name: true } } } } } },
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
          ? `${n.pcbConnector.pcb.name}: ${[n.pcbConnector.label, n.pcbConnector.name].filter(Boolean).join(' ') || 'connector'}`
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
    await prisma.connection.findUniqueOrThrow({ where: { id } });
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
