# syntax=docker/dockerfile:1.7
#
# One multi-stage Dockerfile builds every Node.js service image:
#   docker build -f infrastructure/docker/node-service.Dockerfile --build-arg SERVICE=order-service .
# The heavy stages (dependency install and TypeScript build) do not depend on
# SERVICE, so BuildKit reuses them across all services; only the final,
# service-specific stages differ.

ARG NODE_IMAGE=node:24-alpine

# ── 1. Extract package manifests so the dependency layer is cached until they change
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /manifests \
 && find . -name package.json -not -path '*/node_modules/*' \
      -exec sh -c 'mkdir -p "/manifests/$(dirname "$1")" && cp "$1" "/manifests/$1"' _ {} \; \
 && cp package-lock.json /manifests/

# ── 2. Full dependency install (dev dependencies are needed to compile)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY --from=manifests /manifests ./
# Optional `extra_ca` build secret: a PEM bundle for TLS-intercepting corporate
# proxies. It is only mounted during this step and never stored in a layer.
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund

# ── 3. Generate Prisma clients and compile every workspace
FROM deps AS build
COPY . .
RUN npm run build

# ── 4. Production dependencies for one service only
FROM ${NODE_IMAGE} AS prod-deps
ARG SERVICE
WORKDIR /app
COPY --from=manifests /manifests ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --omit=optional --omit=peer --no-audit --no-fund --workspace "apps/${SERVICE}" --include-workspace-root=false \
 # Only PostgreSQL is used: drop the other databases' query compilers and source maps.
 && if [ -d node_modules/@prisma/client/runtime ]; then \
      find node_modules/@prisma/client/runtime \( -name '*.mysql.*' -o -name '*.sqlite.*' -o -name '*.sqlserver.*' -o -name '*.cockroachdb.*' \) -delete; \
    fi \
 && find node_modules -name '*.map' -delete

# ── 5. Collect only compiled output and manifests
FROM build AS bundle
ARG SERVICE
RUN set -eu; \
    mkdir -p "/out/apps/${SERVICE}"; \
    cp -r "apps/${SERVICE}/dist" "apps/${SERVICE}/package.json" "/out/apps/${SERVICE}/"; \
    for pkg in packages/*; do mkdir -p "/out/${pkg}"; cp -r "${pkg}/dist" "${pkg}/package.json" "/out/${pkg}/"; done; \
    rm -rf /out/packages/testing; \
    find /out -name '*.test.*' -delete; \
    find /out -name '*.map' -delete; \
    cp package.json /out/

# ── 6. Migrator: one-shot release tool with the Prisma CLI and every service's
#       own migrations. Runtime images deliberately do not contain the CLI.
FROM build AS migrator
ENV NODE_ENV=production
RUN chown -R node:node /app/apps \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
ENTRYPOINT ["/bin/sh", "/app/infrastructure/docker/migrate.sh"]

# ── 7. Minimal runtime image (default target)
FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ENV NODE_ENV=production \
    SERVICE=${SERVICE}
# The runtime never uses a package manager: removing npm/npx/corepack shrinks the
# image and the attack surface (their bundled dependencies are a common CVE source).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app ./
COPY --from=bundle --chown=node:node /out ./
WORKDIR /app/apps/${SERVICE}
USER node
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
# Node runs as PID 1 and installs its own SIGTERM/SIGINT handlers for graceful
# shutdown. Compose additionally adds an init process (`init: true`).
CMD ["node", "--import", "./dist/telemetry.js", "dist/main.js"]
