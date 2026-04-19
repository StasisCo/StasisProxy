FROM oven/bun:1
WORKDIR /app

# Copy the private @hackware/types package from the additional build context
# Build with: docker build --build-context hackware-types=<path-to-types> .
COPY --from=hackware-types . ./packages/types

# Copy dependency manifest and lockfile, then install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile && bun add @hackware/types@file:./packages/types

# Copy prisma schema and config, then generate the client
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" bunx prisma generate

# Copy remaining source
COPY . .

CMD ["bun", "start"]
