import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { UPLOAD_DIR } from './storage.js';
import { linkLegacyNodes } from './db.js';
import projectRoutes from './routes/projects.js';
import pcbRoutes from './routes/pcbs.js';
import connectorTypeRoutes from './routes/connectorTypes.js';
import cableRoutes from './routes/cables.js';
import connectionRoutes from './routes/connections.js';
import mapRoutes from './routes/map.js';
import backupRoutes from './routes/backup.js';

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR ?? 'public');

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

app.setErrorHandler((err: any, req, reply) => {
  if (err instanceof ZodError) {
    return reply
      .code(400)
      .send({ message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') return reply.code(404).send({ message: 'Not found' });
    if (err.code === 'P2003') return reply.code(400).send({ message: 'A referenced item no longer exists' });
  }
  const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 500) req.log.error(err);
  return reply.code(status).send({ message: err?.message ?? 'Server error' });
});

await app.register(multipart, { limits: { fileSize: 40 * 1024 * 1024, files: 1, fields: 30 } });

// Uploaded images (file names are UUIDs and never reused, so they can be cached forever).
await app.register(fastifyStatic, {
  root: UPLOAD_DIR,
  prefix: '/uploads/',
  decorateReply: false,
  maxAge: '365d',
  immutable: true,
});

app.get('/api/health', async () => ({ ok: true }));

await app.register(projectRoutes);
await app.register(pcbRoutes);
await app.register(connectorTypeRoutes);
await app.register(cableRoutes);
await app.register(connectionRoutes);
await app.register(mapRoutes);
await app.register(backupRoutes);

// Built frontend (present in the Docker image; in development Vite serves it).
const hasWeb = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
if (hasWeb) {
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', wildcard: false });
}

app.setNotFoundHandler((req, reply) => {
  const isApi = req.url.startsWith('/api') || req.url.startsWith('/uploads');
  if (hasWeb && req.method === 'GET' && !isApi) {
    // Single-page app: let the client router handle the path.
    return reply.type('text/html').sendFile('index.html');
  }
  return reply.code(404).send({ message: 'Not found' });
});

const linked = await linkLegacyNodes();
if (linked) app.log.info(`Linked ${linked} connection node(s) to their component placement`);

await app.listen({ port: PORT, host: '0.0.0.0' });
