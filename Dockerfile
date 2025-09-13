# syntax=docker/dockerfile:1.7

######## BUILD ########
FROM oven/bun:alpine AS build
WORKDIR /app

# 1) Install prod deps (includes @prisma/client). Skip scripts to keep it lean.
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun \
    --mount=type=cache,target=/app/.bun-cache \
    bun install --frozen-lockfile --production --ignore-scripts

# 2) Generate Prisma client & download the MUSL engine
COPY prisma ./prisma
# Prisma 6.x: ensure the musl+openssl3 target; also disable Data Proxy
ENV PRISMA_CLI_BINARY_TARGETS="linux-musl-openssl-3.0.x" \
    PRISMA_GENERATE_DATAPROXY="false"
RUN bunx prisma generate

# 3) Compile your CLI to a single binary (adjust entry path as needed)
COPY src ./src
RUN bun build ./src/index.ts --compile --outfile /out/app

######## RUNTIME ########
FROM alpine:3.20
WORKDIR /app

# Needed by the compiled Bun binary
RUN apk add --no-cache libstdc++ libgcc ca-certificates

# 4) Copy the compiled CLI
COPY --from=build /out/app /usr/local/bin/app

# 5) Copy Prisma engines folder so the binary can find the query engine
#    (Prisma looks under node_modules/.prisma/client by default)
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma

# 6) Point Prisma directly at the engine to be explicit/safe
ENV PRISMA_QUERY_ENGINE_LIBRARY="/app/node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node" \
    PRISMA_GENERATE_DATAPROXY="false" \
    NODE_ENV=production

ENTRYPOINT ["app"]
