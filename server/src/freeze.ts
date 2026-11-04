import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { copyUpload, deleteFiles } from './storage.js';

/**
 * Locking a project (e.g. after the device shipped) gives it frozen copies of every library
 * component, connector type and cable it uses, so editing or deleting them in the library no
 * longer changes it. Frozen copies are hidden from the library and cannot be edited.
 * Unlocking (and duplicating a locked project) "thaws": the project goes back to the library items.
 */

type Tx = Prisma.TransactionClient;
type Maps = { pcb: Map<string, string>; connector: Map<string, string>; type: Map<string, string>; cable: Map<string, string> };

const newMaps = (): Maps => ({ pcb: new Map(), connector: new Map(), type: new Map(), cable: new Map() });
const unique = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => !!id))];

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

/** Throws 409 if the project is locked. */
export async function assertUnlocked(projectId: string) {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { lockedAt: true } });
  if (p.lockedAt) throw conflict('This project is locked. Unlock it on the project page to change it.');
}

/** Throws 409 for the frozen copy of a locked project. */
export function assertNotFrozen(item: { frozenInProjectId: string | null }) {
  if (item.frozenInProjectId) throw conflict('This is the frozen copy kept by a locked project. It cannot be changed.');
}

/** Copies the pictures of an item; the new file names are added to `written`. */
async function copyPictures(item: { imagePath: string | null; thumbPath: string | null }, written: string[]) {
  const [imagePath, thumbPath] = await Promise.all([copyUpload(item.imagePath), copyUpload(item.thumbPath)]);
  for (const f of [imagePath, thumbPath]) if (f && f !== item.imagePath && f !== item.thumbPath) written.push(f);
  return { imagePath, thumbPath };
}

type Owner = { frozenInProjectId: string | null; sourceId: string | null };

async function copyType(tx: Tx, id: string, owner: Owner, written: string[]) {
  const t = await tx.connectorType.findUniqueOrThrow({ where: { id } });
  const pics = await copyPictures(t, written);
  return (await tx.connectorType.create({ data: { ...t, ...pics, ...owner, id: randomUUID() } })).id;
}

async function copyCable(tx: Tx, id: string, owner: Owner) {
  const c = await tx.cable.findUniqueOrThrow({ where: { id } });
  return (await tx.cable.create({ data: { ...c, cores: c.cores as Prisma.InputJsonValue, ...owner, id: randomUUID() } })).id;
}

/** Copies a component with its picture and connectors. Connector types are mapped through `maps.type`. */
async function copyPcb(tx: Tx, id: string, owner: Owner & { name?: string }, maps: Maps, written: string[]) {
  const { connectors, ...pcb } = await tx.pcb.findUniqueOrThrow({ where: { id }, include: { connectors: true } });
  const pics = await copyPictures(pcb, written);
  const created = await tx.pcb.create({
    data: { ...pcb, ...owner, name: owner.name ?? pcb.name, imagePath: pics.imagePath!, thumbPath: pics.thumbPath!, id: randomUUID() },
  });
  maps.pcb.set(id, created.id);
  await tx.pcbConnector.createMany({
    data: connectors.map((c) => {
      const copyId = randomUUID();
      maps.connector.set(c.id, copyId);
      return {
        ...c,
        id: copyId,
        pcbId: created.id,
        pins: c.pins as Prisma.InputJsonValue,
        connectorTypeId: c.connectorTypeId ? (maps.type.get(c.connectorTypeId) ?? c.connectorTypeId) : null,
        // A frozen connector remembers its library connector; a connector restored to the library starts fresh.
        sourceId: owner.frozenInProjectId ? c.id : null,
      };
    }),
  });
}

/** Points the project's placements, connectors and wires at other components, connector types and cables. */
async function repoint(tx: Tx, projectId: string, maps: Maps) {
  const inProject = { connection: { projectId } };
  for (const [from, to] of maps.pcb) await tx.projectPcb.updateMany({ where: { projectId, pcbId: from }, data: { pcbId: to } });
  for (const [from, to] of maps.connector)
    await tx.connectionNode.updateMany({ where: { ...inProject, pcbConnectorId: from }, data: { pcbConnectorId: to } });
  for (const [from, to] of maps.type)
    await tx.connectionNode.updateMany({ where: { ...inProject, connectorTypeId: from }, data: { connectorTypeId: to } });
  for (const [from, to] of maps.cable) await tx.wire.updateMany({ where: { ...inProject, cableId: from }, data: { cableId: to } });
}

