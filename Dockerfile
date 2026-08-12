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

# Copy remaining source (the IRC wire schemas live in src/schema — plain
# source, no private dependency; see src/schema/irc/README.md)
COPY . .

# IRC credentials injected from CI secrets and baked into the runtime image
ARG IRC_CLIENT_ID
ARG IRC_CLIENT_SECRET
ENV IRC_CLIENT_ID=$IRC_CLIENT_ID
ENV IRC_CLIENT_SECRET=$IRC_CLIENT_SECRET

EXPOSE 3007
EXPOSE 25577

CMD ["bun", "start"]
