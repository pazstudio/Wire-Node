/**
 * Restricted projects: a project marked `restricted` can only be seen by its members (ProjectMember)
 * and by admins, e.g. a contractor's own project. Everyone else gets "Not found" for it and for
 * everything in it (connections, placements, folders, units, comments, history).
 *
 * One hook finds which project a request is about (from the route and its parameters); list routes
 * filter with hiddenProjectIds().
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';
import { need, type AuthUser } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    hiddenProjects?: Promise<Set<string>>;
  }
}

/** Ids of the projects the user may not see (cached per request). */
export function hiddenProjectIds(req: FastifyRequest): Promise<Set<string>> {
  if (!req.hiddenProjects) req.hiddenProjects = computeHidden(req.user);
  return req.hiddenProjects;
}

async function computeHidden(user: AuthUser | undefined): Promise<Set<string>> {
  if (!user || user.isAdmin) return new Set();
  const rows = await prisma.project.findMany({
    where: { restricted: true, members: { none: { userId: user.id } } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

const notFound = () => Object.assign(new Error('Not found'), { statusCode: 404 });

/** The project(s) a request is about, or [] when it is not about one project. */
async function projectsOf(req: FastifyRequest): Promise<(string | null | undefined)[]> {
  const url = req.routeOptions?.url ?? '';
  const p = (req.params ?? {}) as Record<string, string>;
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const id = p.id;
  if (url.startsWith('/api/projects/:id')) return [id, p.other];
  if (url.startsWith('/api/connections/:id')) return [(await prisma.connection.findUnique({ where: { id }, select: { projectId: true } }))?.projectId];
  if (url.startsWith('/api/project-pcbs/:id')) return [(await prisma.projectPcb.findUnique({ where: { id }, select: { projectId: true } }))?.projectId];
  if (url.startsWith('/api/folders/:id')) return [(await prisma.folder.findUnique({ where: { id }, select: { projectId: true } }))?.projectId];
  if (url.startsWith('/api/units/:id')) return [(await prisma.unit.findUnique({ where: { id }, select: { projectId: true } }))?.projectId];
  if (url.startsWith('/api/zones/:id')) return [(await prisma.zone.findUnique({ where: { id }, select: { projectId: true } }))?.projectId];
  if (url.startsWith('/api/pcbs/:id')) return [(await prisma.pcb.findUnique({ where: { id }, select: { frozenInProjectId: true } }))?.frozenInProjectId];
  if (url.startsWith('/api/changes/:id')) return [(await prisma.changeLog.findUnique({ where: { id }, select: { projectId: true } }))?.projectId];
  if (url.startsWith('/api/comments/:id')) return [(await prisma.comment.findUnique({ where: { id }, select: { projectId: true } }))?.projectId];
  if (url === '/api/comments' || url === '/api/changes' || url === '/api/pcb-connectors/:id/usage') {
    const src = req.method === 'POST' ? ((req.body ?? {}) as Record<string, string | undefined>) : q;
    return [src.projectId, await entityProject(src.entityType, src.entityId)];
  }
  if (url === '/api/changes/start') {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    return [await entityProject(b.entityType, b.entityId)];
  }
  return [];
}

/** Project of a connection, unit or project id (components are shared, so none). */
async function entityProject(type: string | undefined, id: string | undefined) {
  if (!id || typeof id !== 'string') return null;
  if (type === 'connection' || type === undefined) {
    const c = await prisma.connection.findUnique({ where: { id }, select: { projectId: true } });
    if (c || type === 'connection') return c?.projectId;
  }
  if (type === 'unit') return (await prisma.unit.findUnique({ where: { id }, select: { projectId: true } }))?.projectId;
  if (type === 'project') return id;
  return null;
}

export async function registerProjectAccess(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    if (!req.user || req.user.isAdmin || !req.url.startsWith('/api/')) return;
    const hidden = await hiddenProjectIds(req);
    if (!hidden.size) return;
    for (const pid of await projectsOf(req)) if (pid && hidden.has(pid)) throw notFound();
  });
}

/** Who can see a project: restricted or not, and its members. */
export async function accessRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/projects/:id/access', async (req) => {
    need(req, 'users.manage');
    const project = await prisma.project.findUniqueOrThrow({ where: { id: req.params.id }, select: { restricted: true } });
    const members = await prisma.projectMember.findMany({ where: { projectId: req.params.id }, select: { userId: true } });
    return { restricted: project.restricted, userIds: members.map((m) => m.userId) };
  });

  app.put<{ Params: { id: string } }>('/api/projects/:id/access', async (req) => {
    need(req, 'users.manage');
    const b = z.object({ restricted: z.boolean(), userIds: z.array(z.string()).max(1000) }).parse(req.body);
    const projectId = req.params.id;
    const users = await prisma.user.findMany({ where: { id: { in: b.userIds } }, select: { id: true } });
    await prisma.$transaction([
      prisma.project.update({ where: { id: projectId }, data: { restricted: b.restricted } }),
      prisma.projectMember.deleteMany({ where: { projectId } }),
      prisma.projectMember.createMany({ data: users.map((u) => ({ projectId, userId: u.id })) }),
    ]);
    return { restricted: b.restricted, userIds: users.map((u) => u.id) };
  });
}
