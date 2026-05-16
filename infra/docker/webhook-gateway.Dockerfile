# Multi-stage build for the webhook gateway.
# Final image: ~80 MB on node:20-bookworm-slim.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/webhook-gateway apps/webhook-gateway
# Install workspace deps with frozen lockfile, no install scripts.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false

FROM deps AS build
RUN pnpm --filter @abid/webhook-gateway... build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && groupadd -r abid && useradd -r -g abid abid
COPY --from=build --chown=abid:abid /app/node_modules ./node_modules
COPY --from=build --chown=abid:abid /app/packages ./packages
COPY --from=build --chown=abid:abid /app/apps/webhook-gateway/dist ./apps/webhook-gateway/dist
COPY --from=build --chown=abid:abid /app/apps/webhook-gateway/package.json ./apps/webhook-gateway/package.json
USER abid
EXPOSE 8080
CMD ["node", "apps/webhook-gateway/dist/server.js"]
