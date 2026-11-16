import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

// ---------- Permissions ----------

/** Everything a group can be allowed to do. Viewing projects and history only needs an account. */
export const PERMISSIONS = {
  'projects.create': 'Create and duplicate projects',
  'projects.edit': 'Edit projects: connections, placed components, folders, map',
  'projects.delete': 'Delete projects',
  'projects.lock': 'Lock projects',
  'projects.unlock': 'Unlock projects',
  'connections.delete': 'Delete connections',
  'library.edit': 'Add and edit library components, connectors and cables',
  'library.delete': 'Delete library components (from all projects), connectors and cables',
  'backups.manage': 'Backups: download, restore, automatic backup settings',
  'users.manage': 'Manage users and groups',
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];
export const PermissionSchema = z.enum(PERMISSION_KEYS as [Permission, ...Permission[]]);

/** Groups made on first start. They can be changed in the admin panel (except Admin). */
const DEFAULT_GROUPS: { name: string; description: string; isAdmin?: boolean; permissions: Permission[] }[] = [
  { name: 'Admin', description: 'Everything, including users, groups and backups', isAdmin: true, permissions: [] },
  {
    name: 'Editor',
    description: 'Edits projects and the library, locks projects',
    permissions: ['projects.create', 'projects.edit', 'projects.lock', 'connections.delete', 'library.edit'],
  },
  { name: 'Member', description: 'Edits connections and components in projects', permissions: ['projects.edit'] },
];

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  /** Shown in history, e.g. "Jan Novák" (or the username). */
  name: string;
  groupId: string;
  groupName: string;
  isAdmin: boolean;
  permissions: Permission[];
  mustChangePassword: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

function httpError(statusCode: number, message: string, code?: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** The signed-in user; throws 401 when there is none (routes behind the auth hook always have one). */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw httpError(401, 'Please sign in');
  return req.user;
}

export function can(user: AuthUser, permission: Permission) {
  return user.isAdmin || user.permissions.includes(permission);
}

/** Throws 403 unless the signed-in user has the permission. Returns the user. */
export function need(req: FastifyRequest, permission: Permission): AuthUser {
  const user = currentUser(req);
  if (!can(user, permission)) {
    throw httpError(403, `You don't have permission to do this (${PERMISSIONS[permission].toLowerCase()}). Ask an admin.`);
  }
  return user;
}

// ---------- Passwords ----------

export const PasswordSchema = z
  .string()
  .min(8, 'The password must have at least 8 characters')
  .max(200)
  .refine((p) => p.toLowerCase() !== 'admin' && p.toLowerCase() !== 'password', 'Choose a less obvious password');

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash to compare against when the username does not exist, so both cases take as long. */
let dummyHash: Promise<string> | null = null;

// ---------- First start ----------

/**
 * Creates the default groups when there are none, and the admin/admin account when there are no
 * accounts. Only adds rows to the account tables; projects and the library are not touched.
 */
export async function ensureAccounts(log: { info: (msg: string) => void }) {
  if ((await prisma.group.count()) === 0) {
    for (const g of DEFAULT_GROUPS) await prisma.group.create({ data: { ...g, isAdmin: !!g.isAdmin } });
  }
  if ((await prisma.user.count()) === 0) {
    const admin = await prisma.group.findFirst({ where: { isAdmin: true } });
    const group = admin ?? (await prisma.group.create({ data: { name: 'Admin', isAdmin: true } }));
    await prisma.user.create({
      data: {
        username: 'admin',
        displayName: 'Administrator',
        passwordHash: await hashPassword('admin'),
        groupId: group.id,
        mustChangePassword: true,
      },
    });
    log.info('Created the first account: user "admin", password "admin". Sign in and choose a new password.');
  }
}

// ---------- Sessions ----------

const COOKIE = 'wn_session';
const SESSION_DAYS = 30;
const tokenId = (token: string) => createHash('sha256').update(token).digest('hex');

function readCookie(req: FastifyRequest, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isHttps(req: FastifyRequest) {
  return req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAgeSec: number) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

const userInclude = { group: true } as const;
type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

export function toAuthUser(u: UserRow): AuthUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    name: u.displayName || u.username,
    groupId: u.groupId,
    groupName: u.group.name,
    isAdmin: u.group.isAdmin,
    permissions: u.group.isAdmin ? [...PERMISSION_KEYS] : (u.group.permissions.filter((p) => p in PERMISSIONS) as Permission[]),
    mustChangePassword: u.mustChangePassword,
  };
}

