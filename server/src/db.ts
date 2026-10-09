import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

type Db = Pick<PrismaClient, '$executeRaw'>;

/**
 * Connection nodes saved before components could be placed in a project more than once
 * (and nodes restored from such backups) don't record which placement they are on.
 * Links them to the placement when it is unambiguous. Safe to run any number of times.
 */
export function linkLegacyNodes(db: Db = prisma) {
  return db.$executeRaw`
    UPDATE "ConnectionNode" n SET "projectPcbId" = pp.id
    FROM "PcbConnector" pc, "Connection" c, "ProjectPcb" pp
    WHERE n."projectPcbId" IS NULL
      AND n."pcbConnectorId" = pc.id
      AND n."connectionId" = c.id
      AND pp."projectId" = c."projectId"
      AND pp."pcbId" = pc."pcbId"
      AND (SELECT count(*) FROM "ProjectPcb" x WHERE x."projectId" = c."projectId" AND x."pcbId" = pc."pcbId") = 1`;
}
