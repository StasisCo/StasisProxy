# syntax=docker/dockerfile:1.7

######## BUILD ########
FROM oven/bun:alpine AS build
WORKDIR /app

# Cache-friendly deps install
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun \
    --mount=type=cache,target=/app/.bun-cache \
    bun install --frozen-lockfile --production --ignore-scripts

# If you use Prisma at runtime, generate for linux-musl
COPY prisma ./prisma
ENV PRISMA_CLI_BINARY_TARGETS="linux-musl"
RUN bunx prisma generate

# Your CLI source
COPY src ./src

# Compile to a single binary (adjust entry)
RUN bun build ./src/index.ts --compile --outfile /out/app

######## RUNTIME ########
FROM alpine:3.20
# C++ runtime + unwinder (required), and CA certs (HTTPS)
RUN apk add --no-cache libstdc++ libgcc ca-certificates
WORKDIR /app

COPY --from=build /out/app /usr/local/bin/app
# If your CLI needs runtime assets (e.g., prisma schema), copy them:
# COPY --from=build /app/prisma ./prisma

ENTRYPOINT ["app"]
