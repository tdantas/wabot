FROM node:22-slim

WORKDIR /app

COPY bot/package*.json ./bot/
RUN cd bot && npm install --production

COPY server/package*.json ./server/
RUN cd server && npm install --production

COPY bot/ ./bot/
COPY server/ ./server/
