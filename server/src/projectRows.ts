/**
 * The rows one project's wiring is computed from (same shape as the backup's, see WiringRows),
 * loaded for that project only. Much less than readAll() once a server holds many projects.
 */

import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import type { WiringRows } from './wiringReport.js';

export async function readProjectRows(...projectIds: string[]): Promise<WiringRows> {
  const ids = [...new Set(projectIds)];
  return prisma.$transaction(
    async (tx) => {
      const [projects, folders, projectPcbs, connections] = await Promise.all([
        tx.project.findMany({ where: { id: { in: ids } } }),
        tx.folder.findMany({ where: { projectId: { in: ids } } }),
        tx.projectPcb.findMany({ where: { projectId: { in: ids } } }),
        tx.connection.findMany({ where: { projectId: { in: ids } } }),
      ]);
      const pcbIds = [...new Set(projectPcbs.map((p) => p.pcbId))];
      const connIds = connections.map((c) => c.id);
      const [pcbs, pcbConnectors, connectionNodes, wires, connectorTypes, cables] = await Promise.all([
        tx.pcb.findMany({ where: { id: { in: pcbIds } } }),
        tx.pcbConnector.findMany({ where: { pcbId: { in: pcbIds } } }),
        tx.connectionNode.findMany({ where: { connectionId: { in: connIds } } }),
        tx.wire.findMany({ where: { connectionId: { in: connIds } } }),
        // Small tables, and frozen copies belong to their project: load all.
        tx.connectorType.findMany(),
        tx.cable.findMany(),
      ]);
      return { projects, cables, connectorTypes, pcbs, folders, projectPcbs, pcbConnectors, connections, connectionNodes, wires } as WiringRows;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
