-- CreateTable
CREATE TABLE "Stasis" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dimension" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "server" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "z" INTEGER NOT NULL,

    CONSTRAINT "Stasis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Stasis_server_x_y_z_dimension_key" ON "Stasis"("server", "x", "y", "z", "dimension");
