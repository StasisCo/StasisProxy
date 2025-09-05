# StasisProxy

A Minecraft stasis proxy that keeps a bot connected to a server and exposes a local proxy port for you to join through.

## Setup with Docker Compose

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### 1. Configure environment

Create a `.env` file in the project root:

```env
MC_HOST=2b2t.org
MC_USERNAME=YourUsername
STASIS_LOCATION_NAME=farm,farms
```

These are the only required variables. Everything else has defaults provided by the compose file:

| Variable               | Default                                           | Description                                                  |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `MC_HOST`              | **required**                                      | Minecraft server address                                     |
| `MC_USERNAME`          | **required**                                      | Minecraft account username                                   |
| `STASIS_LOCATION_NAME` | **required**                                      | Comma-separated stasis location names                        |
| `MC_VERSION`           | `1.20.1`                                          | Minecraft version                                            |
| `PROXY_PORT`           | `25577`                                           | Local proxy port to connect through                          |
| `DATABASE_URL`         | `postgresql://stasis:stasis@postgres:5432/stasis` | PostgreSQL connection string                                 |
| `REDIS_URL`            | `redis://redis:6379`                              | Redis connection string                                      |
| `IRC_HOST`             | *(unset)*                                         | IRC SSE endpoint. If unset, the presence manager is disabled |

### 2. Start the stack

```sh
docker compose up --build -d
```

This starts three services:

- **stasis-proxy** — the bot + proxy
- **postgres** — PostgreSQL 17 with persistent storage
- **redis** — Redis 7 with persistent storage

The proxy waits for Postgres and Redis to be healthy before starting.

### 3. Connect

Add `localhost:25577` (or your configured `PROXY_PORT`) as a server in your Minecraft client.

### Useful commands

```sh
# View logs
docker compose logs -f stasis-proxy

# Stop everything
docker compose down

# Stop and remove volumes (wipes database + redis data)
docker compose down -v

# Rebuild after code changes
docker compose up --build -d
```

### Using external databases

To use hosted Postgres/Redis instead of the local containers, set `DATABASE_URL` and/or `REDIS_URL` in your `.env` to point at your external instances. The compose defaults will be overridden.
