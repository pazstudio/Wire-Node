import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { deleteFiles, readMultipart, saveImage } from '../storage.js';
import { attachPcb } from './projects.js';

const PcbFields = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().default(''),
});

const PinSchema = z.object({
  n: z.number().int().min(1),
  name: z.string().default(''),
  color: z.string().default(''),
});

const ConnectorBody = z.object({
  pcbId: z.string().min(1),
  connectorTypeId: z.string().nullable().optional(),
  label: z.string().default(''),
  name: z.string().default(''),
  x:z.number().min(-0.01).max(1.01),
  y: z.number().min(-0.01).max(1.01),
  w: z.number().positive().max(1.01),
  h: z.number().positive().max(1.01),
  rotation: z.number().default(0),
  pins: z.array(PinSchema).max(1000).default([]),
});

type P = { Params: { id: string } };

export default async function pcbRoutes(app: FastifyInstance) {
  app.get('/api/pcbs', async () =>
    prisma.pcb.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { connectors: true } },
        projects: { select: { project: { select: { id: true, name: true } } } },
      },
    }),
  );

  app.post('/api/pcbs', async (req, reply) => {
    const { fields, file } = await readMultipart(req);
    const meta = PcbFields.parse(fields);
    if (!file) return reply.code(400).send({ message: 'A picture of the component is required' });
    const img = await saveImage(file);
    const pcb = await prisma.pcb.create({
      data: {
        name: meta.name,
        description: meta.description,
        imagePath: img.imagePath,
        thumbPath: img.thumbPath,
        imageWidth: img.width,
        imageHeight: img.height,
      },
    });
    if (fields.projectId) await attachPcb(fields.projectId, pcb.id);
    return reply.code(201).send(pcb);
  });

  app.get<P>('/api/pcbs/:id', async (req) =>
    prisma.pcb.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        connectors: { include: { connectorType: true }, orderBy: { label: 'asc' } },
        projects: { select: { project: { select: { id: true, name: true } } } },
      },
    }),
  );

  app.put<P>('/api/pcbs/:id', async (req) => {
    const existing = await prisma.pcb.findUniqueOrThrow({ where: { id: req.params.id } });
    const { fields, file } = await readMultipart(req);
    const meta = PcbFields.parse(fields);
    const img = file ? await saveImage(file) : null;
    const pcb = await prisma.pcb.update({
      where: { id: existing.id },
      data: {
        name: meta.name,
        description: meta.description,
        ...(img
          ? { imagePath: img.imagePath, thumbPath: img.thumbPath, imageWidth: img.width, imageHeight: img.height }
          : {}),
      },
    });
    if (img) await deleteFiles(existing.imagePath, existing.thumbPath);
    return pcb;
  });

  app.delete<P>('/api/pcbs/:id', async (req) => {
    const pcb = await prisma.pcb.delete({ where: { id: req.params.id } });
    await deleteFiles(pcb.imagePath, pcb.thumbPath);
    return { ok: true };
  });

  // Where is this PCB used? Shown before deleting it.
  app.get<P>('/api/pcbs/:id/usage', async (req) => {
    const id = req.params.id;
    const [projects, connections] = await Promise.all([
      prisma.projectPcb.findMany({ where: { pcbId: id }, select: { project: { select: { id: true, name: true } } } }),
      prisma.connection.findMany({
        where: { nodes: { some: { pcbConnector: { pcbId: id } } } },
        select: { id: true, name: true, project: { select: { name: true } } },
      }),
    ]);
    return { projects: projects.map((p) => p.project), connections };
  });

  // ----- Connectors drawn on a PCB (autosaved by the editor via idempotent upsert) -----
  app.put<P>('/api/pcb-connectors/:id', async (req) => {
    const b = ConnectorBody.parse(req.body);
    const data = { ...b, connectorTypeId: b.connectorTypeId ?? null };
    return prisma.pcbConnector.upsert({
      where: { id: req.params.id },
      create: { id: req.params.id, ...data },
      update: data,
      include: { connectorType: true },
    });
  });

  app.delete<P>('/api/pcb-connectors/:id', async (req) => {
    await prisma.pcbConnector.deleteMany({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<P>('/api/pcb-connectors/:id/usage', async (req) => {
    const connections = await prisma.connection.findMany({
      where: { nodes: { some: { pcbConnectorId: req.params.id } } },
      select: { id: true, name: true },
    });
    return { connections };
  });
}
