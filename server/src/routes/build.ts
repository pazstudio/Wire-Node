import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { need } from '../auth.js';
import { buildBuildList } from '../buildList.js';
import { runDesignChecks, type Severity } from '../designChecks.js';
import { compareProjects } from '../compareProjects.js';
import { buildProjectModel } from '../projectModel.js';
import { readProjectRows } from '../projectRows.js';
import type { WiringRows } from '../wiringReport.js';
import { notify } from '../notify.js';
import { firmwareConfig } from '../firmwareExport.js';

type P = { Params: { id: string } };

const notFound = () => Object.assign(new Error('Not found'), { statusCode: 404 });
const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** Design checks with dismissed findings moved out of the list and the counts. */
async function checksWithDismissals(projectId: string, rows?: WiringRows) {
  const [all, dismissals] = await Promise.all([
    rows ?? readProjectRows(projectId),
    prisma.checkDismissal.findMany({ where: { projectId }, orderBy: { dismissedAt: 'desc' } }),
  ]);
  const res = runDesignChecks(all, projectId);
  if (!res) throw notFound();
  const byKey = new Map(dismissals.map((d) => [d.key, d]));
  const open = res.issues.filter((i) => !byKey.has(i.key));
  const dismissed = res.issues
    .filter((i) => byKey.has(i.key))
    .map((i) => {
      const d = byKey.get(i.key)!;
      return { ...i, dismissal: { note: d.note, by: d.dismissedBy, at: d.dismissedAt } };
    });
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of open) counts[i.severity]++;
  return { ...res, issues: open, dismissed, counts };
}

export const CHECK_STEPS = ['crimped', 'tested'] as const;

/** The unit must belong to the project ("" = the project itself). */
async function assertUnit(projectId: string, unitId: string) {
  if (!unitId) return null;
  const unit = await prisma.unit.findFirst({ where: { id: unitId, projectId } });
  if (!unit) throw badRequest('That unit is not in this project');
  return unit;
}

/** Every wire of a project with its number, ends and build-checklist ticks (of one unit). */
async function projectWires(projectId: string, unitId = '') {
  const [rows, checks] = await Promise.all([readProjectRows(projectId), prisma.wireCheck.findMany({ where: { projectId, unitId } })]);
  const m = buildProjectModel(rows, projectId);
  if (!m) throw notFound();
  const byWire = new Map<string, typeof checks>();
  for (const c of checks) byWire.set(c.wireId, [...(byWire.get(c.wireId) ?? []), c]);
  return {
    unitId,
    connections: m.connections.map((c) => ({ id: String(c.id), name: String(c.name), folderId: (c.folderId as string) ?? null })),
    wires: m.wires.map((w) => {
      const ticks = byWire.get(w.id) ?? [];
      const step = (s: string) => {
        const t = ticks.find((x) => x.step === s);
        if (!t) return null;
        return { doneAt: t.doneAt, doneBy: t.doneBy, stale: t.fingerprint !== w.fingerprint, ok: t.ok, note: t.note };
      };
      const { fingerprint: _f, ...rest } = w;
      return { ...rest, net: m.netOf(w.from.nodeId, w.from.pin)?.id ?? null, crimped: step('crimped'), tested: step('tested') };
    }),
    nets: m.nets.map((n) => ({ id: n.id, names: n.names })),
    /** Type, crimp and all cavities of every connector a wire ends on, by EndInfo.connectorKey. */
    connectors: Object.fromEntries(
      m.wires.flatMap((w) => [w.from, w.to]).map((e) => [e.connectorKey, m.connectorDetails(e)]),
    ),
  };
}

/** Checklist progress of every unit of a project (and of the project itself, unitId ""). */
async function progress(projectId: string, rows?: WiringRows) {
  const [r, checks] = await Promise.all([rows ?? readProjectRows(projectId), prisma.wireCheck.findMany({ where: { projectId } })]);
  const m = buildProjectModel(r, projectId);
  if (!m) throw notFound();
  const fp = new Map(m.wires.map((w) => [w.id, w.fingerprint]));
  const by = new Map<string, { crimped: number; tested: number; failed: number }>();
  for (const c of checks) {
    if (fp.get(c.wireId) !== c.fingerprint) continue;
    const p = by.get(c.unitId) ?? { crimped: 0, tested: 0, failed: 0 };
    if (c.step === 'crimped') p.crimped++;
    else if (c.ok) p.tested++;
    else p.failed++;
    by.set(c.unitId, p);
  }
  return { wires: m.wires.length, of: (unitId: string) => by.get(unitId) ?? { crimped: 0, tested: 0, failed: 0 } };
}

