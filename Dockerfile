FROM oven/bun:1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Copy the private @hackware/types package from the additional build context
# Build with: docker build --build-context hackware-types=<path-to-types> .
COPY --from=hackware-types . ./packages/types

# Copy dependency manifest and lockfile, then install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile && bun add @hackware/types@file:./packages/types

# Copy minimal git metadata for rev-parse
COPY .git/HEAD .git/HEAD
COPY .git/refs .git/refs/
COPY .git/packed-refs* .git/

# Copy prisma schema and config, then generate the client
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" bunx prisma generate

# Copy remaining source
COPY . .

CMD ["bun", "start"]
