import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { deleteFiles, readMultipart, saveImage } from '../storage.js';

const Fields = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  pinCount: z.coerce.number().int().min(1).max(500),
  rowCount: z.coerce.number().int().min(1).max(20).default(1),
  crimpName: z.string().default(''),
  removeImage: z.string().optional(),
});

type P = { Params: { id: string } };

export default async function connectorTypeRoutes(app: FastifyInstance) {
  app.get('/api/connector-types', async () =>
    prisma.connectorType.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { instances: true } } },
    }),
  );

  app.post('/api/connector-types', async (req, reply) => {
    const { fields, file } = await readMultipart(req);
    const { removeImage: _ignored, ...data } = Fields.parse(fields);
    const img = file ? await saveImage(file) : null;
    const type = await prisma.connectorType.create({
      data: { ...data, imagePath: img?.imagePath ?? null, thumbPath: img?.thumbPath ?? null },
    });
    return reply.code(201).send(type);
  });

  app.put<P>('/api/connector-types/:id', async (req) => {
    const existing = await prisma.connectorType.findUniqueOrThrow({ where: { id: req.params.id } });
    const { fields, file } = await readMultipart(req);
    const { removeImage, ...data } = Fields.parse(fields);
    const img = file ? await saveImage(file) : null;
    const dropImage = !!img || removeImage === 'true';
    const type = await prisma.connectorType.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(dropImage ? { imagePath: img?.imagePath ?? null, thumbPath: img?.thumbPath ?? null } : {}),
      },
    });
    if (dropImage) await deleteFiles(existing.imagePath, existing.thumbPath);
    return type;
  });

  app.delete<P>('/api/connector-types/:id', async (req) => {
    const type = await prisma.connectorType.delete({ where: { id: req.params.id } });
    await deleteFiles(type.imagePath, type.thumbPath);
    return { ok: true };
  });
}
