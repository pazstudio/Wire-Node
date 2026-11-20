import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import archiver from 'archiver';
import * as tar from 'tar';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { linkLegacyNodes, prisma } from '../db.js';
import { UPLOAD_DIR } from '../storage.js';
import { buildWiringReport, wiringReportHash } from '../wiringReport.js';
import { readProjectRows } from '../projectRows.js';
import { currentUser, need } from '../auth.js';
import { saveBackupFile } from '../backupStore.js';
import { restoreFiles } from '../revert.js';

/**
 * Backup format (.tar.gz):
 *   wire-node.json      all database rows, see BackupFile
 *   wiring/<project>.md readable wiring summary of each project (see wiringReport.ts); ignored by restore
 *   uploads/<file>      every picture referenced by a PCB or connector type
 *
 * wire-node.json also holds the change history and the accounts (with password hashes, so keep
 * backups private). Restoring replaces projects, library and history, but keeps the accounts of
 * this server: accounts from the backup are only added when their username is not taken here.
 */
const FORMAT = 'wire-node-backup';
// v2: projectPcbs have their own id and name; connectionNodes record projectPcbId.
// v1 backups still restore: placements get new ids and nodes are linked to them.
// v3: componentFolders, and projectPcbs record folderId.
// v4: componentFolders is now folders (with a kind); connections record folderId.
// v5: connections record zones.
// v6: projects record lockedAt; pcbs, connectorTypes and cables record frozenInProjectId and sourceId
//     (frozen copies kept by locked projects); pcbConnectors record sourceId.
// v7: wiringExports (when each project's wiring summary was last downloaded, and by whom).
// v8: history (change log) and accounts (groups and users).
// v9: wireChecks (build checklist), checkDismissals, comments, attachments (files on library components).
// v10: units (machines built from a project; wireChecks record unitId, ok, note), projectMembers
//      (projects record restricted), projectPcbs record fwAddress.
const VERSION = 10;
const MAX_RESTORE_BYTES = 20 * 1024 ** 3; // 20 GB

const TABLES = [
  'projects',
  'cables',
  'connectorTypes',
  'pcbs',
  'folders',
  'projectPcbs',
  'pcbConnectors',
  'connections',
  'connectionNodes',
  'wires',
  'zones',
  'wiringExports',
  'wireChecks',
  'checkDismissals',
  'comments',
  'attachments',
  'units',
] as const;
type Table = (typeof TABLES)[number];
type Rows = Record<Table, Record<string, unknown>[]>;

const RowList = z.array(z.record(z.unknown())).default([]);

