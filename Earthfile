VERSION 0.8

# ── Bot image ─────────────────────────────────────────────
bot-image:
    FROM node:22-slim

    RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
        && rm -rf /var/lib/apt/lists/*

    WORKDIR /app

    COPY bot/package*.json ./
    RUN npm install --production

    COPY bot/ ./
    RUN rm -f .env wabot.db

    VOLUME /app/auth_info
    VOLUME /app/data

    CMD ["node", "wa.js"]
    SAVE IMAGE wabot-bot:latest

# ── Server image ──────────────────────────────────────────
server-image:
    FROM node:22-slim

    RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
        && rm -rf /var/lib/apt/lists/*

    WORKDIR /app

    COPY server/package*.json ./
    RUN npm install --production

    COPY server/ ./

    EXPOSE 3000
    CMD ["node", "server.js"]
    SAVE IMAGE wabot-server:latest

# ── Build all ─────────────────────────────────────────────
build:
    BUILD +bot-image
    BUILD +server-image
