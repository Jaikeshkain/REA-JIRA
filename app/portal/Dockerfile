# Owner portal image — for YOUR server only, never for customers. Your private key is NOT in the image:
# it's mounted at run time (see docker-compose.yml next to this file).
#   docker compose -f app/portal/docker-compose.yml up -d --build
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY server/src server/src
COPY portal portal
RUN npx esbuild portal/src/index.ts --bundle --platform=node --format=esm --target=node24 \
      --packages=external --minify --outfile=dist/portal.mjs

FROM node:24-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server --include-workspace-root=false && rm -rf node_modules/@tracker

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORTAL_HOST=0.0.0.0 PORTAL_PORT=4600 PORTAL_DATA=/data \
    PORTAL_PRIVATE_KEY=/run/secrets/vendor_key PORTAL_SECURE_COOKIES=1 PORTAL_TRUST_PROXY=1
WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist/portal.mjs ./portal.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4600
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4600/login').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "portal.mjs"]
