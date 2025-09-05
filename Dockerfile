# Use a Bun base image
FROM oven/bun:latest

# Create and switch to /app
WORKDIR /app

# Install only what's declared in update-server/package.json
RUN bun install

# 3) Now copy the rest of update-server's source
COPY . .

# Expose and run
CMD ["bun", "start"]
