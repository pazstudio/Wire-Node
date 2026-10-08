# ---------- Build the web frontend ----------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- Runtime: API server + built frontend ----------
FROM node:22-bookworm-slim AS app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/ ./
RUN npx prisma generate
COPY --from=web /web/dist ./public

ENV NODE_ENV=production \
    PORT=8080 \
    UPLOAD_DIR=/data/uploads \
    PUBLIC_DIR=/app/public
EXPOSE 8080
VOLUME ["/data/uploads"]

# Sync the database schema, then start the server.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx src/index.ts"]
