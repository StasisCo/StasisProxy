# StasisProxy

## Quick Start

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
    This brings up the proxy, PostgreSQL, and Redis. The proxy listens on port `25577` by default.