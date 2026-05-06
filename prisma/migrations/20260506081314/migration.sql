-- CreateTable
CREATE TABLE IF NOT EXISTS "_StasisManagers" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_StasisManagers_AB_pkey" PRIMARY KEY ("A", "B")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "_StasisManagers_B_index" ON "_StasisManagers" ("B");

-- AddForeignKey
ALTER TABLE "_StasisManagers"
ADD CONSTRAINT "_StasisManagers_A_fkey" FOREIGN KEY ("A") REFERENCES "Bot" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StasisManagers"
ADD CONSTRAINT "_StasisManagers_B_fkey" FOREIGN KEY ("B") REFERENCES "Stasis" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrateData: copy existing botId relationships into the new join table
INSERT INTO
    "_StasisManagers" ("A", "B")
SELECT "botId", "id"
FROM "Stasis"
WHERE
    "botId" IS NOT NULL ON CONFLICT DO NOTHING;

-- DropForeignKey
ALTER TABLE "Stasis" DROP CONSTRAINT IF EXISTS "Stasis_botId_fkey";

-- DropColumn
ALTER TABLE "Stasis" DROP COLUMN IF EXISTS "botId";