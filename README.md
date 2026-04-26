<div align="center">
    <img
        src="https://i.ibb.co/1JQnjdwS/Frame-36.png"
        style="margin: 32px auto; display: block; max-width: 768px" />

<p align="left">
A self-hosted Minecraft stasis chamber proxy. Monitors active pearl chambers with an automated bot that you can connect to at any time, renders interactive holograms above active chambers, pulls pearls on demand teleporting you to the chamber at any time through chat and IRC integration. Tracks pearl ownership across multiple players, keeps the bot alive with built-in survival modules (anti-AFK, auto-eat, auto-totem, etc.), and persists all chamber data across restarts with PostgreSQL and Redis.
</p>

![](https://img.shields.io/github/package-json/v/stasisco/stasisproxy)
![](https://img.shields.io/github/license/stasisco/stasisproxy)

[![Continuous Integration](https://github.com/StasisCo/StasisProxy/actions/workflows/ci.yml/badge.svg)](https://github.com/StasisCo/StasisProxy/actions/workflows/ci.yml)
[![Continuous Deployment](https://github.com/StasisCo/StasisProxy/actions/workflows/cd.yml/badge.svg)](https://github.com/StasisCo/StasisProxy/actions/workflows/cd.yml)


</div>

# ✨ Features

Everything StasisProxy does to keep your pearls safe and your session seamless.

* **Connect at any time**: connect to the proxy at any time to control or view stasis chambers
* **IRC and Chat integration**: supports commands across in-game chat, whispers, and IRC
* **On demand pearl loading**: pulls a player's pearl on command, teleporting you to the chamber location within seconds
* **Pearl tracking**: detects and tracks ender pearls as they are thrown and enter stasis
* **Survival modules**: keeps the bot alive autonomously with a suite of modules (anti-AFK, auto-eat, auto-totem, and more)
* **Interactive holograms**: renders holograms above active chambers that update in real time and can be interacted with to pull the pearl
* **Persistent storage**: all chamber data is persisted across restarts with PostgreSQL and Redis

# 🚀 Quick Start

Get up and running in seconds using Docker.

### Prerequisites

- [Docker](https://www.docker.com/get-started)

### Running with Docker Compose

1. Clone the repository:
    ```bash
    git clone https://github.com/StasisCo/StasisProxy.git
    cd StasisProxy
    ```
    
2. Create a `.env` file in the root directory with the following content, replacing the placeholders with your actual values:
    ```env
    MC_HOST=2b2t.org
    MC_USERNAME=Username
    ```

3. Start the stack:
    ```bash
    docker compose up -d
    ```
    This brings up the proxy, PostgreSQL, and Redis. The proxy listens on port `25565` by default.