# Harbour web (Next.js standalone server). One image for every environment: the API's address
# (API_BASE_URL or API_URL) is read when the server starts.
# Build from the repository root: docker build -f apps/web/Dockerfile -t harbour/web .
# Runtime contract: infra/README.md ("Runtime contract for application images").
# The base image is pinned by digest in both stages, so every build starts from the same image and
# a new one arrives as a Renovate pull request, which the image scan in ci.yml checks.

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true HUSKY=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @harbour/web... \
 && pnpm --filter @harbour/web build

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS runtime
# The runtime never runs npm, npx or corepack. Removing them takes their bundled dependencies, and the
# advisories the image scan reports in them, out of the production image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone server carries only the traced dependencies; static chunks are copied beside it.
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone /app
COPY --from=build --chown=root:root /repo/apps/web/.next/static /app/apps/web/.next/static
# The only writable paths are /tmp and the Next.js cache (mounted as volumes on Cloud Run).
RUN mkdir -p /app/apps/web/.next/cache && chown 1000:1000 /app/apps/web/.next/cache
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
