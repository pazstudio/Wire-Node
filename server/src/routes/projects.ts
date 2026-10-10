import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { pcbPreviewSelect } from './connections.js';

const ProjectBody = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  machine: z.string().default(''),
  description: z.string().default(''),
});

const FolderBody = z.object({ name: z.string().trim().min(1, 'Name is required').max(200) });
export const FolderKind = z.enum(['components', 'connections']);

/** True if the folder is in the project and holds this kind of item. */
export async function folderInProject(folderId: string, projectId: string, kind: z.infer<typeof FolderKind>) {
  return !!(await prisma.folder.findFirst({ where: { id: folderId, projectId, kind } }));
}

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

/** Throws 400 unless the folder is a components folder of the project. */
export async function assertComponentFolder(projectId: string, folderId: string | null | undefined) {
  if (folderId && !(await folderInProject(folderId, projectId, 'components'))) {
    throw Object.assign(new Error('That folder is not in this project'), { statusCode: 400 });
  }
}

/** Places a library component in a project. The same component can be placed several times. */
export async function placePcb(projectId: string, pcbId: string, name: string, folderId: string | null = null) {
  const pcb = await prisma.pcb.findUniqueOrThrow({ where: { id: pcbId } });
  await assertPlacementNameFree(projectId, name || pcb.name);
  await assertComponentFolder(projectId, folderId);
  const count = await prisma.projectPcb.count({ where: { projectId } });
  return prisma.projectPcb.create({
    data: {
      projectId,
      pcbId,
      // Store an empty name when it equals the component name, so renaming the component carries over.
      name: name === pcb.name ? '' : name,
      mapX: (count % 4) * 300,
      mapY: Math.floor(count / 4) * 260,
      folderId,
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
    const { pcbId, name, folderId } = z
      .object({ pcbId: z.string().min(1), name: PlacementNameField, folderId: z.string().nullable().default(null) })
      .parse(req.body);
    await prisma.project.findUniqueOrThrow({ where: { id: req.params.id } });
    return reply.code(201).send(await placePcb(req.params.id, pcbId, name, folderId));
  });

  app.patch<P>('/api/project-pcbs/:id', async (req, reply) => {
    const data = z
      .object({ mapX: z.number(), mapY: z.number(), name: PlacementNameField, folderId: z.string().nullable() })
      .partial()
      .parse(req.body);
    const existing = await prisma.projectPcb.findUniqueOrThrow({ where: { id: req.params.id }, include: { pcb: true } });
    await assertComponentFolder(existing.projectId, data.folderId);
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

  // ----- Folders on the Components tab -----
  // ?kind=components (the default) or ?kind=connections
  app.get<P & { Querystring: { kind?: string } }>('/api/projects/:id/folders', async (req) => {
    const kind = FolderKind.parse(req.query.kind ?? 'components');
    const folders = await prisma.folder.findMany({ where: { projectId: req.params.id, kind } });
    return folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  });

  app.post<P>('/api/projects/:id/folders', async (req, reply) => {
    const { name, kind } = FolderBody.extend({ kind: FolderKind.default('components') }).parse(req.body);
    await prisma.project.findUniqueOrThrow({ where: { id: req.params.id } });
    return reply.code(201).send(await prisma.folder.create({ data: { name, kind, projectId: req.params.id } }));
  });

  app.patch<P>('/api/folders/:id', async (req) =>
    prisma.folder.update({ where: { id: req.params.id }, data: FolderBody.parse(req.body) }),
  );

  // What was in the folder stays in the project, outside any folder.
  app.delete<P>('/api/folders/:id', async (req) => {
    await prisma.folder.deleteMany({ where: { id: req.params.id } });
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
            ...pcbPreviewSelect,
            connectors: { include: { connectorType: true }, orderBy: { label: 'asc' } },
          },
        },
      },
    });
    return placements
      .map((pl) => ({ pl, name: placementName(pl) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .flatMap(({ pl, name }) => {
        const { connectors, ...pcb } = pl.pcb;
        return connectors.map((c) => ({ ...c, pcb, placement: { id: pl.id, name } }));
      });
  });
}
