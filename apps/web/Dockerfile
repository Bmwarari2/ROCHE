# Harbour web (Next.js standalone server). One image for every environment: the API's address
# (API_BASE_URL or API_URL) is read when the server starts.
# Build from the repository root: docker build -f apps/web/Dockerfile -t harbour/web .
# Runtime contract: infra/README.md ("Runtime contract for application images").

FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true HUSKY=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @harbour/web... \
 && pnpm --filter @harbour/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone server carries only the traced dependencies; static chunks are copied beside it.
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone /app
COPY --from=build --chown=root:root /repo/apps/web/.next/static /app/apps/web/.next/static
# The only writable paths are /tmp and the Next.js cache (mounted as volumes in ECS).
RUN mkdir -p /app/apps/web/.next/cache && chown 1000:1000 /app/apps/web/.next/cache
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