const UnitBody = z.object({
  serial: z.string().trim().min(1, 'Serial is required').max(100),
  notes: z.string().max(5000).default(''),
  status: z.enum(['building', 'tested', 'shipped', 'retired']).default('building'),
});

export default async function buildRoutes(app: FastifyInstance) {
  // Bill of materials and cut list.
  app.get<P>('/api/projects/:id/build-list', async (req) => {
    const list = buildBuildList(await readProjectRows(req.params.id), req.params.id);
    if (!list) throw notFound();
    return list;
  });

  // Design checks and the nets they were computed from.
  app.get<P>('/api/projects/:id/checks', async (req) => checksWithDismissals(req.params.id));

  // Marks a finding as intended (or, with DELETE, brings it back).
  app.post<P>('/api/projects/:id/check-dismissals', async (req) => {
    const user = need(req, 'projects.edit');
    const b = z.object({ key: z.string().min(1).max(64), title: z.string().max(500).default(''), note: z.string().max(1000).default('') }).parse(req.body);
    await prisma.project.findUniqueOrThrow({ where: { id: req.params.id } });
    await prisma.checkDismissal.upsert({
      where: { projectId_key: { projectId: req.params.id, key: b.key } },
      create: { projectId: req.params.id, key: b.key, title: b.title, note: b.note, dismissedBy: user.name },
      update: { note: b.note, dismissedBy: user.name, dismissedAt: new Date() },
    });
    return checksWithDismissals(req.params.id);
  });
  app.delete<P & { Querystring: { key?: string } }>('/api/projects/:id/check-dismissals', async (req) => {
    need(req, 'projects.edit');
    await prisma.checkDismissal.deleteMany({ where: { projectId: req.params.id, key: String(req.query.key ?? '') } });
    return checksWithDismissals(req.params.id);
  });

  // Differences from another project, e.g. the previous revision of the machine.
  app.get<P & { Params: { other: string } }>('/api/projects/:id/compare/:other', async (req) => {
    const diff = compareProjects(await readProjectRows(req.params.id, req.params.other), req.params.other, req.params.id);
    if (!diff) throw notFound();
    return diff;
  });

  // Draft firmware configuration (RepRapFirmware config.g, or a Klipper pin list).
  app.get<P & { Querystring: { format?: string } }>('/api/projects/:id/firmware', async (req, reply) => {
    const format = req.query.format === 'klipper' ? 'klipper' : 'rrf';
    const text = firmwareConfig(await readProjectRows(req.params.id), req.params.id, format);
    if (text === null) throw notFound();
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return text;
  });

  // Wires with their number, for labels and the build checklist. ?unit=<id> for a unit's ticks.
  app.get<P & { Querystring: { unit?: string } }>('/api/projects/:id/wires', async (req) => {
    const unitId = String(req.query.unit ?? '');
    await assertUnit(req.params.id, unitId);
    return projectWires(req.params.id, unitId);
  });

  // Ticks wires on (or off) the build checklist, of the project or of one unit. Allowed in locked
  // projects too: building a shipped revision is exactly when the checklist is used.
  // A failed test is `step: "tested", ok: false` with a note. `at` (from a phone that was offline)
  // keeps the time the tick was made.
  app.put<P>('/api/projects/:id/wire-checks', async (req) => {
    const user = need(req, 'projects.edit');
    const body = z
      .object({
        wireIds: z.array(z.string().min(1)).min(1).max(5000),
        step: z.enum(CHECK_STEPS),
        done: z.boolean(),
        unitId: z.string().default(''),
        ok: z.boolean().default(true),
        note: z.string().max(2000).default(''),
        at: z.string().datetime().optional(),
      })
      .parse(req.body);
    const projectId = req.params.id;
    const unit = await assertUnit(projectId, body.unitId);
    const rows = await readProjectRows(projectId);
    const m = buildProjectModel(rows, projectId);
    if (!m) throw notFound();
    const wires = new Map(m.wires.map((w) => [w.id, w]));
    // A wire deleted while a phone was offline: skip it rather than failing the whole queue.
    const ids = body.wireIds.filter((id) => wires.has(id));
    if (!ids.length && body.wireIds.length) throw badRequest('These wires are no longer in this project (reload the page)');
    const at = body.at && Math.abs(Date.now() - Date.parse(body.at)) < 30 * 86400_000 ? new Date(body.at) : new Date();
    if (!body.done) {
      await prisma.wireCheck.deleteMany({ where: { projectId, unitId: body.unitId, step: body.step, wireId: { in: ids } } });
    } else {
      const ok = body.step === 'crimped' ? true : body.ok;
      await prisma.$transaction(
        ids.map((id) => {
          const w = wires.get(id)!;
          const data = { projectId, connectionId: w.connectionId, fingerprint: w.fingerprint, doneAt: at, doneBy: user.name, ok, note: body.note };
          return prisma.wireCheck.upsert({
            where: { wireId_step_unitId: { wireId: id, step: body.step, unitId: body.unitId } },
            create: { wireId: id, step: body.step, unitId: body.unitId, ...data },
            update: data,
          });
        }),
      );
      if (!ok) {
        const w = wires.get(ids[0])!;
        notify(
          'testFailures',
          `✗ Test failed: ${w.ref} ${w.from.short} → ${w.to.short} in "${m.project.name}"${unit ? ` unit ${unit.serial}` : ''} (${user.name})${body.note ? `: ${body.note}` : ''}`,
          `/projects/${projectId}?tab=build&view=checklist${unit ? `&unit=${unit.id}` : ''}`,
          req.log,
        );
      }
    }
    return projectWires(projectId, body.unitId);
  });

  // Short status for the project page: open design errors and checklist progress (project-level ticks).
  app.get<P>('/api/projects/:id/build-status', async (req) => {
    const rows = await readProjectRows(req.params.id);
    const res = await checksWithDismissals(req.params.id, rows);
    const p = await progress(req.params.id, rows);
    return { checks: res.counts, wires: p.wires, ...p.of('') };
  });

  // ---------- Units (machines built from the project) ----------

  app.get<P>('/api/projects/:id/units', async (req) => {
    const units = await prisma.unit.findMany({ where: { projectId: req.params.id }, orderBy: { createdAt: 'asc' } });
    const p = await progress(req.params.id);
    return units
      .sort((a, b) => a.serial.localeCompare(b.serial, undefined, { numeric: true }))
      .map((u) => ({ ...u, wires: p.wires, ...p.of(u.id) }));
  });

  app.post<P>('/api/projects/:id/units', async (req, reply) => {
    need(req, 'projects.edit');
    const b = UnitBody.parse(req.body);
    await prisma.project.findUniqueOrThrow({ where: { id: req.params.id } });
    if (await prisma.unit.findFirst({ where: { projectId: req.params.id, serial: { equals: b.serial, mode: 'insensitive' } } })) {
      throw Object.assign(new Error(`Unit "${b.serial}" already exists`), { statusCode: 409 });
    }
    return reply.code(201).send(await prisma.unit.create({ data: { ...b, projectId: req.params.id } }));
  });

  app.patch<P>('/api/units/:id', async (req) => {
    need(req, 'projects.edit');
    const b = UnitBody.partial().parse(req.body);
    const unit = await prisma.unit.findUniqueOrThrow({ where: { id: req.params.id } });
    if (b.serial && b.serial.toLowerCase() !== unit.serial.toLowerCase()) {
      const clash = await prisma.unit.findFirst({ where: { projectId: unit.projectId, serial: { equals: b.serial, mode: 'insensitive' } } });
      if (clash) throw Object.assign(new Error(`Unit "${b.serial}" already exists`), { statusCode: 409 });
    }
    return prisma.unit.update({ where: { id: unit.id }, data: b });
  });

  app.delete<P>('/api/units/:id', async (req) => {
    need(req, 'projects.edit');
    const unit = await prisma.unit.findUnique({ where: { id: req.params.id } });
    if (!unit) return { ok: true };
    await prisma.$transaction([
      prisma.wireCheck.deleteMany({ where: { unitId: unit.id } }),
      prisma.comment.deleteMany({ where: { entityType: 'unit', entityId: unit.id } }),
      prisma.unit.delete({ where: { id: unit.id } }),
    ]);
    return { ok: true };
  });
}
