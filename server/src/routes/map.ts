import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { computeMapEdges } from '../mapEdges.js';
import { listPlacements } from './projects.js';

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
    const [project, placements, zones, connections] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
      listPlacements(projectId),
      prisma.zone.findMany({ where: { projectId } }),
      prisma.connection.findMany({
        where: { projectId },
        include: {
          nodes: { select: { id: true, projectPcbId: true } },
          wires: { select: { fromNodeId: true, toNodeId: true } },
        },
      }),
    ]);
    const edges = computeMapEdges(
      connections.map((c) => ({
        id: c.id,
        name: c.name,
        nodes: c.nodes.map((n) => ({ id: n.id, blockId: n.projectPcbId })),
        wires: c.wires,
      })),
      new Set(placements.map((p) => p.id)),
    );
    return { project, placements, zones, edges };
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
