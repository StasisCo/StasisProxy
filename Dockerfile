# Use a Bun base image
FROM oven/bun:latest

# Install openssl
RUN apt-get update -y && apt-get install -y openssl

# Create and switch to /app
WORKDIR /app

# Now copy the rest of update-server's source
COPY . .

# Install only what's declared in update-server/package.json
RUN bun install

# Expose and run
CMD ["bun", "start"]
