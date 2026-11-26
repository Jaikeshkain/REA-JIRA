# Tracker: one image serving the API and the built web app on port 4000.
#   docker build -t tracker ./app
#   docker compose -f app/docker-compose.yml up -d     (with PostgreSQL; see app/README.md → Deploying)
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build -w server && npm run build -w client

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 API_PORT=4000 SERVE_CLIENT=1 DISABLE_SCHEDULER=
WORKDIR /app
COPY --from=build /app /app
# writable places: embedded database (only used without DATABASE_URL) and attachments
RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npx", "tsx", "server/src/index.ts"]
