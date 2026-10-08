import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const CableBody = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().default(''),
  coreCount: z.number().int().min(1).max(200),
  cores: z.array(z.object({ color: z.string().default('') })).default([]),
  shielded: z.boolean().default(false),
  gauge: z.string().default(''),
  lengthMm: z.number().nonnegative().nullable().default(null),
});

type P = { Params: { id: string } };

function normalize(body: unknown) {
  const b = CableBody.parse(body);
  // Keep exactly one core entry per core.
  const cores = Array.from({ length: b.coreCount }, (_, i) => ({ color: b.cores[i]?.color ?? '' }));
  return { ...b, cores };
}

export default async function cableRoutes(app: FastifyInstance) {
  app.get('/api/cables', async () =>
    prisma.cable.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { wires: true } } } }),
  );

  app.post('/api/cables', async (req, reply) => {
    const cable = await prisma.cable.create({ data: normalize(req.body) });
    return reply.code(201).send(cable);
  });

  app.put<P>('/api/cables/:id', async (req) =>
    prisma.cable.update({ where: { id: req.params.id }, data: normalize(req.body) }),
  );

  app.delete<P>('/api/cables/:id', async (req) => {
    await prisma.cable.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}
