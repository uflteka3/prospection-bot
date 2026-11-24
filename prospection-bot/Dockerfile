FROM node:20-bookworm-slim

# Chromium pour Puppeteer, git pour les dépendances de Baileys, outils de compilation pour better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium git ca-certificates python3 make g++ \
    fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src

EXPOSE 3000
CMD ["node", "src/index.js"]
