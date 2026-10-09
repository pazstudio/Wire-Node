-- Schema upgrades that `prisma db push` cannot apply on its own without dropping data.
-- Runs before every `prisma db push`, so every step must be idempotent and must be a
-- no-op on an empty database (where push creates the tables afterwards).

-- 0.2.0: a component can be placed in a project more than once.
-- ProjectPcb moves from the (projectId, pcbId) primary key to its own id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ProjectPcb'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ProjectPcb' AND column_name = 'id'
  ) THEN
    ALTER TABLE "ProjectPcb" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid();
    ALTER TABLE "ProjectPcb" DROP CONSTRAINT "ProjectPcb_pkey";
    ALTER TABLE "ProjectPcb" ADD CONSTRAINT "ProjectPcb_pkey" PRIMARY KEY ("id");
  END IF;
END $$;