/** What the project uses, filtered by whether it is a frozen copy or a library item. */
async function used(tx: Tx, projectId: string, frozen: boolean) {
  const frozenFilter = frozen ? { not: null } : null;
  const [placements, nodes, wires] = await Promise.all([
    tx.projectPcb.findMany({ where: { projectId, pcb: { frozenInProjectId: frozenFilter } }, select: { pcbId: true } }),
    tx.connectionNode.findMany({ where: { connection: { projectId } }, select: { pcbConnectorId: true, connectorTypeId: true } }),
    tx.wire.findMany({ where: { connection: { projectId }, cableId: { not: null } }, select: { cableId: true } }),
  ]);
  // Also components whose connectors are in a connection without a placement (older data).
  const nodeConnectors = await tx.pcbConnector.findMany({
    where: { id: { in: unique(nodes.map((n) => n.pcbConnectorId)) } },
    select: { pcbId: true },
  });
  const pcbs = await tx.pcb.findMany({
    where: { id: { in: unique([...placements, ...nodeConnectors].map((p) => p.pcbId)) }, frozenInProjectId: frozenFilter },
    include: { connectors: true },
  });
  const cables = await tx.cable.findMany({
    where: { id: { in: unique(wires.map((w) => w.cableId)) }, frozenInProjectId: frozenFilter },
    select: { id: true, sourceId: true },
  });
  return { pcbs, nodes, cables };
}

async function freeze(tx: Tx, projectId: string, written: string[]) {
  const { pcbs, nodes, cables } = await used(tx, projectId, false);
  const owner = (sourceId: string) => ({ frozenInProjectId: projectId, sourceId });
  const maps = newMaps();
  const typeIds = unique([...pcbs.flatMap((p) => p.connectors.map((c) => c.connectorTypeId)), ...nodes.map((n) => n.connectorTypeId)]);
  const types = await tx.connectorType.findMany({ where: { id: { in: typeIds }, frozenInProjectId: null }, select: { id: true } });
  for (const t of types) maps.type.set(t.id, await copyType(tx, t.id, owner(t.id), written));
  for (const c of cables) maps.cable.set(c.id, await copyCable(tx, c.id, owner(c.id)));
  for (const p of pcbs) await copyPcb(tx, p.id, owner(p.id), maps, written);
  await repoint(tx, projectId, maps);
}

/** A library component name that is not taken yet, for a frozen component that goes back to the library. */
async function freeLibraryName(tx: Tx, name: string, projectName: string) {
  const taken = async (n: string) =>
    !!(await tx.pcb.findFirst({ where: { frozenInProjectId: null, name: { equals: n, mode: 'insensitive' } } }));
  if (!(await taken(name))) return name;
  const base = `${name} (${projectName})`;
  let candidate = base;
  for (let i = 2; await taken(candidate); i++) candidate = `${base} ${i}`;
  return candidate;
}

/**
 * Moves the project from frozen copies back to the library items they were copied from. Where the library
 * item is gone (or a connector a wire uses was removed from the component), the frozen copy is restored to
 * the library instead, so nothing in the project is lost.
 */
async function thaw(tx: Tx, projectId: string, written: string[]) {
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  const { pcbs, nodes, cables } = await used(tx, projectId, true);
  const library = { frozenInProjectId: null, sourceId: null };
  const maps = newMaps();
  const usedConnectors = new Set(unique(nodes.map((n) => n.pcbConnectorId)));

  const restore: string[] = [];
  for (const fp of pcbs) {
    const src = fp.sourceId
      ? await tx.pcb.findFirst({ where: { id: fp.sourceId, frozenInProjectId: null }, include: { connectors: { select: { id: true } } } })
      : null;
    const srcConnectors = new Set(src?.connectors.map((c) => c.id));
    const wired = fp.connectors.filter((c) => usedConnectors.has(c.id));
    if (src && wired.every((c) => c.sourceId && srcConnectors.has(c.sourceId))) {
      maps.pcb.set(fp.id, src.id);
      for (const c of wired) maps.connector.set(c.id, c.sourceId!);
    } else {
      restore.push(fp.id);
    }
  }

  const restored = pcbs.filter((p) => restore.includes(p.id));
  const typeIds = unique([...nodes.map((n) => n.connectorTypeId), ...restored.flatMap((p) => p.connectors.map((c) => c.connectorTypeId))]);
  const types = await tx.connectorType.findMany({
    where: { id: { in: typeIds }, frozenInProjectId: { not: null } },
    select: { id: true, sourceId: true },
  });
  for (const t of types) {
    const src = t.sourceId && (await tx.connectorType.findFirst({ where: { id: t.sourceId, frozenInProjectId: null } }));
    maps.type.set(t.id, src ? src.id : await copyType(tx, t.id, library, written));
  }
  for (const c of cables) {
    const src = c.sourceId && (await tx.cable.findFirst({ where: { id: c.sourceId, frozenInProjectId: null } }));
    maps.cable.set(c.id, src ? src.id : await copyCable(tx, c.id, library));
  }
  for (const p of restored) {
    await copyPcb(tx, p.id, { ...library, name: await freeLibraryName(tx, p.name, project.name) }, maps, written);
  }
  await repoint(tx, projectId, maps);
}

