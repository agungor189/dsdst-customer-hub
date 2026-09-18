# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY shared ./shared
RUN npm run typecheck && npm test && npm run build

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production PORT=3100 DATABASE_PATH=/data/customer-hub.db ATTACHMENTS_DIR=/data/attachments
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY scripts/healthcheck.sh /usr/local/bin/customer-hub-healthcheck
COPY scripts ./scripts
RUN chmod 0555 /usr/local/bin/customer-hub-healthcheck /app/scripts/*.sh && mkdir -p /data/attachments && chown -R node:node /data
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["customer-hub-healthcheck"]
CMD ["node","dist-server/server/index.js"]