const BackupSchema = z.object({
  format: z.literal(FORMAT, { errorMap: () => ({ message: 'Not a Wire-Node backup file' }) }),
  version: z.number().int(),
  exportedAt: z.string(),
  data: z.object(
    Object.fromEntries(TABLES.map((t) => [t, RowList])) as Record<Table, typeof RowList>,
  ),
  history: RowList,
  accounts: z.object({ groups: RowList, users: RowList, projectMembers: RowList }).default({}),
});

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export async function readAll(): Promise<Rows> {
  // One repeatable-read transaction, so the snapshot is consistent.
  const [projects, cables, connectorTypes, pcbs, folders, projectPcbs, pcbConnectors, connections, connectionNodes, wires, zones, wiringExports, wireChecks, checkDismissals, comments, attachments, units] =
    await prisma.$transaction(
      [
        prisma.project.findMany(),
        prisma.cable.findMany(),
        prisma.connectorType.findMany(),
        prisma.pcb.findMany(),
        prisma.folder.findMany(),
        prisma.projectPcb.findMany(),
        prisma.pcbConnector.findMany(),
        prisma.connection.findMany(),
        prisma.connectionNode.findMany(),
        prisma.wire.findMany(),
        prisma.zone.findMany(),
        prisma.wiringExport.findMany(),
        prisma.wireCheck.findMany(),
        prisma.checkDismissal.findMany(),
        prisma.comment.findMany(),
        prisma.attachment.findMany(),
        prisma.unit.findMany(),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  return {
    projects,
    cables,
    connectorTypes,
    pcbs,
    folders,
    projectPcbs,
    pcbConnectors,
    connections,
    connectionNodes,
    wires,
    zones,
    wiringExports,
    wireChecks,
    checkDismissals,
    comments,
    attachments,
    units,
  } as Rows;
}

function counts(rows: Rows) {
  return Object.fromEntries(TABLES.map((t) => [t, rows[t].length])) as Record<Table, number>;
}

/** File names (in the uploads folder) referenced by the data. */
function referencedFiles(rows: Rows): string[] {
  const names = new Set<string>();
  for (const r of [...rows.pcbs, ...rows.connectorTypes]) {
    for (const key of ['imagePath', 'thumbPath']) {
      const v = r[key];
      if (typeof v === 'string' && v) names.add(path.basename(v));
    }
  }
  for (const a of rows.attachments ?? []) {
    if (typeof a.storedPath === 'string' && a.storedPath) names.add(path.basename(a.storedPath));
  }
  return [...names];
}

/** File name for a project's wiring summary, e.g. "RC4 prototype" -> "rc4-prototype-wiring.md". */
function wiringFileName(projectName: unknown, n?: number) {
  const slug =
    String(projectName ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'project';
  return `${slug}${n ? `-${n}` : ''}-wiring.md`;
}

function isAllowedEntry(p: string, entry: { type?: string }) {
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (entry.type !== 'File' && entry.type !== 'Directory') return false; // no links/devices
  if (norm === 'wire-node.json') return entry.type === 'File';
  if (norm === 'uploads' || norm === 'uploads/') return true;
  return /^uploads\/[^/]+$/.test(norm) && !norm.includes('..');
}

/** Builds a complete backup archive. The returned stream has to be consumed (piped somewhere). */
export async function createBackupArchive(log: FastifyBaseLogger) {
  const rows = await readAll();
  const [history, groups, users, projectMembers] = await prisma.$transaction([
    prisma.changeLog.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.group.findMany(),
    prisma.user.findMany(),
    prisma.projectMember.findMany(),
  ]);
  // Also old pictures the history can revert to.
  const files = [...new Set([...referencedFiles(rows), ...restoreFiles(history)])];
  const present: string[] = [];
  const missingFiles: string[] = [];
  for (const f of files) (fs.existsSync(path.join(UPLOAD_DIR, f)) ? present : missingFiles).push(f);

  const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });
  archive.on('warning', (err) => log.warn(err));
  archive.on('error', (err) => {
    log.error(err);
    archive.abort();
  });

  const exportedAt = new Date().toISOString();
  const manifest = {
    format: FORMAT,
    version: VERSION,
    exportedAt,
    counts: { ...counts(rows), history: history.length, groups: groups.length, users: users.length },
    missingFiles,
    data: rows,
    history,
    accounts: { groups, users, projectMembers },
  };
  archive.append(JSON.stringify(manifest), { name: 'wire-node.json' });
  const usedNames = new Set<string>();
  for (const p of rows.projects) {
    let name = wiringFileName(p.name);
    for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = wiringFileName(p.name, i);
    usedNames.add(name.toLowerCase());
    archive.append(buildWiringReport(rows, p.id as string, exportedAt)!, { name: `wiring/${name}` });
  }
  for (const f of present) archive.file(path.join(UPLOAD_DIR, f), { name: `uploads/${f}` });
  void archive.finalize();
  return archive;
}

/**
 * Checks that a backup file can be restored, without restoring it: the archive unpacks, the
 * manifest is valid, its row counts match, and every picture and attached file it needs is inside.
 */
export async function verifyBackupFile(archivePath: string) {
  const entries = new Set<string>();
  let manifest = '';
  try {
    await tar.t({
      file: archivePath,
      strict: true,
      onReadEntry: (entry) => {
        const p = entry.path.replace(/\\/g, '/').replace(/^\.\//, '');
        entries.add(p);
        if (p === 'wire-node.json') {
          const chunks: Buffer[] = [];
          entry.on('data', (c: Buffer) => chunks.push(c));
          entry.on('end', () => (manifest = Buffer.concat(chunks).toString('utf8')));
        } else entry.resume();
      },
    });
  } catch (err) {
    return { ok: false as const, error: `The archive cannot be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!manifest) return { ok: false as const, error: 'wire-node.json is missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return { ok: false as const, error: 'wire-node.json is not valid JSON' };
  }
  const result = BackupSchema.safeParse(parsed);
  if (!result.success) return { ok: false as const, error: `wire-node.json is not valid: ${result.error.issues[0]?.message ?? ''}` };
  const backup = result.data;
  const rows = backup.data as Rows;
  const declared = (parsed as { counts?: Record<string, number> }).counts ?? {};
  for (const t of TABLES) {
    if (declared[t] !== undefined && declared[t] !== rows[t].length) {
      return { ok: false as const, error: `${t}: ${rows[t].length} rows, but the manifest says ${declared[t]}` };
    }
  }
  const declaredMissing = new Set(((parsed as { missingFiles?: string[] }).missingFiles ?? []).map(String));
  const needed = [...new Set([...referencedFiles(rows), ...restoreFiles(backup.history)])];
  const missing = needed.filter((f) => !entries.has(`uploads/${f}`) && !declaredMissing.has(f));
  if (missing.length) return { ok: false as const, error: `${missing.length} file(s) missing from the archive, e.g. ${missing[0]}` };
  return {
    ok: true as const,
    version: backup.version,
    exportedAt: backup.exportedAt,
    counts: { projects: rows.projects.length, connections: rows.connections.length, wires: rows.wires.length, files: needed.length },
    missingOnServer: declaredMissing.size,
  };
}

/** Adds the backup's groups and users that this server does not have; returns how many accounts were added. */
async function mergeAccounts(tx: Prisma.TransactionClient, accounts: { groups: Record<string, unknown>[]; users: Record<string, unknown>[] }) {
  const groupMap = new Map<string, string>();
  for (const g of accounts.groups) {
    const id = String(g.id ?? '');
    const name = String(g.name ?? '').trim();
    if (!id || !name) continue;
    const existing =
      (await tx.group.findUnique({ where: { id } })) ??
      (await tx.group.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } }));
    if (existing) {
      groupMap.set(id, existing.id);
      continue;
    }
    const created = await tx.group.create({
      data: {
        id,
        name,
        description: String(g.description ?? ''),
        isAdmin: g.isAdmin === true,
        permissions: Array.isArray(g.permissions) ? g.permissions.map(String) : [],
      },
    });
    groupMap.set(id, created.id);
  }
  let added = 0;
  for (const u of accounts.users) {
    const id = String(u.id ?? '');
    const username = String(u.username ?? '').toLowerCase();
    const groupId = groupMap.get(String(u.groupId ?? ''));
    if (!id || !username || !groupId || typeof u.passwordHash !== 'string') continue;
    if ((await tx.user.findUnique({ where: { id } })) || (await tx.user.findUnique({ where: { username } }))) continue;
    await tx.user.create({
      data: {
        id,
        username,
        displayName: String(u.displayName ?? ''),
        passwordHash: u.passwordHash,
        groupId,
        disabled: u.disabled === true,
        mustChangePassword: u.mustChangePassword === true,
        createdAt: typeof u.createdAt === 'string' ? u.createdAt : undefined,
        lastLoginAt: typeof u.lastLoginAt === 'string' ? u.lastLoginAt : null,
      },
    });
    added++;
  }
  return added;
}

/**
 * Restores a backup archive (.tar.gz on disk). Refuses (409) when the server has data unless
 * `replace` is set. Before anything is replaced, the current state is saved as a backup file.
 */
export async function restoreBackupFile(archivePath: string, replace: boolean, log: FastifyBaseLogger) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wire-node-restore-'));
  try {
    // 1. Unpack only the expected entries.
    const extractDir = path.join(tmp, 'x');
    await fs.promises.mkdir(extractDir);
    try {
      await tar.x({
        file: archivePath,
        cwd: extractDir,
        strict: true,
        filter: (p, entry) => isAllowedEntry(p, entry as { type?: string }),
      });
    } catch {
      throw new HttpError(400, 'The file is not a valid Wire-Node backup (.tar.gz)');
    }

    // 2. Read and check the manifest.
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(extractDir, 'wire-node.json'), 'utf8');
    } catch {
      throw new HttpError(400, 'The backup does not contain wire-node.json');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'wire-node.json is not valid JSON');
    }
    const backup = BackupSchema.parse(parsed);
    if (backup.version > VERSION) {
      throw new HttpError(400, `This backup was made by a newer Wire-Node (format v${backup.version}). Update this server first.`);
    }
    const rows = backup.data as Rows;
    // v3 backups name the folders table componentFolders (they only had component folders).
    const legacyFolders = (parsed as { data?: { componentFolders?: unknown } }).data?.componentFolders;
    if (!rows.folders.length && Array.isArray(legacyFolders)) rows.folders = legacyFolders;

    // 3. Refuse to silently overwrite existing data.
    const existing =
      (await prisma.project.count()) + (await prisma.pcb.count()) + (await prisma.cable.count()) + (await prisma.connectorType.count());
    if (existing > 0 && !replace) {
      throw new HttpError(409, 'This server already contains data. Restoring will replace ALL of it.');
    }

    // 4. Keep the current state, in case the wrong backup was chosen.
    const safetyBackup = existing > 0 ? (await saveBackupFile('before-restore', log)).name : null;

    // 5. Copy pictures into the uploads folder (UUID names, so no clashes with existing files).
    const files = [...new Set([...referencedFiles(rows), ...restoreFiles(backup.history)])];
    const missingFiles: string[] = [];
    for (const f of files) {
      const src = path.join(extractDir, 'uploads', f);
      if (fs.existsSync(src)) await fs.promises.copyFile(src, path.join(UPLOAD_DIR, f));
      else missingFiles.push(f);
    }

    // 6. Replace the database contents in one transaction (all or nothing).
    let accountsAdded = 0;
    await prisma.$transaction(
      async (tx) => {
        await tx.changeLog.deleteMany();
        await tx.wiringExport.deleteMany();
        await tx.wireCheck.deleteMany();
        await tx.checkDismissal.deleteMany();
        await tx.comment.deleteMany();
        await tx.attachment.deleteMany();
        await tx.unit.deleteMany();
        await tx.projectMember.deleteMany();
        await tx.wire.deleteMany();
        await tx.connectionNode.deleteMany();
        await tx.connection.deleteMany();
        await tx.zone.deleteMany();
        await tx.projectPcb.deleteMany();
        await tx.folder.deleteMany();
        await tx.pcbConnector.deleteMany();
        await tx.pcb.deleteMany();
        await tx.connectorType.deleteMany();
        await tx.cable.deleteMany();
        await tx.project.deleteMany();

        const create = async (t: Table, fn: (data: any[]) => Promise<unknown>) => {
          if (rows[t].length) await fn(rows[t]);
        };
        await create('projects', (data) => tx.project.createMany({ data }));
        await create('cables', (data) => tx.cable.createMany({ data }));
        await create('connectorTypes', (data) => tx.connectorType.createMany({ data }));
        await create('pcbs', (data) => tx.pcb.createMany({ data }));
        await create('folders', (data) => tx.folder.createMany({ data }));
        await create('projectPcbs', (data) => tx.projectPcb.createMany({ data }));
        await create('pcbConnectors', (data) => tx.pcbConnector.createMany({ data }));
        await create('connections', (data) => tx.connection.createMany({ data }));
        await create('connectionNodes', (data) => tx.connectionNode.createMany({ data }));
        await create('wires', (data) => tx.wire.createMany({ data }));
        await create('zones', (data) => tx.zone.createMany({ data }));
        await create('wiringExports', (data) => tx.wiringExport.createMany({ data }));
        await create('wireChecks', (data) => tx.wireCheck.createMany({ data }));
        await create('checkDismissals', (data) => tx.checkDismissal.createMany({ data }));
        await create('comments', (data) => tx.comment.createMany({ data }));
        await create('attachments', (data) => tx.attachment.createMany({ data }));
        await create('units', (data) => tx.unit.createMany({ data }));
        await linkLegacyNodes(tx);

        accountsAdded = await mergeAccounts(tx, backup.accounts);
        // Members of restricted projects, for the accounts that exist on this server.
        if (backup.accounts.projectMembers.length) {
          const userIds = new Set((await tx.user.findMany({ select: { id: true } })).map((u) => u.id));
          const projectIds = new Set(rows.projects.map((p) => String(p.id)));
          const data = backup.accounts.projectMembers
            .map((m) => ({ projectId: String(m.projectId ?? ''), userId: String(m.userId ?? '') }))
            .filter((m) => projectIds.has(m.projectId) && userIds.has(m.userId));
          if (data.length) await tx.projectMember.createMany({ data, skipDuplicates: true });
        }
        if (backup.history.length) {
          const userIds = new Set((await tx.user.findMany({ select: { id: true } })).map((u) => u.id));
          await tx.changeLog.createMany({
            data: backup.history.map((h) => ({
              ...(h as any),
              userId: typeof h.userId === 'string' && userIds.has(h.userId) ? h.userId : null,
              before: h.before == null ? Prisma.DbNull : (h.before as Prisma.InputJsonValue),
              restore: h.restore == null ? Prisma.DbNull : (h.restore as Prisma.InputJsonValue),
              revertable: h.restore != null && h.revertable === true,
            })),
          });
        }
      },
      { timeout: 10 * 60_000, maxWait: 30_000 },
    );

    // 7. Remove pictures that belonged to the replaced data.
    const keep = new Set(files);
    for (const f of await fs.promises.readdir(UPLOAD_DIR)) {
      if (!keep.has(f)) await fs.promises.rm(path.join(UPLOAD_DIR, f), { force: true, recursive: true });
    }

    return {
      ok: true as const,
      exportedAt: backup.exportedAt,
      counts: { ...counts(rows), history: backup.history.length, accountsAdded },
      missingFiles,
      safetyBackup,
    };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

export default async function backupRoutes(app: FastifyInstance) {
  app.get('/api/backup/info', async (req) => {
    need(req, 'backups.manage');
    const [projects, pcbs, connectorTypes, cables, connections] = await Promise.all([
      prisma.project.count(),
      prisma.pcb.count(),
      prisma.connectorType.count(),
      prisma.cable.count(),
      prisma.connection.count(),
    ]);
    return { projects, pcbs, connectorTypes, cables, connections };
  });

  // ---------- Export ----------
  app.get('/api/backup', async (req, reply) => {
    need(req, 'backups.manage');
    const archive = await createBackupArchive(req.log);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="wire-node-backup-${stamp}.tar.gz"`);
    return reply.send(archive);
  });

  // Readable wiring summary of one project, e.g. to give to an AI assistant.
  // Each download is recorded, so the project page can tell whether the project changed since.
  app.get<{ Params: { id: string } }>('/api/projects/:id/wiring.md', async (req, reply) => {
    const user = currentUser(req);
    const rows = await readProjectRows(req.params.id);
    const md = buildWiringReport(rows, req.params.id);
    if (md === null) return reply.code(404).send({ message: 'Not found' });
    await prisma.wiringExport.create({
      data: { projectId: req.params.id, exportedBy: user.name, contentHash: wiringReportHash(rows, req.params.id)! },
    });
    const name = rows.projects.find((p) => p.id === req.params.id)!.name;
    const file = wiringFileName(name);
    reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${file}"`);
    return md;
  });

  // Last download of the wiring summary, and whether the summary would read differently now.
  app.get<{ Params: { id: string } }>('/api/projects/:id/wiring-export', async (req, reply) => {
    const [rows, last] = await Promise.all([
      readProjectRows(req.params.id),
      prisma.wiringExport.findFirst({ where: { projectId: req.params.id }, orderBy: { exportedAt: 'desc' } }),
    ]);
    const hash = wiringReportHash(rows, req.params.id);
    if (hash === null) return reply.code(404).send({ message: 'Not found' });
    return {
      last: last && { exportedAt: last.exportedAt, exportedBy: last.exportedBy },
      changedSinceExport: !!last && last.contentHash !== hash,
    };
  });

  // ---------- Restore ----------
  // POST multipart with one file field. Add ?replace=true to overwrite a server that already has data.
  app.post<{ Querystring: { replace?: string } }>('/api/restore', async (req) => {
    need(req, 'backups.manage');
    const replace = req.query.replace === 'true';
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wire-node-upload-'));
    try {
      const file = await req.file({ limits: { fileSize: MAX_RESTORE_BYTES, files: 1 } });
      if (!file) throw new HttpError(400, 'No backup file was uploaded');
      const archivePath = path.join(tmp, 'backup.tar.gz');
      await pipeline(file.file, fs.createWriteStream(archivePath));
      if (file.file.truncated) throw new HttpError(413, 'The backup file is too large');
      return await restoreBackupFile(archivePath, replace, req.log);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
}
