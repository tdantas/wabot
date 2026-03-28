FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

VOLUME /app/data
VOLUME /app/auth_info

ENV NODE_ENV=production
ENV DB_PATH=/app/data/wabot.db

EXPOSE 3000

CMD ["node", "wa.js"]
