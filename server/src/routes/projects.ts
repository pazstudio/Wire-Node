import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const ProjectBody = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  machine: z.string().default(''),
  description: z.string().default(''),
});

type P = { Params: { id: string } };

/** Name of a placement in its project, e.g. "Peltier Driver - Toolhead1". */
export const placementName = (p: { name: string; pcb: { name: string } }) => p.name || p.pcb.name;

export const PlacementNameField = z.string().trim().max(200).default('');

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

/** Throws 409 if another placement in the project already shows this name. */
export async function assertPlacementNameFree(projectId: string, name: string, exceptId?: string) {
  const others = await prisma.projectPcb.findMany({
    where: { projectId, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { name: true, pcb: { select: { name: true } } },
  });
  const wanted = name.trim().toLowerCase();
  if (others.some((o) => placementName(o).toLowerCase() === wanted)) {
    throw conflict(`"${name}" is already used in this project. Give this placement a different name, e.g. "${name} - 2".`);
  }
}

/** Places a library component in a project. The same component can be placed several times. */
export async function placePcb(projectId: string, pcbId: string, name: string) {
  const pcb = await prisma.pcb.findUniqueOrThrow({ where: { id: pcbId } });
  await assertPlacementNameFree(projectId, name || pcb.name);
  const count = await prisma.projectPcb.count({ where: { projectId } });
  return prisma.projectPcb.create({
    data: {
      projectId,
      pcbId,
      // Store an empty name when it equals the component name, so renaming the component carries over.
      name: name === pcb.name ? '' : name,
      mapX: (count % 4) * 300,
      mapY: Math.floor(count / 4) * 260,
    },
  });
}

/** Components placed in a project, with the library component they show. */
export async function listPlacements(projectId: string) {
  const rows = await prisma.projectPcb.findMany({
    where: { projectId },
    include: { pcb: { include: { _count: { select: { connectors: true } } } } },
  });
  return rows
    .map((r) => ({ ...r, name: placementName(r) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export default async function projectRoutes(app: FastifyInstance) {
  app.get('/api/projects', async () =>
    prisma.project.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { pcbs: true, connections: true } } },
    }),
  );

  app.post('/api/projects', async (req, reply) => {
    const project = await prisma.project.create({ data: ProjectBody.parse(req.body) });
    return reply.code(201).send(project);
  });

  app.get<P>('/api/projects/:id', async (req) =>
    prisma.project.findUniqueOrThrow({ where: { id: req.params.id } }),
  );

  app.put<P>('/api/projects/:id', async (req) =>
    prisma.project.update({ where: { id: req.params.id }, data: ProjectBody.parse(req.body) }),
  );

  app.delete<P>('/api/projects/:id', async (req) => {
    await prisma.project.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ----- Components placed in a project -----
  app.get<P>('/api/projects/:id/pcbs', async (req) => listPlacements(req.params.id));

  app.post<P>('/api/projects/:id/pcbs', async (req, reply) => {
    const { pcbId, name } = z.object({ pcbId: z.string().min(1), name: PlacementNameField }).parse(req.body);
    await prisma.project.findUniqueOrThrow({ where: { id: req.params.id } });
    return reply.code(201).send(await placePcb(req.params.id, pcbId, name));
  });

  app.patch<P>('/api/project-pcbs/:id', async (req) => {
    const data = z
      .object({ mapX: z.number(), mapY: z.number(), name: PlacementNameField })
      .partial()
      .parse(req.body);
    const existing = await prisma.projectPcb.findUniqueOrThrow({ where: { id: req.params.id }, include: { pcb: true } });
    if (data.name !== undefined) {
      await assertPlacementNameFree(existing.projectId, data.name || existing.pcb.name, existing.id);
      if (data.name === existing.pcb.name) data.name = '';
    }
    return prisma.projectPcb.update({ where: { id: existing.id }, data });
  });

  // Removing a placement also removes its connectors (and their wires) from the project's connections.
  app.delete<P>('/api/project-pcbs/:id', async (req) => {
    await prisma.projectPcb.deleteMany({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<P>('/api/project-pcbs/:id/usage', async (req) => {
    const connections = await prisma.connection.findMany({
      where: { nodes: { some: { projectPcbId: req.params.id } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { connections };
  });

  // Connectors of every placed component (used by the connection editor).
  // A component placed twice lists its connectors twice, once per placement.
  app.get<P>('/api/projects/:id/connectors', async (req) => {
    const placements = await prisma.projectPcb.findMany({
      where: { projectId: req.params.id },
      include: {
        pcb: {
          select: {
            id: true,
            name: true,
            connectors: { include: { connectorType: true }, orderBy: { label: 'asc' } },
          },
        },
      },
    });
    return placements
      .map((pl) => ({ pl, name: placementName(pl) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .flatMap(({ pl, name }) =>
        pl.pcb.connectors.map((c) => ({
          ...c,
          pcb: { id: pl.pcb.id, name: pl.pcb.name },
          placement: { id: pl.id, name },
        })),
      );
  });
}
