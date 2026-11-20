import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { currentUser, need, type AuthUser } from './auth.js';
import { assertNotFrozen, assertUnlocked } from './freeze.js';
import { diffComponent, diffConnection, type ComponentSnapshot, type ConnectionSnapshot } from './historyDiff.js';
import { hiddenProjectIds } from './projectAccess.js';
import { capture, type RestoreState } from './revert.js';

/**
 * "Recent changes" of connections and components.
 *
 * The editors autosave, so a change is recorded per editing session: opening an editor asks for the
 * reason (POST /api/changes/start), which stores a snapshot. Every save then sends the session id in
 * the X-Change-Id header, and the entry's summary is recomputed from that snapshot. A change made
 * outside an editor (e.g. the "Edit component" form, deleting a connection) sends `reason` instead
 * and gets an entry of its own.
 */

export type EntityType = 'connection' | 'component' | 'project';
type Snapshot = ConnectionSnapshot | ComponentSnapshot;

export const ReasonSchema = z
  .string({ required_error: 'Give a reason for this change' })
  .trim()
  .min(3, 'Give a reason for this change (at least 3 characters)')
  .max(1000);

/** For users who may skip the reason (AuthUser.skipReason): one can still be given, but may be empty. */
const OptionalReasonSchema = z.string().trim().max(1000);

/** Validates the reason for a change by this user; an empty one is fine when they skip reasons. */
export function parseReason(user: AuthUser, value: unknown): string {
  return user.skipReason ? OptionalReasonSchema.parse(value ?? '') : ReasonSchema.parse(value ?? '');
}

const SESSION_IDLE_MS = 12 * 3600_000;

