import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';
import { need } from './auth.js';
import { createBackupArchive, HttpError, restoreBackupFile } from './routes/backup.js';
import { backupDay, backupsToKeep } from './backupRetention.js';

/**
 * Automatic backups: every `intervalHours` a backup file is written to BACKUP_DIR, and only the
 * newest `keep` of them are kept (the oldest is deleted when a new one is made). Backups made
 * automatically before a restore are kept separately (the newest 5).
 *
 * BACKUP_DIR is a folder on the server. In Docker, mount it from the host or another disk, so the
 * backups survive the loss of the Docker volumes.
 */
export const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR ?? 'backups');

export type BackupKind = 'auto' | 'before-restore';
const KEEP_BEFORE_RESTORE = 5;
const FILE_RE = /^wire-node-(auto|before-restore)-(\d{8}-\d{6})\.tar\.gz$/;

export const BackupSettings = z.object({
  enabled: z.boolean(),
  /** Hours between backups (1 hour to 30 days). */
  intervalHours: z.number().int().min(1).max(720),
  /** How many of the newest automatic backups to keep. */
  keep: z.number().int().min(1).max(1000),
  /** Also keep the newest backup of each day, for this many days (0 = off). Defaults for settings saved before it existed. */
  keepDays: z.number().int().min(0).max(3650).default(30),
});
export type BackupSettings = z.infer<typeof BackupSettings>;

const DEFAULT_SETTINGS: BackupSettings = { enabled: true, intervalHours: 24, keep: 14, keepDays: 30 };

interface LastRun {
  at: string;
  ok: boolean;
  file?: string;
  error?: string;
}

async function getSetting<T>(key: string): Promise<T | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return (row?.value as T) ?? null;
}

async function setSetting(key: string, value: object) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function getBackupSettings(): Promise<BackupSettings> {
  const parsed = BackupSettings.safeParse(await getSetting('backup'));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

function stamp(d = new Date()) {
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

export async function listBackupFiles() {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  const names = (await fs.promises.readdir(BACKUP_DIR)).filter((n) => FILE_RE.test(n));
  const files = await Promise.all(
    names.map(async (name) => {
      const st = await fs.promises.stat(path.join(BACKUP_DIR, name));
      return { name, kind: FILE_RE.exec(name)![1] as BackupKind, size: st.size, createdAt: st.mtime.toISOString() };
    }),
  );
  return files.sort((a, b) => b.name.localeCompare(a.name));
}

/** Deletes the backups of a kind that the retention settings no longer keep (see backupRetention.ts). */
async function rotate(kind: BackupKind, settings: { keep: number; keepDays: number }) {
  const files = (await listBackupFiles()).filter((f) => f.kind === kind).map((f) => ({ ...f, day: backupDay(f.name) }));
  const keep = backupsToKeep(files, settings);
  for (const f of files) if (!keep.has(f.name)) await fs.promises.rm(path.join(BACKUP_DIR, f.name), { force: true });
}

/** Writes a backup file to BACKUP_DIR (via a temporary name, so a half-written file is never listed). */
export async function saveBackupFile(kind: BackupKind, log: FastifyBaseLogger) {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  let name = `wire-node-${kind}-${stamp()}.tar.gz`;
  for (let i = 1; fs.existsSync(path.join(BACKUP_DIR, name)); i++) {
    name = `wire-node-${kind}-${stamp(new Date(Date.now() + i * 1000))}.tar.gz`;
  }
  const tmp = path.join(BACKUP_DIR, `.${name}.partial`);
  try {
    await pipeline(await createBackupArchive(log), fs.createWriteStream(tmp));
    await fs.promises.rename(tmp, path.join(BACKUP_DIR, name));
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  await rotate(kind, kind === 'auto' ? await getBackupSettings() : { keep: KEEP_BEFORE_RESTORE, keepDays: 0 });
  return { name };
}

let running = false;

/** Makes an automatic backup now and records the outcome. */
async function runAutoBackup(log: FastifyBaseLogger) {
  if (running) throw new HttpError(409, 'A backup is already being made');
  running = true;
  try {
    const { name } = await saveBackupFile('auto', log);
    await setSetting('backup.lastRun', { at: new Date().toISOString(), ok: true, file: name } satisfies LastRun);
    log.info(`Automatic backup written: ${name}`);
    return name;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await setSetting('backup.lastRun', { at: new Date().toISOString(), ok: false, error } satisfies LastRun);
    log.error(err, 'Automatic backup failed');
    throw err;
  } finally {
    running = false;
  }
}

async function nextRunAt(settings: BackupSettings) {
  if (!settings.enabled) return null;
  const last = await getSetting<LastRun>('backup.lastRun');
  const lastAt = last ? new Date(last.at).getTime() : 0;
  // After a failure, try again in an hour rather than waiting a whole interval.
  const wait = last && !last.ok ? Math.min(3600_000, settings.intervalHours * 3600_000) : settings.intervalHours * 3600_000;
  return new Date(Math.max(lastAt + wait, Date.now()));
}

/** Checks once a minute whether an automatic backup is due. */
export function startBackupScheduler(log: FastifyBaseLogger) {
  const tick = async () => {
    try {
      const next = await nextRunAt(await getBackupSettings());
      if (next && next.getTime() <= Date.now() + 1000 && !running) await runAutoBackup(log);
    } catch {
      /* logged in runAutoBackup; tried again later */
    }
  };
  // The first check waits a minute, so a restarting server is not slowed down at once.
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

const NameParam = z.object({ name: z.string().regex(FILE_RE, 'Unknown backup file') });

export default async function backupStoreRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    need(req, 'backups.manage');
  });

  app.get('/api/backups', async () => {
    const settings = await getBackupSettings();
    const [files, lastRun, next] = await Promise.all([listBackupFiles(), getSetting<LastRun>('backup.lastRun'), nextRunAt(settings)]);
    return { settings, files, lastRun, nextRunAt: next, running, dir: BACKUP_DIR };
  });

  app.put('/api/backups/settings', async (req) => {
    const settings = BackupSettings.parse(req.body);
    await setSetting('backup', settings);
    await rotate('auto', settings);
    return { settings, nextRunAt: await nextRunAt(settings) };
  });

  app.post('/api/backups/run', async (req) => ({ name: await runAutoBackup(req.log) }));

  app.get<{ Params: { name: string } }>('/api/backups/:name/download', async (req, reply) => {
    const { name } = NameParam.parse(req.params);
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file)) return reply.code(404).send({ message: 'Not found' });
    reply.header('Content-Type', 'application/gzip').header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.send(fs.createReadStream(file));
  });

  app.delete<{ Params: { name: string } }>('/api/backups/:name', async (req) => {
    const { name } = NameParam.parse(req.params);
    await fs.promises.rm(path.join(BACKUP_DIR, name), { force: true });
    return { ok: true };
  });

  // Restores a stored backup, replacing everything (the current state is saved first).
  app.post<{ Params: { name: string } }>('/api/backups/:name/restore', async (req, reply) => {
    const { name } = NameParam.parse(req.params);
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file)) return reply.code(404).send({ message: 'Not found' });
    return restoreBackupFile(file, true, req.log);
  });
}
