FROM oven/bun:latest

RUN apt-get update -y && apt-get install -y openssl

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --ignore-scripts

COPY prisma ./prisma
RUN bunx prisma generate

COPY src ./src
CMD ["bun", "start"]
