/*
Warnings:

- Added the required columns `server` and `uuid` to the `Player` table.
- Removed the redundant unique index `Player_id_key` (id is already the primary key).

*/
-- Add new columns as nullable first so we can populate existing rows
ALTER TABLE "Player" ADD COLUMN "uuid" TEXT;

ALTER TABLE "Player" ADD COLUMN "server" TEXT;

-- For existing rows, the old id was the Minecraft UUID — copy it across.
-- Server is unknown for historical data; use an empty string as a placeholder.
UPDATE "Player" SET "uuid" = "id", "server" = '';

-- Make both columns NOT NULL now that every row has a value
ALTER TABLE "Player" ALTER COLUMN "uuid" SET NOT NULL;

ALTER TABLE "Player" ALTER COLUMN "server" SET NOT NULL;

-- The old schema had @unique on id in addition to @id; drop that redundant index
DROP INDEX IF EXISTS "Player_id_key";

-- Add the new composite unique index
CREATE UNIQUE INDEX "Player_server_uuid_key" ON "Player" ("server", "uuid");