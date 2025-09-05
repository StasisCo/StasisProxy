/*
Warnings:

- You are about to drop the column `owner` on the `Stasis` table. All the data in the column will be lost.
- Added the required column `ownerId` to the `Stasis` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Stasis" RENAME COLUMN "owner" TO "ownerId";

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "username" TEXT NOT NULL,
    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_id_key" ON "Player" ("id");

-- AddForeignKey
ALTER TABLE "Stasis"
ADD CONSTRAINT "Stasis_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;