import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { currentUser, need } from './auth.js';
import { assertUnlocked } from './freeze.js';
import { UPLOAD_DIR } from './storage.js';
import { componentSnapshot, connectionSnapshot, parseReason } from './history.js';
import { diffComponent, diffConnection } from './historyDiff.js';

/**
 * Reverting a change from the history: the item goes back to how it was before that change.
 * Changes made to it later are undone as well (the dialog lists them first). A revert is a change
 * of its own, recorded with a reason, so it can be reverted too.
 *
 * Revertable: connection edits, deleted connections, component edits (connectors, name,
 * description, picture). Deleting a project or a library component cascades too far to undo
 * safely; a backup is the way back from those.
 */

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

/** Database rows of a connection, enough to rebuild it. */
export interface ConnectionState {
  kind: 'connection';
  connection: Row;
  nodes: Row[];
  wires: Row[];
}

/** Database rows of a library component and the connectors drawn on it. */
export interface ComponentState {
  kind: 'component';
  pcb: Row;
  connectors: Row[];
}

export type RestoreState = ConnectionState | ComponentState;

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Row;

export async function captureConnection(id: string, db: Tx | typeof prisma = prisma): Promise<ConnectionState | null> {
  const c = await db.connection.findUnique({ where: { id }, include: { nodes: true, wires: true } });
  if (!c) return null;
  const { nodes, wires, ...connection } = c;
  return { kind: 'connection', connection: json(connection), nodes: nodes.map(json), wires: wires.map(json) };
}

export async function captureComponent(id: string, db: Tx | typeof prisma = prisma): Promise<ComponentState | null> {
  const p = await db.pcb.findUnique({ where: { id }, include: { connectors: true } });
  if (!p) return null;
  const { connectors, ...pcb } = p;
  return { kind: 'component', pcb: json(pcb), connectors: connectors.map(json) };
}

export function capture(type: 'connection' | 'component', id: string) {
  return type === 'connection' ? captureConnection(id) : captureComponent(id);
}

