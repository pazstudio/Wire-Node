import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import archiver from 'archiver';
import * as tar from 'tar';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { UPLOAD_DIR } from '../storage.js';

/**
 * Backup format (.tar.gz):
 *   wire-node.json      all database rows, see BackupFile
 *   uploads/<file>      every picture referenced by a PCB or connector type
 */
const FORMAT = 'wire-node-backup';
const VERSION = 1;
const MAX_RESTORE_BYTES = 20 * 1024 ** 3; // 20 GB

const TABLES = [
  'projects',
  'cables',
  'connectorTypes',
  'pcbs',
  'projectPcbs',
  'pcbConnectors',
  'connections',
  'connectionNodes',
  'wires',
  'zones',
] as const;
type Table = (typeof TABLES)[number];
type Rows = Record<Table, Record<string, unknown>[]>;

const BackupSchema = z.object({
  format: z.literal(FORMAT, { errorMap: () => ({ message: 'Not a Wire-Node backup file' }) }),
  version: z.number().int(),
  exportedAt: z.string(),
  data: z.object(
    Object.fromEntries(TABLES.map((t) => [t, z.array(z.record(z.unknown())).default([])])) as Record<
      Table,
      z.ZodDefault<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>
    >,
  ),
});

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

async function readAll(): Promise<Rows> {
  // One repeatable-read transaction, so the snapshot is consistent.
  const [projects, cables, connectorTypes, pcbs, projectPcbs, pcbConnectors, connections, connectionNodes, wires, zones] =
    await prisma.$transaction(
      [
        prisma.project.findMany(),
        prisma.cable.findMany(),
        prisma.connectorType.findMany(),
        prisma.pcb.findMany(),
        prisma.projectPcb.findMany(),
        prisma.pcbConnector.findMany(),
        prisma.connection.findMany(),
        prisma.connectionNode.findMany(),
        prisma.wire.findMany(),
        prisma.zone.findMany(),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  return { projects, cables, connectorTypes, pcbs, projectPcbs, pcbConnectors, connections, connectionNodes, wires, zones } as Rows;
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
  return [...names];
}

function isAllowedEntry(p: string, entry: { type?: string }) {
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (entry.type !== 'File' && entry.type !== 'Directory') return false; // no links/devices
  if (norm === 'wire-node.json') return entry.type === 'File';
  if (norm === 'uploads' || norm === 'uploads/') return true;
  return /^uploads\/[^/]+$/.test(norm) && !norm.includes('..');
}

export default async function backupRoutes(app: FastifyInstance) {
  app.get('/api/backup/info', async () => {
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
    const rows = await readAll();
    const files = referencedFiles(rows);
    const present: string[] = [];
    const missingFiles: string[] = [];
    for (const f of files) (fs.existsSync(path.join(UPLOAD_DIR, f)) ? present : missingFiles).push(f);

    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });
    archive.on('warning', (err) => req.log.warn(err));
    archive.on('error', (err) => {
      req.log.error(err);
      archive.abort();
    });

    const manifest = {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      counts: counts(rows),
      missingFiles,
      data: rows,
    };
    archive.append(JSON.stringify(manifest), { name: 'wire-node.json' });
    for (const f of present) archive.file(path.join(UPLOAD_DIR, f), { name: `uploads/${f}` });
    void archive.finalize();

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="wire-node-backup-${stamp}.tar.gz"`);
    return reply.send(archive);
  });

  // ---------- Restore ----------
  // POST multipart with one file field. Add ?replace=true to overwrite a server that already has data.
  app.post<{ Querystring: { replace?: string } }>('/api/restore', async (req, reply) => {
    const replace = req.query.replace === 'true';
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wire-node-restore-'));
    try {
      const file = await req.file({ limits: { fileSize: MAX_RESTORE_BYTES, files: 1 } });
      if (!file) throw new HttpError(400, 'No backup file was uploaded');

      // 1. Save the upload to disk, then unpack only the expected entries.
      const archivePath = path.join(tmp, 'backup.tar.gz');
      await pipeline(file.file, fs.createWriteStream(archivePath));
      if (file.file.truncated) throw new HttpError(413, 'The backup file is too large');
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

      // 3. Refuse to silently overwrite existing data.
      if (!replace) {
        const existing = (await prisma.project.count()) + (await prisma.pcb.count()) + (await prisma.cable.count()) + (await prisma.connectorType.count());
        if (existing > 0) {
          return reply.code(409).send({ message: 'This server already contains data. Restoring will replace ALL of it.' });
        }
      }

      // 4. Copy pictures into the uploads folder (UUID names, so no clashes with existing files).
      const files = referencedFiles(rows);
      const missingFiles: string[] = [];
      for (const f of files) {
        const src = path.join(extractDir, 'uploads', f);
        if (fs.existsSync(src)) await fs.promises.copyFile(src, path.join(UPLOAD_DIR, f));
        else missingFiles.push(f);
      }

      // 5. Replace the database contents in one transaction (all or nothing).
      await prisma.$transaction(
        async (tx) => {
          await tx.wire.deleteMany();
          await tx.connectionNode.deleteMany();
          await tx.connection.deleteMany();
          await tx.zone.deleteMany();
          await tx.projectPcb.deleteMany();
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
          await create('projectPcbs', (data) => tx.projectPcb.createMany({ data }));
          await create('pcbConnectors', (data) => tx.pcbConnector.createMany({ data }));
          await create('connections', (data) => tx.connection.createMany({ data }));
          await create('connectionNodes', (data) => tx.connectionNode.createMany({ data }));
          await create('wires', (data) => tx.wire.createMany({ data }));
          await create('zones', (data) => tx.zone.createMany({ data }));
        },
        { timeout: 10 * 60_000, maxWait: 30_000 },
      );

      // 6. Remove pictures that belonged to the replaced data.
      const keep = new Set(files);
      for (const f of await fs.promises.readdir(UPLOAD_DIR)) {
        if (!keep.has(f)) await fs.promises.rm(path.join(UPLOAD_DIR, f), { force: true, recursive: true });
      }

      return { ok: true, exportedAt: backup.exportedAt, counts: counts(rows), missingFiles };
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
}
