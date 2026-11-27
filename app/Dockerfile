# Tracker — protected release image: one minified server file (licensing enforced), the built web app and the
# open-source libraries it needs. No source code, tests or vendor tools are in the final image.
#
#   docker build -t tracker:1.0.0 ./app
#   docker run -p 4000:4000 -e DATABASE_URL=postgres://… tracker:1.0.0
#
# --- build: compile the web app and bundle the server (source exists only in this stage)
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY server server
COPY client client
COPY scripts scripts
RUN npm run build -w server && npm run build -w client && node scripts/build-release.mjs

# --- deps: only the server's runtime libraries
FROM node:24-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server --include-workspace-root=false && rm -rf node_modules/@tracker

# --- final image
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 API_PORT=4000 SERVE_CLIENT=1 \
    CLIENT_DIST=/app/public ATTACHMENTS_DIR=/app/data/attachments PGLITE_DIR=/app/data/pglite \
    SKIP_SEED=1
WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/release/server ./server
COPY --from=build /src/client/dist ./public
RUN mkdir -p /app/data/attachments /app/data/pglite && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/tracker.mjs"]
