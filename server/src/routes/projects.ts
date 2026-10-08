import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const ProjectBody = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  machine: z.string().default(''),
  description: z.string().default(''),
});

type P = { Params: { id: string } };
type PP = { Params: { id: string; pcbId: string } };

export async function attachPcb(projectId: string, pcbId: string) {
  const count = await prisma.projectPcb.count({ where: { projectId } });
  await prisma.projectPcb.upsert({
    where: { projectId_pcbId: { projectId, pcbId } },
    create: { projectId, pcbId, mapX: (count % 4) * 300, mapY: Math.floor(count / 4) * 260 },
    update: {},
  });
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

  // ----- PCBs attached to a project -----
  app.get<P>('/api/projects/:id/pcbs', async (req) => {
    const rows = await prisma.projectPcb.findMany({
      where: { projectId: req.params.id },
      include: { pcb: { include: { _count: { select: { connectors: true } } } } },
    });
    return rows
      .map((r) => ({ ...r.pcb, mapX: r.mapX, mapY: r.mapY }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  app.post<P>('/api/projects/:id/pcbs', async (req, reply) => {
    const { pcbId } = z.object({ pcbId: z.string().min(1) }).parse(req.body);
    await prisma.project.findUniqueOrThrow({ where: { id: req.params.id } });
    await prisma.pcb.findUniqueOrThrow({ where: { id: pcbId } });
    await attachPcb(req.params.id, pcbId);
    return reply.code(201).send({ ok: true });
  });

  app.patch<PP>('/api/projects/:id/pcbs/:pcbId', async (req) => {
    const data = z.object({ mapX: z.number(), mapY: z.number() }).parse(req.body);
    return prisma.projectPcb.update({
      where: { projectId_pcbId: { projectId: req.params.id, pcbId: req.params.pcbId } },
      data,
    });
  });

  app.delete<PP>('/api/projects/:id/pcbs/:pcbId', async (req) => {
    await prisma.projectPcb.deleteMany({ where: { projectId: req.params.id, pcbId: req.params.pcbId } });
    return { ok: true };
  });

  // All connectors drawn on PCBs attached to this project (used by the connection wizard).
  app.get<P>('/api/projects/:id/connectors', async (req) =>
    prisma.pcbConnector.findMany({
      where: { pcb: { projects: { some: { projectId: req.params.id } } } },
      include: { pcb: { select: { id: true, name: true } }, connectorType: true },
      orderBy: [{ pcb: { name: 'asc' } }, { label: 'asc' }],
    }),
  );
}
