FROM oven/bun:1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Copy dependency manifest and lockfile, then install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy minimal git metadata for rev-parse
COPY .git/HEAD .git/HEAD
COPY .git/refs .git/refs/
COPY .git/packed-refs* .git/

# Copy prisma schema and config, then generate the client
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN bun run generate

# Copy remaining source
COPY . .

CMD ["bun", "start"]
