FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY bot/package*.json ./bot/
RUN cd bot && npm install --production

COPY server/package*.json ./server/
RUN cd server && npm install --production

COPY bot/ ./bot/
COPY server/ ./server/
