import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { computeMapEdges } from '../mapEdges.js';

const ZoneBody = z.object({
  name: z.string().default('Zone'),
  color: z.string().default('#3b82f6'),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

type P = { Params: { id: string } };

export default async function mapRoutes(app: FastifyInstance) {
  app.get<P>('/api/projects/:id/map', async (req) => {
    const projectId = req.params.id;
    const [project, rows, zones, connections] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
      prisma.projectPcb.findMany({
        where: { projectId },
        include: { pcb: { include: { _count: { select: { connectors: true } } } } },
      }),
      prisma.zone.findMany({ where: { projectId } }),
      prisma.connection.findMany({
        where: { projectId },
        include: {
          nodes: { select: { id: true, pcbConnector: { select: { pcbId: true } } } },
          wires: { select: { fromNodeId: true, toNodeId: true } },
        },
      }),
    ]);
    const pcbs = rows.map((r) => ({ ...r.pcb, mapX: r.mapX, mapY: r.mapY }));
    const edges = computeMapEdges(
      connections.map((c) => ({
        id: c.id,
        name: c.name,
        nodes: c.nodes.map((n) => ({ id: n.id, pcbId: n.pcbConnector?.pcbId ?? null })),
        wires: c.wires,
      })),
      new Set(pcbs.map((p) => p.id)),
    );
    return { project, pcbs, zones, edges };
  });

  app.post<P>('/api/projects/:id/zones', async (req, reply) => {
    const zone = await prisma.zone.create({ data: { ...ZoneBody.parse(req.body), projectId: req.params.id } });
    return reply.code(201).send(zone);
  });

  app.put<P>('/api/zones/:id', async (req) =>
    prisma.zone.update({ where: { id: req.params.id }, data: ZoneBody.partial().parse(req.body) }),
  );

  app.delete<P>('/api/zones/:id', async (req) => {
    await prisma.zone.deleteMany({ where: { id: req.params.id } });
    return { ok: true };
  });
}
