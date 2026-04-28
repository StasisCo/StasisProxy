-- Remove legacy uniqueness scope by server; UUID is now canonical Player.id
DROP INDEX IF EXISTS "Player_server_uuid_key";

-- Guard against bad historical data before replacing primary key values
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Player" WHERE "uuid" IS NULL OR "uuid" = '') THEN
    RAISE EXCEPTION 'Player.uuid contains NULL/empty values; cannot migrate uuid -> id safely';
  END IF;

  IF EXISTS (SELECT "uuid" FROM "Player" GROUP BY "uuid" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate Player.uuid values found; cannot enforce global Player.id uniqueness';
  END IF;
END
$$;

-- Rename in-place by value migration so FK ON UPDATE CASCADE keeps references valid
UPDATE "Player" SET "id" = "uuid" WHERE "id" <> "uuid";

ALTER TABLE "Player" DROP COLUMN "server", DROP COLUMN "uuid";

-- Kept for parity with current Prisma schema (@id + @unique)
CREATE UNIQUE INDEX IF NOT EXISTS "Player_id_key" ON "Player" ("id");