/** Runs a lock change in one transaction; pictures copied for a failed attempt are removed again. */
async function withCopies<T>(fn: (tx: Tx, written: string[]) => Promise<T>) {
  const written: string[] = [];
  try {
    return await prisma.$transaction((tx) => fn(tx, written), { timeout: 5 * 60_000, maxWait: 30_000 });
  } catch (err) {
    await deleteFiles(...written);
    throw err;
  }
}

export async function lockProject(projectId: string) {
  return withCopies(async (tx, written) => {
    const p = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    if (p.lockedAt) return p;
    await freeze(tx, projectId, written);
    return tx.project.update({ where: { id: projectId }, data: { lockedAt: new Date() } });
  });
}

export async function unlockProject(projectId: string) {
  const unused: (string | null)[] = [];
  const project = await withCopies(async (tx, written) => {
    const p = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    if (!p.lockedAt) return p;
    await thaw(tx, projectId, written);
    // The frozen copies are no longer used.
    const owned = { frozenInProjectId: projectId };
    for (const x of [...(await tx.pcb.findMany({ where: owned })), ...(await tx.connectorType.findMany({ where: owned }))]) {
      unused.push(x.imagePath, x.thumbPath);
    }
    await tx.pcb.deleteMany({ where: owned });
    await tx.connectorType.deleteMany({ where: owned });
    await tx.cable.deleteMany({ where: owned });
    return tx.project.update({ where: { id: projectId }, data: { lockedAt: null } });
  });
  await deleteFiles(...unused);
  return project;
}

/** Copies a project with everything it owns. A copy of a locked project starts on the library items. */
export async function duplicateProject(
  srcId: string,
  body: { name: string; machine: string; description: string },
) {
  return withCopies(async (tx, written) => {
    const src = await tx.project.findUniqueOrThrow({
      where: { id: srcId },
      include: { folders: true, pcbs: true, zones: true, connections: { include: { nodes: true, wires: true } } },
    });
    const ids = new Map<string, string>();
    const newId = (old: string) => {
      const id = randomUUID();
      ids.set(old, id);
      return id;
    };
    const mapped = (old: string | null) => (old ? ids.get(old) ?? null : null);

    const projectId = randomUUID();
    const folders = src.folders.map(({ createdAt, ...f }) => ({ ...f, id: newId(f.id), projectId }));
    const placements = src.pcbs.map((p) => ({ ...p, id: newId(p.id), projectId, folderId: mapped(p.folderId) }));
    const zones = src.zones.map((z) => ({ ...z, id: randomUUID(), projectId }));
    const connections = src.connections.map(({ nodes, wires, createdAt, updatedAt, ...c }) => ({
      ...c,
      zones: c.zones ?? [],
      id: newId(c.id),
      projectId,
      folderId: mapped(c.folderId),
      placementIds: c.placementIds.map((id) => ids.get(id)).filter((id): id is string => !!id),
    }));
    const nodes = src.connections.flatMap((c) =>
      c.nodes.map((n) => ({ ...n, id: newId(n.id), connectionId: ids.get(c.id)!, projectPcbId: mapped(n.projectPcbId) })),
    );
    const wires = src.connections.flatMap((c) =>
      c.wires.map((w) => ({
        ...w,
        id: randomUUID(),
        connectionId: ids.get(c.id)!,
        fromNodeId: ids.get(w.fromNodeId)!,
        toNodeId: ids.get(w.toNodeId)!,
      })),
    );

    const created = await tx.project.create({ data: { ...body, id: projectId } });
    await tx.folder.createMany({ data: folders });
    await tx.projectPcb.createMany({ data: placements });
    await tx.zone.createMany({ data: zones });
    await tx.connection.createMany({ data: connections });
    await tx.connectionNode.createMany({ data: nodes });
    await tx.wire.createMany({ data: wires });
    if (src.lockedAt) await thaw(tx, projectId, written);
    return created;
  });
}
