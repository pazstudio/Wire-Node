import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { can, currentUser, need } from '../auth.js';
import { UPLOAD_DIR, deleteFiles } from '../storage.js';
import { assertNotFrozen } from '../freeze.js';
import { notify } from '../notify.js';
import { hiddenProjectIds } from '../projectAccess.js';

type P = { Params: { id: string } };

const EntityType = z.enum(['connection', 'component', 'project', 'unit']);

const forbidden = (message: string) => Object.assign(new Error(message), { statusCode: 403 });

/** Usernames mentioned as @name that exist (lower case). */
async function mentionsIn(body: string): Promise<string[]> {
  const names = [...new Set([...body.matchAll(/(^|[^\w@.])@([a-z0-9._-]{2,40})/gi)].map((m) => m[2].toLowerCase()))];
  if (!names.length) return [];
  const users = await prisma.user.findMany({ where: { username: { in: names }, disabled: false }, select: { username: true } });
  return users.map((u) => u.username);
}

/**
 * Comments on connections, components and projects, e.g. "J3 cracked on unit #3, use the spare".
 * Anyone signed in can comment; a comment can be edited or deleted by its author (or an admin),
 * and resolved by anyone who can edit projects.
 */
export default async function commentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { entityType?: string; entityId?: string; projectId?: string } }>('/api/comments', async (req) => {
    const q = z
      .object({ entityType: EntityType.optional(), entityId: z.string().optional(), projectId: z.string().optional() })
      .parse(req.query);
    if (!q.entityId && !q.projectId) throw Object.assign(new Error('entityId or projectId is required'), { statusCode: 400 });
    // Components are shared: their comments show in every project (projectId only says where it was written).
    const where = q.entityId
      ? { entityId: q.entityId, ...(q.entityType ? { entityType: q.entityType } : {}) }
      : { projectId: q.projectId };
    const hidden = [...(await hiddenProjectIds(req))];
    const visible = hidden.length ? { OR: [{ projectId: null }, { projectId: { notIn: hidden } }] } : {};
    return prisma.comment.findMany({ where: { ...where, ...visible }, orderBy: { createdAt: 'asc' }, take: 1000 });
  });

  // Open comments that mention the signed-in user, newest first.
  app.get('/api/comments/mentions', async (req) => {
    const user = currentUser(req);
    const hidden = [...(await hiddenProjectIds(req))];
    const rows = await prisma.comment.findMany({
      where: { mentions: { has: user.username }, resolvedAt: null, ...(hidden.length ? { OR: [{ projectId: null }, { projectId: { notIn: hidden } }] } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // Names of what they are on, for the list.
    const ids = (t: string) => rows.filter((r) => r.entityType === t).map((r) => r.entityId);
    const [conns, pcbs, projects, units] = await Promise.all([
      prisma.connection.findMany({ where: { id: { in: ids('connection') } }, select: { id: true, name: true, projectId: true } }),
      prisma.pcb.findMany({ where: { id: { in: ids('component') } }, select: { id: true, name: true } }),
      prisma.project.findMany({ where: { id: { in: [...ids('project'), ...rows.map((r) => r.projectId ?? '')] } }, select: { id: true, name: true } }),
      prisma.unit.findMany({ where: { id: { in: ids('unit') } }, select: { id: true, serial: true } }),
    ]);
    const name = new Map<string, string>([...conns, ...pcbs, ...projects, ...units.map((u) => ({ id: u.id, name: `Unit ${u.serial}` }))].map((x) => [x.id, x.name]));
    const connProject = new Map(conns.map((c) => [c.id, c.projectId]));
    return rows.map((r) => ({
      ...r,
      entityName: name.get(r.entityId) ?? '(deleted)',
      projectName: r.projectId ? (name.get(r.projectId) ?? '') : '',
      projectId: r.projectId ?? connProject.get(r.entityId) ?? null,
    }));
  });

  app.post('/api/comments', async (req, reply) => {
    const user = currentUser(req);
    const b = z
      .object({
        entityType: EntityType,
        entityId: z.string().min(1),
        projectId: z.string().nullable().default(null),
        body: z.string().trim().min(1, 'Write something first').max(5000),
      })
      .parse(req.body);
    // The item must exist.
    let on = '';
    let path = '';
    if (b.entityType === 'connection') {
      const c = await prisma.connection.findUniqueOrThrow({ where: { id: b.entityId }, select: { projectId: true, name: true } });
      b.projectId = c.projectId;
      on = `connection "${c.name}"`;
      path = `/projects/${c.projectId}/connections/${b.entityId}`;
    } else if (b.entityType === 'component') {
      const p = await prisma.pcb.findUniqueOrThrow({ where: { id: b.entityId } });
      on = `component "${p.name}"`;
      path = b.projectId ? `/projects/${b.projectId}/pcbs/${p.id}` : '';
    } else if (b.entityType === 'unit') {
      const u = await prisma.unit.findUniqueOrThrow({ where: { id: b.entityId } });
      b.projectId = u.projectId;
      on = `unit ${u.serial}`;
      path = `/projects/${u.projectId}?tab=build&view=units`;
    } else {
      const p = await prisma.project.findUniqueOrThrow({ where: { id: b.entityId } });
      b.projectId = b.entityId;
      on = `project "${p.name}"`;
      path = `/projects/${p.id}?tab=history`;
    }
    const mentions = await mentionsIn(b.body);
    const comment = await prisma.comment.create({ data: { ...b, userId: user.id, userName: user.name, mentions } });
    const excerpt = b.body.length > 300 ? `${b.body.slice(0, 300)}…` : b.body;
    if (mentions.length) notify('mentions', `💬 ${user.name} mentioned ${mentions.map((m) => `@${m}`).join(', ')} on ${on}: ${excerpt}`, path, req.log);
    else notify('comments', `💬 ${user.name} commented on ${on}: ${excerpt}`, path, req.log);
    return reply.code(201).send(comment);
  });

  app.patch<P>('/api/comments/:id', async (req) => {
    const user = currentUser(req);
    const b = z.object({ body: z.string().trim().min(1).max(5000), resolved: z.boolean() }).partial().parse(req.body);
    const c = await prisma.comment.findUniqueOrThrow({ where: { id: req.params.id } });
    const own = c.userId === user.id;
    if (b.body !== undefined && !own && !user.isAdmin) throw forbidden('Only the author can edit a comment');
    if (b.resolved !== undefined && !own && !can(user, 'projects.edit')) throw forbidden('You cannot resolve comments');
    return prisma.comment.update({
      where: { id: c.id },
      data: {
        ...(b.body !== undefined ? { body: b.body, mentions: await mentionsIn(b.body) } : {}),
        ...(b.resolved !== undefined ? { resolvedAt: b.resolved ? new Date() : null, resolvedBy: b.resolved ? user.name : null } : {}),
      },
    });
  });

  app.delete<P>('/api/comments/:id', async (req) => {
    const user = currentUser(req);
    const c = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!c) return { ok: true };
    if (c.userId !== user.id && !user.isAdmin) throw forbidden('Only the author can delete a comment');
    await prisma.comment.delete({ where: { id: c.id } });
    return { ok: true };
  });

  // Usernames for @mention autocomplete.
  app.get('/api/users/names', async () =>
    prisma.user.findMany({ where: { disabled: false }, select: { username: true, displayName: true }, orderBy: { username: 'asc' } }),
  );

  // ---------- Attachments on library components ----------

  /** Attachments of a component; a frozen copy (locked project) shows those of its library component too. */
  app.get<P>('/api/pcbs/:id/attachments', async (req) => {
    const pcb = await prisma.pcb.findUniqueOrThrow({ where: { id: req.params.id }, select: { id: true, sourceId: true } });
    return prisma.attachment.findMany({
      where: { pcbId: { in: [pcb.id, pcb.sourceId].filter((x): x is string => !!x) } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post<P>('/api/pcbs/:id/attachments', async (req, reply) => {
    const user = need(req, 'library.edit');
    const pcb = await prisma.pcb.findUniqueOrThrow({ where: { id: req.params.id } });
    assertNotFrozen(pcb);
    const part = await req.file();
    if (!part) throw Object.assign(new Error('No file was uploaded'), { statusCode: 400 });
    const buf = await part.toBuffer();
    if (part.file.truncated) throw Object.assign(new Error('The file is too large (max 40 MB)'), { statusCode: 413 });
    if (!buf.length) throw Object.assign(new Error('The file is empty'), { statusCode: 400 });
    // Stored without its extension, so the static /uploads/ route never serves it as a page.
    const storedPath = `${randomUUID()}.att`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, storedPath), buf);
    const fileName = path.basename(part.filename || 'file').slice(0, 200);
    const att = await prisma.attachment.create({
      data: { pcbId: pcb.id, fileName, storedPath, mimeType: part.mimetype || 'application/octet-stream', size: buf.length, uploadedBy: user.name },
    });
    return reply.code(201).send(att);
  });

  // Downloads (or, for PDFs and pictures, shows) an attachment.
  app.get<P & { Querystring: { download?: string } }>('/api/attachments/:id', async (req, reply) => {
    const a = await prisma.attachment.findUniqueOrThrow({ where: { id: req.params.id } });
    const file = path.join(UPLOAD_DIR, path.basename(a.storedPath));
    if (!fs.existsSync(file)) return reply.code(404).send({ message: 'The file is missing on the server' });
    const inlineSafe = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(a.mimeType) && req.query.download !== '1';
    const encoded = encodeURIComponent(a.fileName);
    const ascii = a.fileName.replace(/[^\x20-\x7e]|"/g, '_');
    reply
      .header('Content-Type', inlineSafe ? a.mimeType : 'application/octet-stream')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', `${inlineSafe ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`);
    return reply.send(fs.createReadStream(file));
  });

  app.delete<P>('/api/attachments/:id', async (req) => {
    need(req, 'library.edit');
    const a = await prisma.attachment.findUnique({ where: { id: req.params.id }, include: { pcb: true } });
    if (!a) return { ok: true };
    assertNotFrozen(a.pcb);
    await prisma.attachment.delete({ where: { id: a.id } });
    await deleteFiles(a.storedPath);
    return { ok: true };
  });
}