/** Picture files referenced by restore states (kept when a picture is replaced, and put in backups). */
export function restoreFiles(history: { restore?: unknown }[]): string[] {
  const names = new Set<string>();
  for (const h of history) {
    const r = h.restore as Partial<ComponentState> | null | undefined;
    if (r?.kind !== 'component' || !r.pcb) continue;
    for (const key of ['imagePath', 'thumbPath']) {
      const v = r.pcb[key];
      if (typeof v === 'string' && v) names.add(path.basename(v));
    }
  }
  return [...names];
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const ids = <T extends { id: string }>(rows: T[]) => new Set(rows.map((r) => r.id));

// ---------- Connection ----------

/** Rebuilds a connection from its rows. Returns notes on what could not be restored. */
async function restoreConnection(tx: Tx, state: ConnectionState, dryRun: boolean) {
  const notes: string[] = [];
  const c = state.connection;
  const id = String(c.id);
  const projectId = String(c.projectId);
  if (!(await tx.project.findUnique({ where: { id: projectId } }))) {
    throw httpError(409, 'The project of this connection no longer exists');
  }

  // Things the old diagram points at may have been deleted since.
  const [connectors, placements, types, cables, folder] = await Promise.all([
    tx.pcbConnector.findMany({ where: { id: { in: state.nodes.map((n) => str(n.pcbConnectorId)).filter((x): x is string => !!x) } }, select: { id: true } }),
    tx.projectPcb.findMany({ where: { projectId }, select: { id: true } }),
    tx.connectorType.findMany({ where: { id: { in: state.nodes.map((n) => str(n.connectorTypeId)).filter((x): x is string => !!x) } }, select: { id: true } }),
    tx.cable.findMany({ where: { id: { in: state.wires.map((w) => str(w.cableId)).filter((x): x is string => !!x) } }, select: { id: true } }),
    str(c.folderId) ? tx.folder.findUnique({ where: { id: str(c.folderId)! } }) : null,
  ]);
  const connectorIds = ids(connectors);
  const placementIds = ids(placements);
  const typeIds = ids(types);
  const cableIds = ids(cables);

  const nodes = state.nodes.filter((n) => {
    const conn = str(n.pcbConnectorId);
    const pl = str(n.projectPcbId);
    const keep = (!conn || connectorIds.has(conn)) && (!pl || placementIds.has(pl));
    if (!keep) notes.push(`Connector ${str(n.label) || ''} could not be restored: its component was removed or changed`.replace('  ', ' '));
    return keep;
  });
  const nodeIds = new Set(nodes.map((n) => String(n.id)));
  const wires = state.wires.filter((w) => nodeIds.has(String(w.fromNodeId)) && nodeIds.has(String(w.toNodeId)));
  if (wires.length < state.wires.length) notes.push(`${state.wires.length - wires.length} wire(s) could not be restored with it`);
  if (state.wires.some((w) => str(w.cableId) && !cableIds.has(str(w.cableId)!))) notes.push('A cable that was deleted since is no longer linked');
  if (dryRun) return notes;

  const data = {
    name: String(c.name),
    description: String(c.description ?? ''),
    kind: String(c.kind ?? 'direct'),
    lengthMm: (c.lengthMm as number | null) ?? null,
    placementIds: ((c.placementIds as string[]) ?? []).filter((p) => placementIds.has(p)),
    zones: (c.zones ?? []) as Prisma.InputJsonValue,
    folderId: folder ? folder.id : null,
  };
  const exists = await tx.connection.findUnique({ where: { id } });
  if (exists) {
    await tx.wire.deleteMany({ where: { connectionId: id } });
    await tx.connectionNode.deleteMany({ where: { connectionId: id } });
    await tx.connection.update({ where: { id }, data });
  } else {
    await tx.connection.create({ data: { ...data, id, projectId, createdAt: str(c.createdAt) ?? undefined } });
  }
  await tx.connectionNode.createMany({
    data: nodes.map((n) => ({
      ...(n as any),
      connectionId: id,
      connectorTypeId: str(n.connectorTypeId) && typeIds.has(str(n.connectorTypeId)!) ? n.connectorTypeId : null,
    })),
  });
  await tx.wire.createMany({
    data: wires.map((w) => ({
      ...(w as any),
      connectionId: id,
      cableId: str(w.cableId) && cableIds.has(str(w.cableId)!) ? w.cableId : null,
      coreIndex: str(w.cableId) && cableIds.has(str(w.cableId)!) ? w.coreIndex : null,
    })),
  });
  return notes;
}

// ---------- Component ----------

async function restoreComponent(tx: Tx, state: ComponentState, dryRun: boolean) {
  const notes: string[] = [];
  const p = state.pcb;
  const id = String(p.id);
  const current = await tx.pcb.findUnique({ where: { id }, include: { connectors: { select: { id: true, label: true, name: true } } } });
  if (!current) throw httpError(409, 'This component was deleted from the library; restore it from a backup instead');
  if (current.frozenInProjectId) throw httpError(409, 'This is the frozen copy kept by a locked project');

  // Connectors added since are removed; wires on them in connections go with them.
  const keepIds = new Set(state.connectors.map((c) => String(c.id)));
  const removed = current.connectors.filter((c) => !keepIds.has(c.id));
  if (removed.length) {
    const wired = await tx.connection.findMany({
      where: { nodes: { some: { pcbConnectorId: { in: removed.map((r) => r.id) } } } },
      select: { name: true, project: { select: { name: true } } },
    });
    if (wired.length) {
      notes.push(
        `Connectors added since (${removed.map((r) => [r.label, r.name].filter(Boolean).join(' ') || 'unnamed').join(', ')}) are removed, ` +
          `with their wires in: ${wired.map((w) => `${w.name} (${w.project.name})`).join(', ')}`,
      );
    }
  }

  const name = String(p.name);
  const clash = await tx.pcb.findFirst({
    where: { frozenInProjectId: null, name: { equals: name, mode: 'insensitive' }, NOT: { id } },
  });
  if (clash) notes.push(`The name "${name}" is now used by another component, so the current name is kept`);

  const image = str(p.imagePath);
  const pictureBack = image !== current.imagePath && !!image && fs.existsSync(path.join(UPLOAD_DIR, path.basename(image)));
  if (image !== current.imagePath && !pictureBack) notes.push('The old picture is no longer stored, so the current picture is kept');

  const types = await tx.connectorType.findMany({
    where: { id: { in: state.connectors.map((c) => str(c.connectorTypeId)).filter((x): x is string => !!x) } },
    select: { id: true },
  });
  const typeIds = ids(types);
  if (dryRun) return notes;

  await tx.pcb.update({
    where: { id },
    data: {
      ...(clash ? {} : { name }),
      description: String(p.description ?? ''),
      ...(pictureBack
        ? { imagePath: image!, thumbPath: String(p.thumbPath), imageWidth: Number(p.imageWidth), imageHeight: Number(p.imageHeight) }
        : {}),
    },
  });
  await tx.pcbConnector.deleteMany({ where: { pcbId: id, id: { notIn: [...keepIds] } } });
  for (const c of state.connectors) {
    const data = {
      pcbId: id,
      connectorTypeId: str(c.connectorTypeId) && typeIds.has(str(c.connectorTypeId)!) ? str(c.connectorTypeId) : null,
      label: String(c.label ?? ''),
      name: String(c.name ?? ''),
      x: Number(c.x),
      y: Number(c.y),
      w: Number(c.w),
      h: Number(c.h),
      rotation: Number(c.rotation ?? 0),
      pins: (c.pins ?? []) as Prisma.InputJsonValue,
      sourceId: str(c.sourceId),
    };
    await tx.pcbConnector.upsert({ where: { id: String(c.id) }, create: { id: String(c.id), ...data }, update: data });
  }
  return notes;
}

// ---------- Routes ----------

async function loadRevertable(id: string) {
  const entry = await prisma.changeLog.findUniqueOrThrow({ where: { id } });
  const state = entry.restore as unknown as RestoreState | null;
  if (!entry.revertable || !state || (entry.entityType !== 'connection' && entry.entityType !== 'component')) {
    throw httpError(400, 'This change cannot be reverted');
  }
  if (state.kind === 'connection') await assertUnlocked(String(state.connection.projectId));
  return { entry, state };
}

/** Changes to the same item after this one (they are undone too). */
async function laterChanges(entry: { entityType: string; entityId: string; createdAt: Date; id: string }) {
  return prisma.changeLog.findMany({
    where: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      createdAt: { gt: entry.createdAt },
      NOT: { id: entry.id },
      // Placing a component in a project does not change the component itself, and editing
      // sessions in which nothing was changed are not changes.
      action: { notIn: ['place', 'remove'] },
      OR: [{ action: { not: 'edit' } }, { summary: { isEmpty: false } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, updatedAt: true, userName: true, action: true, reason: true },
  });
}

export default async function revertRoutes(app: FastifyInstance) {
  // What reverting would do: later changes that are undone as well, and what cannot be restored.
  app.get<{ Params: { id: string } }>('/api/changes/:id/revert', async (req) => {
    need(req, 'history.revert');
    const { entry, state } = await loadRevertable(req.params.id);
    const notes = await prisma.$transaction((tx) =>
      state.kind === 'connection' ? restoreConnection(tx, state, true) : restoreComponent(tx, state, true),
    );
    return { later: await laterChanges(entry), notes };
  });

  app.post<{ Params: { id: string } }>('/api/changes/:id/revert', async (req) => {
    const user = need(req, 'history.revert');
    const reason = parseReason(user, (req.body as { reason?: unknown } | undefined)?.reason);
    const { entry, state } = await loadRevertable(req.params.id);
    const type = state.kind;
    const id = entry.entityId;

    const current = await capture(type, id);
    let before: { name: string } | null;
    let after: { name: string } | null;
    let notes: string[];
    let diff: string[];
    if (state.kind === 'connection') {
      const b = await connectionSnapshot(id);
      notes = await prisma.$transaction((tx) => restoreConnection(tx, state, false), { timeout: 60_000 });
      const a = (await connectionSnapshot(id))!;
      diff = diffConnection(b ?? { name: '', description: '', lengthMm: null, zones: [], nodes: [], wires: [] }, a);
      before = b;
      after = a;
    } else {
      const b = (await componentSnapshot(id))!;
      notes = await prisma.$transaction((tx) => restoreComponent(tx, state, false), { timeout: 60_000 });
      const a = (await componentSnapshot(id))!;
      diff = diffComponent(b, a);
      before = b;
      after = a;
    }
    const when = entry.createdAt.toISOString().slice(0, 16).replace('T', ' ');
    await prisma.changeLog.create({
      data: {
        userId: currentUser(req).id,
        userName: user.name,
        projectId: type === 'connection' ? String((state as ConnectionState).connection.projectId) : null,
        entityType: type,
        entityId: id,
        entityName: after?.name ?? entry.entityName,
        action: 'revert',
        reason,
        summary: [
          `Reverted to before the change by ${entry.userName} (${when} UTC${entry.reason ? `: "${entry.reason}"` : ''})`,
          ...(before ? [] : ['Deleted connection restored']),
          ...diff,
          ...notes.map((n) => `Note: ${n}`),
        ],
        // The state before the revert, so the revert itself can be reverted.
        restore: current ? (current as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        revertable: !!current,
      },
    });
    return { ok: true, notes };
  });
}
