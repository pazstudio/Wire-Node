import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { assertNotFrozen, assertUnlocked } from '../freeze.js';
import { deleteFiles, readMultipart, saveImage } from '../storage.js';
import { assertComponentFolder, assertPlacementNameFree, logPlacement, PlacementNameField, placePcb } from './projects.js';
import { need } from '../auth.js';
import { hiddenProjectIds } from '../projectAccess.js';
import { logChange, recordEdit, requireReason } from '../history.js';

const PcbFields = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().default(''),
});

const PinSchema = z.object({
  n: z.number().int().min(1),
  name: z.string().default(''),
  color: z.string().default(''),
  /** Max current of the pin in A (optional), used by the design checks. */
  current: z.number().nonnegative().max(10000).nullable().optional(),
  /** What the pin is (optional), used by the design checks. */
  role: z.enum(['', 'power', 'ground', 'input', 'output', 'bidir', 'can_h', 'can_l', 'shield']).optional(),
});

const ConnectorBody = z.object({
  pcbId: z.string().min(1),
  connectorTypeId: z.string().nullable().optional(),
  label: z.string().default(''),
  name: z.string().default(''),
  x:z.number().min(-0.01).max(1.01),
  y: z.number().min(-0.01).max(1.01),
  w: z.number().positive().max(1.01),
  h: z.number().positive().max(1.01),
  rotation: z.number().default(0),
  pins: z.array(PinSchema).max(1000).default([]),
});

type P = { Params: { id: string } };

