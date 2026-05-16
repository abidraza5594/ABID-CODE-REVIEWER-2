# Orchestrator runs the full review pipeline. Includes git for cloning.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/orchestrator apps/orchestrator
COPY prompts prompts
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false

FROM deps AS build
RUN pnpm --filter @abid/orchestrator... build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && groupadd -r abid && useradd -r -g abid abid
COPY --from=build --chown=abid:abid /app/node_modules ./node_modules
COPY --from=build --chown=abid:abid /app/packages ./packages
COPY --from=build --chown=abid:abid /app/apps/orchestrator/dist ./apps/orchestrator/dist
COPY --from=build --chown=abid:abid /app/apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY --from=build --chown=abid:abid /app/prompts ./prompts
USER abid
CMD ["node", "apps/orchestrator/dist/main.js"]
