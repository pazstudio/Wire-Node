import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { assertUnlocked } from '../freeze.js';
import { need } from '../auth.js';
import { logChange, recordEdit, requireReason } from '../history.js';
import { CSV_TEMPLATE, planImport, type ImportContext } from '../csvImport.js';
import { placementName } from './projects.js';

type P = { Params: { id: string } };

async function context(projectId: string): Promise<ImportContext> {
  const [placements, connections] = await Promise.all([
    prisma.projectPcb.findMany({
      where: { projectId },
      include: { pcb: { select: { name: true, connectors: { include: { connectorType: { select: { pinCount: true } } } } } } },
    }),
    prisma.connection.findMany({ where: { projectId }, include: { nodes: true, wires: true } }),
  ]);
  const seen = new Set<string>();
  const connectors: ImportContext['connectors'] = [];
  for (const p of placements) {
    if (seen.has(p.pcbId)) continue;
    seen.add(p.pcbId);
    for (const c of p.pcb.connectors) {
      connectors.push({
        id: c.id,
        pcbId: p.pcbId,
        label: c.label,
        name: c.name,
        pins: (Array.isArray(c.pins) ? (c.pins as { n: number; name?: string }[]) : []).map((x) => ({ n: x.n, name: x.name ?? '' })),
        pinCount: c.connectorType?.pinCount ?? 0,
      });
    }
  }
  return {
    placements: placements.map((p) => ({ id: p.id, name: placementName(p), pcbId: p.pcbId })),
    connectors,
    connections: connections.map(({ nodes, wires, ...c }) => ({ id: c.id, name: c.name, nodes, wires })),
  };
}

const Body = z.object({
  csv: z.string().min(1).max(5_000_000),
  /** false = only show what would be imported. */
  apply: z.boolean().default(false),
  reason: z.string().optional(),
  /** Folder for new connections. */
  folderId: z.string().nullable().default(null),
});

export default async function importRoutes(app: FastifyInstance) {
  app.get('/api/import-wires/template.csv', async (_req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="wire-import-template.csv"');
    return '﻿' + CSV_TEMPLATE;
  });

  app.post<P>('/api/projects/:id/import-wires', async (req) => {
    const user = need(req, 'projects.edit');
    const b = Body.parse(req.body);
    const projectId = req.params.id;
    await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    await assertUnlocked(projectId);
    const plan = planImport(b.csv, await context(projectId));
    const summary = {
      rows: plan.rows,
      errors: plan.errors,
      connections: plan.connections.map((c) => ({ name: c.name, isNew: !c.existingId, wires: c.newWires })),
    };
    if (!b.apply) return { ...summary, applied: false };
    if (plan.errors.length) {
      throw Object.assign(new Error('Fix the rows with problems first (or remove them from the file).'), { statusCode: 400 });
    }
    const reason = requireReason(req, b.reason);
    if (b.folderId && !(await prisma.folder.findFirst({ where: { id: b.folderId, projectId, kind: 'connections' } }))) {
      throw Object.assign(new Error('That folder is not in this project'), { statusCode: 400 });
    }

    for (const c of plan.connections) {
      let id = c.existingId;
      if (!id) {
        const conn = await prisma.connection.create({
          data: { projectId, name: c.name, folderId: b.folderId, placementIds: [...new Set(c.nodes.map((n) => n.projectPcbId).filter(Boolean))] },
        });
        id = conn.id;
        await logChange(user, { projectId, entityType: 'connection', entityId: id, entityName: c.name, action: 'create', reason, summary: ['Imported from a CSV file'] });
      }
      const connectionId = id;
      await recordEdit(req, 'connection', connectionId, reason, () =>
        prisma.$transaction([
          prisma.connection.update({ where: { id: connectionId }, data: { kind: c.nodes.length > 2 ? 'harness' : 'direct' } }),
          prisma.wire.deleteMany({ where: { connectionId } }),
          prisma.connectionNode.deleteMany({ where: { connectionId } }),
          prisma.connectionNode.createMany({
            data: c.nodes.map((n) => ({
              id: n.id,
              connectionId,
              pcbConnectorId: n.pcbConnectorId ?? null,
              projectPcbId: n.projectPcbId ?? null,
              connectorTypeId: n.connectorTypeId ?? null,
              label: n.label ?? '',
              pinCount: Number(n.pinCount ?? 0),
              x: Number(n.x ?? 0),
              y: Number(n.y ?? 0),
            })),
          }),
          prisma.wire.createMany({
            data: c.wires.map((w) => ({
              id: w.id,
              connectionId,
              fromNodeId: w.fromNodeId,
              fromPin: w.fromPin,
              toNodeId: w.toNodeId,
              toPin: w.toPin,
              cableId: w.cableId ?? null,
              coreIndex: w.coreIndex ?? null,
              color: w.color ?? '',
              lengthMm: w.lengthMm ?? null,
              gauge: w.gauge ?? '',
              shielded: w.shielded ?? null,
              note: w.note ?? '',
            })),
          }),
        ]),
      );
    }
    return { ...summary, applied: true };
  });

  // Sets gauge, length, color, shielding or note on many wires at once (e.g. "22 AWG on every wire of
  // this folder"). Each connection touched gets one history entry with the reason.
  app.post<P>('/api/projects/:id/bulk-wires', async (req) => {
    need(req, 'projects.edit');
    const b = z
      .object({
        wireIds: z.array(z.string().min(1)).min(1).max(5000),
        set: z
          .object({
            gauge: z.string().trim().max(50),
            lengthMm: z.number().nonnegative().max(1e7).nullable(),
            color: z.string().max(50),
            shielded: z.boolean().nullable(),
            note: z.string().max(2000),
          })
          .partial()
          .refine((x) => Object.keys(x).length > 0, 'Choose at least one thing to change'),
        reason: z.string().optional(),
      })
      .parse(req.body);
    const projectId = req.params.id;
    await assertUnlocked(projectId);
    const wires = await prisma.wire.findMany({ where: { id: { in: b.wireIds }, connection: { projectId } }, select: { id: true, connectionId: true } });
    if (!wires.length) throw Object.assign(new Error('None of these wires are in this project'), { statusCode: 400 });
    const reason = requireReason(req, b.reason);
    const byConn = new Map<string, string[]>();
    for (const w of wires) byConn.set(w.connectionId, [...(byConn.get(w.connectionId) ?? []), w.id]);
    for (const [connectionId, ids] of byConn) {
      await recordEdit(req, 'connection', connectionId, reason, () =>
        prisma.wire.updateMany({ where: { id: { in: ids }, connectionId }, data: b.set }),
      );
    }
    return { updated: wires.length, connections: byConn.size };
  });
}
