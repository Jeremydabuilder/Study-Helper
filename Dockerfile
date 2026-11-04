# Study Helper, hosted mode: ONE Node process (the only instance), PostgreSQL elsewhere, student files on a persistent volume mounted at DATA_DIR.
# Build stage: tools to compile the browser app and the server bundle. Final stage: production packages only.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build:hosted

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production APP_MODE=hosted
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
# The persistent volume is mounted here by the host. It is mounted owned by root on some hosts, so the process runs as root inside the container (nothing else runs here).
RUN mkdir -p /data
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
# Liveness only; the host's own health check should use /readyz (database reachable + data folder writable).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-server/main.mjs"]