async function userFromSession(req: FastifyRequest): Promise<AuthUser | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { id: tokenId(token) }, include: { user: { include: userInclude } } });
  if (!session || session.expiresAt < new Date() || session.user.disabled) return null;
  // Sliding expiry, written at most once an hour.
  if (Date.now() - session.lastSeenAt.getTime() > 3600_000) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000) },
    });
  }
  return toAuthUser(session.user);
}

/** Signs out every browser of a user (password change, account disabled or deleted). */
export async function endSessions(userId: string, exceptToken?: string | null) {
  await prisma.session.deleteMany({ where: { userId, ...(exceptToken ? { NOT: { id: tokenId(exceptToken) } } : {}) } });
}

/** Throws 400 if the change would leave no enabled account in an admin group. */
export async function assertAdminRemains(change: { userId: string; disabled?: boolean; groupId?: string; deleted?: boolean }) {
  const admins = await prisma.user.findMany({ where: { disabled: false, group: { isAdmin: true } }, select: { id: true } });
  if (!admins.some((a) => a.id === change.userId)) return; // the user is not an active admin now
  let stillAdmin = !change.deleted && !change.disabled;
  if (stillAdmin && change.groupId) {
    stillAdmin = !!(await prisma.group.findFirst({ where: { id: change.groupId, isAdmin: true } }));
  }
  if (!stillAdmin && admins.length <= 1) {
    throw httpError(400, 'This is the last admin account. Make another account an admin first.');
  }
}

// ---------- Brute-force protection (per IP and username, in memory) ----------

const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;

function tooManyFailures(key: string) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
  if (failures.size > 10_000) failures.clear();
}

// ---------- Hook and routes ----------

/** Reachable without signing in. Everything else under /api and /uploads needs an account. */
const PUBLIC = new Set(['/api/health', '/api/auth/login', '/api/auth/me', '/api/auth/logout']);
/** Allowed while the account still has to choose a new password. */
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/password']);

/** Registers the sign-in hook and routes on the root instance (not encapsulated, so the hook covers every route). */
export async function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    const protectedPath = url.startsWith('/api/') || url.startsWith('/uploads/');
    if (!protectedPath) return;

    // A page on another site must not be able to make changes with the user's cookie.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let originHost = '';
      try {
        originHost = new URL(req.headers.origin).host;
      } catch {
        /* malformed */
      }
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
      if (originHost !== host) return reply.code(403).send({ message: 'Request from another site refused' });
    }

    req.user = (await userFromSession(req)) ?? undefined;
    if (PUBLIC.has(url)) return;
    if (!req.user) return reply.code(401).send({ message: 'Please sign in', code: 'SIGN_IN' });
    if (req.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(url)) {
      return reply.code(403).send({ message: 'Choose a new password first', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = z
      .object({ username: z.string().trim().toLowerCase().min(1).max(100), password: z.string().min(1).max(200) })
      .parse(req.body);
    const key = `${req.ip}|${username}`;
    if (tooManyFailures(key)) {
      return reply.code(429).send({ message: 'Too many failed sign-ins. Wait 15 minutes and try again.' });
    }
    const user = await prisma.user.findUnique({ where: { username }, include: userInclude });
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
    if (!user || !ok || user.disabled) {
      recordFailure(key);
      return reply.code(401).send({ message: user?.disabled && ok ? 'This account is disabled' : 'Wrong username or password' });
    }
    failures.delete(key);
    const token = randomBytes(32).toString('base64url');
    await prisma.session.create({
      data: { id: tokenId(token), userId: user.id, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000) },
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    // Clean up expired sessions now and then.
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    setCookie(req, reply, token, SESSION_DAYS * 86400);
    return { user: toAuthUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readCookie(req, COOKIE);
    if (token) await prisma.session.deleteMany({ where: { id: tokenId(token) } });
    setCookie(req, reply, '', 0);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ message: 'Please sign in', code: 'SIGN_IN' });
    return { user: req.user, permissions: PERMISSIONS };
  });

  // Changes the signed-in user's own password. Other browsers of the user are signed out.
  app.post('/api/auth/password', async (req) => {
    const me = currentUser(req);
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string().max(200), newPassword: PasswordSchema })
      .parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw httpError(400, 'The current password is wrong');
    if (currentPassword === newPassword) throw httpError(400, 'The new password must be different from the current one');
    await prisma.user.update({
      where: { id: me.id },
      data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
    });
    await endSessions(me.id, readCookie(req, COOKIE));
    return { ok: true };
  });
}
