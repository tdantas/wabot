FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

VOLUME /app/auth_info

ENV NODE_ENV=production

CMD ["node", "wa.js"]
