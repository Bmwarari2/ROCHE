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

# No database CA is baked in (ADR-0098). The API reaches Cloud SQL on its private IP with TLS, and
# Cloud SQL's server CA belongs to the instance, so there is no global bundle to download at build
# time. The Cloud Run service mounts the instance's server CA from Secret Manager as a file
# (/secrets/cloudsql/server-ca.pem) and sets NODE_EXTRA_CA_CERTS to it. Without that variable, Node
# trusts only its own CAs, so a verifying connection to Cloud SQL fails rather than trusting
# anything else.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build --chown=root:root /repo/apps/api/dist /app/apps/api/dist
# The bundles carry every dependency; nothing else from the build stage reaches production.
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/server.js"]
