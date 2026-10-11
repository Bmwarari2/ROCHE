# Harbour API, worker and migrate task (one image; the command chooses the process).
# Build from the repository root: docker build -f apps/api/Dockerfile -t harbour/api .
# Runtime contract: infra/README.md ("Runtime contract for application images").

FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true HUSKY=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @harbour/api... \
 && pnpm --filter @harbour/api build

FROM node:22-bookworm-slim AS certs
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /certs/rds-global-bundle.pem

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=certs --chown=root:root --chmod=0444 /certs/rds-global-bundle.pem /app/certs/rds-global-bundle.pem
COPY --from=build --chown=root:root /repo/apps/api/dist /app/apps/api/dist
# The bundles carry every dependency; nothing else from the build stage reaches production.
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/server.js"]
