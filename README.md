<div align="center">

<img alt="Stasis Proxy" src="https://i.ibb.co/wTc8fc1/Frame-39.png" width="640" />

### A self-hosted Minecraft stasis chamber proxy

A clusterable Minecraft proxy for stasis chambers: in‑game holograms, Discord and IRC bridges, peer discovery over Redis Pub/Sub, and persistent pearl storage in Postgres.

[![Continuous Deployment](https://github.com/StasisCo/StasisProxy/actions/workflows/cd.yml/badge.svg)](https://github.com/StasisCo/StasisProxy/actions/workflows/cd.yml)
[![Continuous Integration](https://github.com/StasisCo/StasisProxy/actions/workflows/ci.yml/badge.svg)](https://github.com/StasisCo/StasisProxy/actions/workflows/ci.yml)

[![Container Size](https://ghcr-badge.egpl.dev/stasisco/stasisproxy/size?label=image%20size)](https://github.com/StasisCo/StasisProxy/pkgs/container/stasisproxy)
[![License](https://img.shields.io/github/license/stasisco/stasisproxy)](./LICENSE)
[![Version](https://img.shields.io/github/package-json/v/stasisco/stasisproxy)](https://github.com/StasisCo/StasisProxy/releases)

#### Built with

[![Bun](https://img.shields.io/badge/Bun-000?logo=bun&logoColor=fff)](https://bun.sh)
[![Discord.js](https://img.shields.io/badge/discord.js-5865F2?logo=discord&logoColor=fff)](https://discord.js.org)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=fff)](https://www.docker.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=fff)](https://www.postgresql.org)
[![Prisma](https://img.shields.io/badge/Prisma-2D3748?logo=prisma&logoColor=fff)](https://www.prisma.io)
[![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=fff)](https://redis.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org)

</div>

# 🚀 Quick Start

Get up and running in seconds using Docker.

### Prerequisites
- [Discord Bot Token](https://discord.com/developers/applications) (optional, for Discord integration)
- [Docker](https://www.docker.com/get-started)

### Running with Docker Compose

1. Clone the repository:
    ```bash
    git clone https://github.com/StasisCo/StasisProxy.git
    cd StasisProxy
    ```
    
2. Create a `.env` file in the root directory with the following content, replacing the placeholders with your actual values:
    ```env
    # Required MC server connection details
    MC_HOST=2b2t.org
    MC_USERNAME=Username

    # Optional Discord integration
    DISCORD_BOT_TOKEN=...
    ```

3. Start the stack:
    ```bash
    docker compose up -d
    ```
    This brings up the proxy, PostgreSQL, and Redis. The proxy listens on port `25565` by default.