function httpError(statusCode: number, message: string, code?: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

// ---------- Snapshots ----------

const pinName = (pins: unknown, n: number) => {
  const p = Array.isArray(pins) ? (pins as { n?: number; name?: string }[]).find((x) => x.n === n) : undefined;
  return p?.name ? ` (${p.name})` : '';
};
const connectorName = (c: { label: string; name: string }) => [c.label, c.name].filter(Boolean).join(' · ') || 'connector';

export async function connectionSnapshot(id: string): Promise<(ConnectionSnapshot & { projectId: string }) | null> {
  const c = await prisma.connection.findUnique({
    where: { id },
    include: {
      nodes: {
        include: {
          pcbConnector: { select: { label: true, name: true, pins: true, pcb: { select: { name: true } } } },
          projectPcb: { select: { name: true } },
        },
      },
      wires: { include: { cable: { select: { name: true } } } },
    },
  });
  if (!c) return null;
  const nodeName = new Map<string, string>();
  const nodePins = new Map<string, unknown>();
  const nodes = c.nodes.map((n) => {
    const name = n.pcbConnector
      ? `${n.projectPcb?.name || n.pcbConnector.pcb.name}: ${connectorName(n.pcbConnector)}`
      : `${n.label || 'connector'} (free)`;
    nodeName.set(n.id, name);
    nodePins.set(n.id, n.pcbConnector?.pins);
    return { id: n.id, name, pinCount: n.pcbConnector ? 0 : n.pinCount };
  });
  const end = (nodeId: string, pin: number) => `${nodeName.get(nodeId) ?? '?'} pin ${pin}${pinName(nodePins.get(nodeId), pin)}`;
  const zones = Array.isArray(c.zones) ? (c.zones as { id?: string; name?: string }[]) : [];
  return {
    projectId: c.projectId,
    name: c.name,
    description: c.description,
    lengthMm: c.lengthMm,
    zones: zones.map((z) => ({ id: String(z.id ?? ''), name: String(z.name ?? '') })),
    nodes,
    wires: c.wires.map((w) => ({
      id: w.id,
      from: end(w.fromNodeId, w.fromPin),
      to: end(w.toNodeId, w.toPin),
      color: w.color,
      cable: w.cable ? `${w.cable.name}${w.coreIndex != null ? ` core ${w.coreIndex + 1}` : ''}` : '',
      lengthMm: w.lengthMm,
      gauge: w.gauge,
      shielded: w.shielded,
      note: w.note,
    })),
  };
}

export async function componentSnapshot(id: string): Promise<ComponentSnapshot | null> {
  const p = await prisma.pcb.findUnique({ where: { id }, include: { connectors: { include: { connectorType: true } } } });
  if (!p) return null;
  const r = (v: number) => v.toFixed(3);
  return {
    name: p.name,
    description: p.description,
    image: p.imagePath,
    connectors: p.connectors.map((c) => ({
      id: c.id,
      name: connectorName(c) === 'connector' ? '' : connectorName(c),
      type: c.connectorType?.name ?? '',
      rect: [c.x, c.y, c.w, c.h].map(r).join(','),
      pins: (Array.isArray(c.pins) ? (c.pins as { n: number; name?: string; color?: string; current?: number | null; role?: string }[]) : []).map((x) => ({
        n: x.n,
        name: x.name ?? '',
        color: x.color ?? '',
        ...(x.current != null ? { current: x.current } : {}),
        ...(x.role ? { role: x.role } : {}),
      })),
    })),
  };
}

function snapshot(type: 'connection' | 'component', id: string): Promise<Snapshot | null> {
  return type === 'connection' ? connectionSnapshot(id) : componentSnapshot(id);
}

function diff(type: 'connection' | 'component', a: Snapshot, b: Snapshot) {
  return type === 'connection'
    ? diffConnection(a as ConnectionSnapshot, b as ConnectionSnapshot)
    : diffComponent(a as ComponentSnapshot, b as ComponentSnapshot);
}

// ---------- Recording ----------

export async function logChange(
  user: AuthUser,
  entry: {
    projectId?: string | null;
    entityType: EntityType;
    entityId: string;
    entityName: string;
    action: string;
    reason?: string;
    summary?: string[];
    /** Rows before the change, to revert it (see revert.ts). */
    restore?: RestoreState | null;
  },
) {
  const { restore, ...rest } = entry;
  return prisma.changeLog.create({
    data: {
      ...rest,
      projectId: entry.projectId ?? null,
      reason: entry.reason ?? '',
      summary: entry.summary ?? [],
      userId: user.id,
      userName: user.name,
      ...restoreData(restore),
    },
  });
}

function restoreData(restore: RestoreState | null | undefined) {
  return restore ? { restore: restore as unknown as Prisma.InputJsonValue, revertable: true } : {};
}

/** The reason sent with a one-off change, in the query (DELETE) or the JSON body. */
export function reasonOf(req: FastifyRequest): string | undefined {
  const q = (req.query as Record<string, unknown> | undefined)?.reason;
  const b = (req.body as Record<string, unknown> | undefined)?.reason;
  const v = typeof q === 'string' ? q : typeof b === 'string' ? b : undefined;
  return v;
}

/** The reason for a one-off change; throws 400 if it is missing (unless the user skips reasons). */
export function requireReason(req: FastifyRequest, value = reasonOf(req)) {
  return parseReason(currentUser(req), value);
}

/** Checks that permission and lock state allow editing the item, and returns where it belongs. */
async function checkEditable(req: FastifyRequest, type: 'connection' | 'component', id: string) {
  if (type === 'connection') {
    need(req, 'projects.edit');
    const c = await prisma.connection.findUniqueOrThrow({ where: { id }, select: { projectId: true, name: true } });
    await assertUnlocked(c.projectId);
    return { projectId: c.projectId, name: c.name };
  }
  need(req, 'library.edit');
  const p = await prisma.pcb.findUniqueOrThrow({ where: { id } });
  assertNotFrozen(p);
  return { projectId: null, name: p.name };
}

/**
 * Runs a change to a connection or component and records it: in the editing session named by the
 * X-Change-Id header, or as its own entry with `reason`. Without either, nothing is changed (428).
 */
export async function recordEdit<T>(
  req: FastifyRequest,
  type: 'connection' | 'component',
  id: string,
  reason: string | undefined,
  change: () => Promise<T>,
): Promise<T> {
  const user = currentUser(req);
  const sessionId = req.headers['x-change-id'];
  if (typeof sessionId === 'string' && sessionId) {
    const entry = await prisma.changeLog.findUnique({ where: { id: sessionId } });
    const valid =
      entry &&
      entry.userId === user.id &&
      entry.entityType === type &&
      entry.entityId === id &&
      entry.action === 'edit' &&
      entry.before !== null &&
      Date.now() - entry.updatedAt.getTime() < SESSION_IDLE_MS;
    if (!valid) {
      throw httpError(428, 'Your editing session has ended. Reload the page and give a reason to continue editing.', 'EDIT_SESSION');
    }
    const result = await change();
    const after = await snapshot(type, id);
    if (after) {
      await prisma.changeLog.update({
        where: { id: entry.id },
        data: { summary: diff(type, entry.before as unknown as Snapshot, after), entityName: after.name },
      });
    }
    return result;
  }

  if (reason === undefined && !user.skipReason) {
    throw httpError(428, 'Give a reason for this change.', 'REASON_REQUIRED');
  }
  const why = parseReason(user, reason);
  const before = await snapshot(type, id);
  const restore = await capture(type, id);
  const result = await change();
  const after = await snapshot(type, id);
  if (before && after) {
    const summary = diff(type, before, after);
    if (summary.length) {
      const projectId = type === 'connection' ? (after as ConnectionSnapshot & { projectId: string }).projectId : null;
      await logChange(user, { projectId, entityType: type, entityId: id, entityName: after.name, action: 'edit', reason: why, summary, restore });
    }
  }
  return result;
}

// ---------- Routes ----------

const ListQuery = z.object({
  entityType: z.enum(['connection', 'component', 'project']).optional(),
  entityId: z.string().optional(),
  projectId: z.string().optional(),
  /** Entries changed before this time (paging). */
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export default async function historyRoutes(app: FastifyInstance) {
  // Opens an editing session: the reason is asked once, every autosave until the editor is left
  // is recorded in this entry.
  app.post('/api/changes/start', async (req, reply) => {
    const user = currentUser(req);
    const body = z
      .object({ entityType: z.enum(['connection', 'component']), entityId: z.string().min(1), reason: z.unknown() })
      .parse(req.body);
    const reason = parseReason(user, body.reason);
    const { projectId } = await checkEditable(req, body.entityType, body.entityId);
    const before = await snapshot(body.entityType, body.entityId);
    if (!before) return reply.code(404).send({ message: 'Not found' });
    // Sessions in which nothing was changed are not history.
    await prisma.changeLog.deleteMany({
      where: { action: 'edit', summary: { isEmpty: true }, updatedAt: { lt: new Date(Date.now() - SESSION_IDLE_MS) } },
    });
    const entry = await prisma.changeLog.create({
      data: {
        userId: user.id,
        userName: user.name,
        projectId,
        entityType: body.entityType,
        entityId: body.entityId,
        entityName: before.name,
        action: 'edit',
        reason,
        before: before as unknown as Prisma.InputJsonValue,
        ...restoreData(await capture(body.entityType, body.entityId)),
      },
    });
    return reply.code(201).send({ id: entry.id, reason: entry.reason });
  });

  // Latest reason this user gave for the item, to suggest when they open the editor again.
  app.get<{ Querystring: { entityType?: string; entityId?: string } }>('/api/changes/last-reason', async (req) => {
    const user = currentUser(req);
    const last = await prisma.changeLog.findFirst({
      where: { userId: user.id, entityType: req.query.entityType, entityId: req.query.entityId, action: 'edit' },
      orderBy: { createdAt: 'desc' },
      select: { reason: true, createdAt: true },
    });
    return { reason: last?.reason ?? '', at: last?.createdAt ?? null };
  });

  app.get('/api/changes', async (req) => {
    currentUser(req);
    const q = ListQuery.parse(req.query);
    const where: Prisma.ChangeLogWhereInput = {
      // Editing sessions in which nothing changed (yet) are not shown.
      OR: [{ action: { not: 'edit' } }, { summary: { isEmpty: false } }],
      ...(q.before ? { updatedAt: { lt: new Date(q.before) } } : {}),
    };
    const and: Prisma.ChangeLogWhereInput[] = [];
    const hidden = [...(await hiddenProjectIds(req))];
    if (hidden.length) and.push({ OR: [{ projectId: null }, { projectId: { notIn: hidden } }] });
    if (q.entityType) and.push({ entityType: q.entityType });
    if (q.entityId) and.push({ entityId: q.entityId });
    if (q.projectId) {
      // A project's history includes changes to the library components placed in it.
      const placed = await prisma.projectPcb.findMany({ where: { projectId: q.projectId }, select: { pcbId: true }, distinct: ['pcbId'] });
      const pcbIds = placed.map((p) => p.pcbId);
      const frozen = await prisma.pcb.findMany({ where: { id: { in: pcbIds }, sourceId: { not: null } }, select: { sourceId: true } });
      and.push({
        OR: [
          { projectId: q.projectId },
          { entityType: 'component', entityId: { in: [...pcbIds, ...frozen.map((f) => f.sourceId!)] } },
        ],
      });
    }
    const items = await prisma.changeLog.findMany({
      where: { ...where, AND: and },
      orderBy: { updatedAt: 'desc' },
      take: q.limit + 1,
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        userName: true,
        projectId: true,
        entityType: true,
        entityId: true,
        entityName: true,
        action: true,
        reason: true,
        summary: true,
        revertable: true,
      },
    });
    const more = items.length > q.limit;
    const page = items.slice(0, q.limit);
    return { items: page, nextBefore: more ? page[page.length - 1].updatedAt.toISOString() : null };
  });
}