/** Library names are unique, so the same part is not uploaded twice under different names. */
async function assertLibraryNameFree(name: string, exceptId?: string) {
  const other = await prisma.pcb.findFirst({
    where: { frozenInProjectId: null, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (other) {
    throw Object.assign(
      new Error(`"${other.name}" is already in the component library. Use "Add existing component" to place it again.`),
      { statusCode: 409 },
    );
  }
}

export default async function pcbRoutes(app: FastifyInstance) {
  app.get('/api/pcbs', async (req) => {
    const hidden = await hiddenProjectIds(req);
    const pcbs = await prisma.pcb.findMany({
      where: { frozenInProjectId: null },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { connectors: true } },
        projects: { select: { project: { select: { id: true, name: true } } }, distinct: ['projectId'] },
      },
    });
    return hidden.size ? pcbs.map((p) => ({ ...p, projects: p.projects.filter((x) => !hidden.has(x.project.id)) })) : pcbs;
  });

  app.post('/api/pcbs', async (req, reply) => {
    const user = need(req, 'library.edit');
    const { fields, file } = await readMultipart(req);
    if (fields.projectId) need(req, 'projects.edit');
    const meta = PcbFields.parse(fields);
    const placementName = PlacementNameField.parse(fields.placementName ?? '');
    if (!file) return reply.code(400).send({ message: 'A picture of the component is required' });
    // Check names before storing anything, so a rejected upload leaves nothing behind.
    await assertLibraryNameFree(meta.name);
    if (fields.projectId) {
      await assertUnlocked(fields.projectId);
      await assertPlacementNameFree(fields.projectId, placementName || meta.name);
      await assertComponentFolder(fields.projectId, fields.folderId);
    }
    const img = await saveImage(file);
    const pcb = await prisma.pcb.create({
      data: {
        name: meta.name,
        description: meta.description,
        imagePath: img.imagePath,
        thumbPath: img.thumbPath,
        imageWidth: img.width,
        imageHeight: img.height,
      },
    });
    await logChange(user, { entityType: 'component', entityId: pcb.id, entityName: pcb.name, action: 'create' });
    if (fields.projectId) {
      const placement = await placePcb(fields.projectId, pcb.id, placementName, fields.folderId || null);
      await logPlacement(user, placement.id, 'place');
    }
    return reply.code(201).send(pcb);
  });

  app.get<P>('/api/pcbs/:id', async (req) =>
    prisma.pcb.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        connectors: { include: { connectorType: true }, orderBy: { label: 'asc' } },
        projects: { select: { project: { select: { id: true, name: true } } }, distinct: ['projectId'] },
      },
    }),
  );

  // Name, description, picture. Needs a `reason` field (or the X-Change-Id of an editing session).
  app.put<P>('/api/pcbs/:id', async (req) => {
    need(req, 'library.edit');
    const existing = await prisma.pcb.findUniqueOrThrow({ where: { id: req.params.id } });
    assertNotFrozen(existing);
    const { fields, file } = await readMultipart(req);
    const meta = PcbFields.parse(fields);
    await assertLibraryNameFree(meta.name, existing.id);
    if (!req.headers['x-change-id']) requireReason(req, fields.reason);
    return recordEdit(req, 'component', existing.id, fields.reason, async () => {
      const img = file ? await saveImage(file) : null;
      const pcb = await prisma.pcb.update({
        where: { id: existing.id },
        data: {
          name: meta.name,
          description: meta.description,
          ...(img
            ? { imagePath: img.imagePath, thumbPath: img.thumbPath, imageWidth: img.width, imageHeight: img.height }
            : {}),
        },
      });
      // The old picture is kept: the history can revert to it (see revert.ts).
      return pcb;
    });
  });

  // Deletes the component from the library and every project. The client must send the phrase the
  // user typed, so a stray request cannot do it by accident, and a ?reason=.
  app.delete<P & { Querystring: { confirm?: string } }>('/api/pcbs/:id', async (req, reply) => {
    const user = need(req, 'library.delete');
    if (req.query.confirm !== 'permanentlydeletefromallprojects') {
      return reply.code(400).send({ message: 'Type "permanentlydeletefromallprojects" to delete a component from all projects' });
    }
    const reason = requireReason(req);
    assertNotFrozen(await prisma.pcb.findUniqueOrThrow({ where: { id: req.params.id } }));
    const projects = await prisma.projectPcb.findMany({
      where: { pcbId: req.params.id },
      select: { project: { select: { name: true } } },
      distinct: ['projectId'],
    });
    const attachments = await prisma.attachment.findMany({ where: { pcbId: req.params.id }, select: { storedPath: true } });
    const pcb = await prisma.pcb.delete({ where: { id: req.params.id } });
    await deleteFiles(pcb.imagePath, pcb.thumbPath, ...attachments.map((a) => a.storedPath));
    await logChange(user, {
      entityType: 'component',
      entityId: pcb.id,
      entityName: pcb.name,
      action: 'delete',
      reason,
      summary: projects.length ? [`Deleted from the library and from: ${projects.map((p) => p.project.name).join(', ')}`] : ['Deleted from the library'],
    });
    return { ok: true };
  });

  // Where is this PCB used? Shown before deleting it.
  app.get<P>('/api/pcbs/:id/usage', async (req) => {
    const id = req.params.id;
    const [projects, connections] = await Promise.all([
      prisma.projectPcb.findMany({
        where: { pcbId: id },
        select: { project: { select: { id: true, name: true } } },
        distinct: ['projectId'],
      }),
      prisma.connection.findMany({
        where: { nodes: { some: { pcbConnector: { pcbId: id } } } },
        select: { id: true, name: true, projectId: true, project: { select: { name: true } } },
      }),
    ]);
    const hidden = await hiddenProjectIds(req);
    return {
      projects: projects.map((p) => p.project).filter((p) => !hidden.has(p.id)),
      connections: connections.filter((c) => !hidden.has(c.projectId)),
    };
  });

  // ----- Connectors drawn on a PCB (autosaved by the editor via idempotent upsert) -----
  // Recorded in the editing session named by the X-Change-Id header (see history.ts).
  app.put<P>('/api/pcb-connectors/:id', async (req) => {
    need(req, 'library.edit');
    const b = ConnectorBody.parse(req.body);
    const existing = await prisma.pcbConnector.findUnique({ where: { id: req.params.id }, include: { pcb: true } });
    if (existing) assertNotFrozen(existing.pcb);
    if (existing && existing.pcbId !== b.pcbId) {
      throw Object.assign(new Error('A connector cannot be moved to another component'), { statusCode: 400 });
    }
    assertNotFrozen(await prisma.pcb.findUniqueOrThrow({ where: { id: b.pcbId } }));
    const data = { ...b, connectorTypeId: b.connectorTypeId ?? null };
    return recordEdit(req, 'component', b.pcbId, undefined, () =>
      prisma.pcbConnector.upsert({
        where: { id: req.params.id },
        create: { id: req.params.id, ...data },
        update: data,
        include: { connectorType: true },
      }),
    );
  });

  app.delete<P>('/api/pcb-connectors/:id', async (req) => {
    need(req, 'library.edit');
    const existing = await prisma.pcbConnector.findUnique({ where: { id: req.params.id }, include: { pcb: true } });
    if (!existing) return { ok: true };
    assertNotFrozen(existing.pcb);
    await recordEdit(req, 'component', existing.pcbId, undefined, () =>
      prisma.pcbConnector.deleteMany({ where: { id: req.params.id } }),
    );
    return { ok: true };
  });

  // Every pin name used on any connector, most used first (autocomplete in the pin editor).
  app.get('/api/pin-names', async () =>
    prisma.$queryRaw<{ name: string; count: number }[]>`
      SELECT btrim(p->>'name') AS name, count(*)::int AS count
      FROM "PcbConnector" c JOIN "Pcb" b ON b.id = c."pcbId" AND b."frozenInProjectId" IS NULL,
        jsonb_array_elements(CASE WHEN jsonb_typeof(c.pins) = 'array' THEN c.pins ELSE '[]'::jsonb END) p
      WHERE btrim(coalesce(p->>'name', '')) <> ''
      GROUP BY 1
      ORDER BY 2 DESC, 1
      LIMIT 5000`,
  );

  // ?projectId= limits the list to one project (a component can be placed in several).
  app.get<P & { Querystring: { projectId?: string } }>('/api/pcb-connectors/:id/usage', async (req) => {
    const { projectId } = req.query;
    const connections = await prisma.connection.findMany({
      where: { nodes: { some: { pcbConnectorId: req.params.id } }, ...(projectId ? { projectId } : {}) },
      select: { id: true, name: true, projectId: true },
      orderBy: { name: 'asc' },
    });
    const hidden = await hiddenProjectIds(req);
    return { connections: connections.filter((c) => !hidden.has(c.projectId)) };
  });
}
