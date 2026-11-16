import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import {
  assertAdminRemains,
  endSessions,
  hashPassword,
  need,
  PasswordSchema,
  PermissionSchema,
  PERMISSIONS,
} from '../auth.js';

type P = { Params: { id: string } };

const Username = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'The username must have at least 2 characters')
  .max(60)
  .regex(/^[a-z0-9._-]+$/, 'Use only letters, digits, dot, dash and underscore in the username');

const UserCreate = z.object({
  username: Username,
  displayName: z.string().trim().max(120).default(''),
  groupId: z.string().min(1, 'Choose a group'),
  password: PasswordSchema,
});

const UserUpdate = z
  .object({
    displayName: z.string().trim().max(120),
    groupId: z.string().min(1),
    disabled: z.boolean(),
    /** Sets a new password; the user has to change it at the next sign-in. */
    password: PasswordSchema,
  })
  .partial();

const GroupBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  description: z.string().trim().max(300).default(''),
  permissions: z.array(PermissionSchema).default([]),
});

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

const userSelect = {
  id: true,
  username: true,
  displayName: true,
  groupId: true,
  disabled: true,
  mustChangePassword: true,
  createdAt: true,
  lastLoginAt: true,
  group: { select: { id: true, name: true, isAdmin: true } },
} as const;

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    need(req, 'users.manage');
  });

  app.get('/api/admin/permissions', async () => PERMISSIONS);

  // ----- Users -----
  app.get('/api/admin/users', async () => prisma.user.findMany({ select: userSelect, orderBy: { username: 'asc' } }));

  app.post('/api/admin/users', async (req, reply) => {
    const b = UserCreate.parse(req.body);
    if (await prisma.user.findUnique({ where: { username: b.username } })) throw conflict(`The username "${b.username}" is taken`);
    await prisma.group.findUniqueOrThrow({ where: { id: b.groupId } });
    const user = await prisma.user.create({
      data: {
        username: b.username,
        displayName: b.displayName,
        groupId: b.groupId,
        passwordHash: await hashPassword(b.password),
        // The admin chose this password, so the user picks their own at the first sign-in.
        mustChangePassword: true,
      },
      select: userSelect,
    });
    return reply.code(201).send(user);
  });

  app.patch<P>('/api/admin/users/:id', async (req) => {
    const b = UserUpdate.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } });
    if (b.groupId) await prisma.group.findUniqueOrThrow({ where: { id: b.groupId } });
    await assertAdminRemains({ userId: user.id, disabled: b.disabled, groupId: b.groupId });
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        displayName: b.displayName,
        groupId: b.groupId,
        disabled: b.disabled,
        ...(b.password ? { passwordHash: await hashPassword(b.password), mustChangePassword: true } : {}),
      },
      select: userSelect,
    });
    if (b.disabled || b.password) await endSessions(user.id);
    return updated;
  });

  // The user's history entries stay, under the name they had.
  app.delete<P>('/api/admin/users/:id', async (req) => {
    if (req.params.id === req.user?.id) throw Object.assign(new Error('You cannot delete your own account'), { statusCode: 400 });
    await assertAdminRemains({ userId: req.params.id, deleted: true });
    await prisma.user.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ----- Groups -----
  app.get('/api/admin/groups', async () =>
    prisma.group.findMany({ orderBy: [{ isAdmin: 'desc' }, { name: 'asc' }], include: { _count: { select: { users: true } } } }),
  );

  app.post('/api/admin/groups', async (req, reply) => {
    const b = GroupBody.parse(req.body);
    if (await prisma.group.findFirst({ where: { name: { equals: b.name, mode: 'insensitive' } } })) {
      throw conflict(`A group called "${b.name}" already exists`);
    }
    return reply.code(201).send(await prisma.group.create({ data: b }));
  });

  app.put<P>('/api/admin/groups/:id', async (req) => {
    const b = GroupBody.parse(req.body);
    const group = await prisma.group.findUniqueOrThrow({ where: { id: req.params.id } });
    const clash = await prisma.group.findFirst({
      where: { name: { equals: b.name, mode: 'insensitive' }, NOT: { id: group.id } },
    });
    if (clash) throw conflict(`A group called "${b.name}" already exists`);
    // The admin group always has every permission.
    return prisma.group.update({
      where: { id: group.id },
      data: group.isAdmin ? { name: b.name, description: b.description } : b,
    });
  });

  app.delete<P>('/api/admin/groups/:id', async (req) => {
    const group = await prisma.group.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { users: true } } } });
    if (group.isAdmin) throw Object.assign(new Error('The admin group cannot be deleted'), { statusCode: 400 });
    if (group._count.users) {
      throw conflict(`${group._count.users} account(s) are in "${group.name}". Move them to another group first.`);
    }
    await prisma.group.delete({ where: { id: group.id } });
    return { ok: true };
  });
}
