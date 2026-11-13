import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { computeMapEdges } from '../mapEdges.js';
import { arrangeByFolders } from '../mapLayout.js';
import { assertUnlocked } from '../freeze.js';
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

/** Lines between the component blocks of a project, one per pair of components. */
async function loadEdges(projectId: string) {
  const [placements, connections] = await Promise.all([
    prisma.projectPcb.findMany({ where: { projectId }, select: { id: true } }),
    prisma.connection.findMany({
      where: { projectId },
      include: {
        nodes: { select: { id: true, projectPcbId: true } },
        wires: { select: { fromNodeId: true, toNodeId: true } },
      },
    }),
  ]);
  return computeMapEdges(
    connections.map((c) => ({
      id: c.id,
      name: c.name,
      nodes: c.nodes.map((n) => ({ id: n.id, blockId: n.projectPcbId })),
      wires: c.wires,
    })),
    new Set(placements.map((p) => p.id)),
  );
}

export default async function mapRoutes(app: FastifyInstance) {
  app.get<P>('/api/projects/:id/map', async (req) => {
    const projectId = req.params.id;
    const [project, placements, zones, folders, edges] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
      listPlacements(projectId),
      prisma.zone.findMany({ where: { projectId } }),
      prisma.folder.findMany({ where: { projectId, kind: 'components' }, select: { id: true, name: true } }),
      loadEdges(projectId),
    ]);
    return { project, placements, zones, folders, edges };
  });

  // Makes a zone for every components folder (reusing a zone with the folder's name) and lays
  // the components out inside them. Other zones are left where they are.
  app.post<P>('/api/projects/:id/map/arrange-by-folders', async (req) => {
    const projectId = req.params.id;
    await assertUnlocked(projectId);
    const [placements, folders, zones, edges] = await Promise.all([
      listPlacements(projectId),
      prisma.folder.findMany({ where: { projectId, kind: 'components' } }),
      prisma.zone.findMany({ where: { projectId } }),
      loadEdges(projectId),
    ]);
    const plan = arrangeByFolders(placements, folders, zones, edges);
    await prisma.$transaction([
      ...plan.positions.map((p) => prisma.projectPcb.update({ where: { id: p.id }, data: { mapX: p.mapX, mapY: p.mapY } })),
      ...plan.zones.map(({ id, ...z }) =>
        id ? prisma.zone.update({ where: { id }, data: z }) : prisma.zone.create({ data: { ...z, projectId } }),
      ),
    ]);
    return { zones: plan.zones.length, placements: plan.positions.length };
  });

  app.post<P>('/api/projects/:id/zones', async (req, reply) => {
    await assertUnlocked(req.params.id);
    const zone = await prisma.zone.create({ data: { ...ZoneBody.parse(req.body), projectId: req.params.id } });
    return reply.code(201).send(zone);
  });

  app.put<P>('/api/zones/:id', async (req) => {
    const zone = await prisma.zone.findUniqueOrThrow({ where: { id: req.params.id } });
    await assertUnlocked(zone.projectId);
    return prisma.zone.update({ where: { id: zone.id }, data: ZoneBody.partial().parse(req.body) });
  });

  app.delete<P>('/api/zones/:id', async (req) => {
    const zone = await prisma.zone.findUnique({ where: { id: req.params.id } });
    if (zone) await assertUnlocked(zone.projectId);
    await prisma.zone.deleteMany({ where: { id: req.params.id } });
    return { ok: true };
  });
}
