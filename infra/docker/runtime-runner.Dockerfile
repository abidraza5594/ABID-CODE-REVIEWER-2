# Runtime-runner ships with Chromium bundled by Playwright.
# Use the official Playwright base image — it includes all required libs
# at the right glibc version. This image is ~1.2 GB but avoids the entire
# class of "missing libnss3 / libasound2" runtime crashes.

FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/runtime-runner apps/runtime-runner
# We don't run Playwright's `postinstall` — the base image has browsers preinstalled.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false

FROM deps AS build
RUN pnpm --filter @abid/runtime-runner... build

FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/runtime-runner/dist ./apps/runtime-runner/dist
COPY --from=build /app/apps/runtime-runner/package.json ./apps/runtime-runner/package.json
# Playwright base image runs as `pwuser`; we use that.
USER pwuser
CMD ["node", "apps/runtime-runner/dist/main.js"]
