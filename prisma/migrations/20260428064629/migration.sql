-- CreateTable
CREATE TABLE "Discord" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_DiscordToPlayer" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_DiscordToPlayer_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Discord_id_key" ON "Discord"("id");

-- CreateIndex
CREATE INDEX "_DiscordToPlayer_B_index" ON "_DiscordToPlayer"("B");

-- AddForeignKey
ALTER TABLE "_DiscordToPlayer" ADD CONSTRAINT "_DiscordToPlayer_A_fkey" FOREIGN KEY ("A") REFERENCES "Discord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DiscordToPlayer" ADD CONSTRAINT "_DiscordToPlayer_B_fkey" FOREIGN KEY ("B") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
