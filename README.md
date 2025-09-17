# Stasis Bot
A Minecraft bot that manages stasis pearls allowing players to queue their stasis over game chat.

# Prerequisites
* PostgreSQL database
* Docker or Bun runtime
* Minecraft account for the bot

# Setup

## Environment Variables

The minimum required environment variables are:
* `DATABASE_URL` - Connection string for the PostgreSQL database
* `MC_HOST` - Hostname of the Minecraft server
* `MC_USERNAME` - Username of the Minecraft bot account

Additionally, you can set:
* `MC_ACCESS_TOKEN` - Access token for the Minecraft bot account (if needed)
* `MC_CACHE` - Credentials cache file path
* `MC_PASSWORD` - Password for the Minecraft bot account (if needed)
* `MC_REFRESH_TOKEN` - Refresh token for the Minecraft bot account (if needed)
* `MC_VERSION` - Minecraft version (default is detected automatically)

Other additional configuration variables as described in [`src/config.ts`](./src/config.ts).

## Database Setup

Use prisma to set up the database schema:
```bash
bunx prisma db push
```
> [!NOTE]
> Make sure your environment variables are set before running the above command.


## Running the Bot
You can run the bot using Bun:
```bash
bun start
```

Or using Docker:
```bash
docker run -d --env-file .env --name stasis-bot ghcr.io/ryanfortner/stasis-bot:latest
```