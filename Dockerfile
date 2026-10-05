# ── eLegal production image (Render) ──
FROM node:20-slim

# LibreOffice is required for DOCX/HTML → PDF conversion of Kenya Law source documents
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      fonts-liberation \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
 || npm install --omit=dev --no-audit --no-fund

# Copy application source, static assets and seed data
COPY . .

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=384 \
    PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
