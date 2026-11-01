# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# TempWorks backend — reproducible image for DigitalOcean App Platform.
#
# App Spec:  source_dir: /backend   (build context = this directory)
#            dockerfile_path: backend/Dockerfile   (relative to the repo root)
#
# * Builds WITHOUT any database or secret: nothing below reads DATABASE_URL
#   (a fixed placeholder satisfies prisma.config.ts at generate time only).
# * Runtime contains: compiled app, production node_modules incl. the Prisma
#   CLI (for `prisma migrate deploy` at start), the DR toolkit (scripts/dr),
#   PostgreSQL 18 client tools (pg_dump/pg_restore/psql/pg_dumpall — must be
#   >= the server major; production server is 18.x), python3 + bash for the DR
#   shell tooling, the ops diagnostics (scripts/ops: tls-check.mjs), and
#   tini as PID 1 (signal forwarding + zombie reaping).
# * Entry point keeps the existing start sequence: migrate deploy, then node.
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG PG_MAJOR=18
# Prisma schema-engine build the runtime needs (Debian bookworm ships libssl3).
ARG PRISMA_BINARY_TARGET=debian-openssl-3.0.x

# ── 0. OS layer shared by every stage ────────────────────────────────────────
# Prisma's postinstall picks the schema-engine binary from the OpenSSL it
# detects. The slim base has none, so without this layer it falls back to
# debian-openssl-1.1.x, while the runtime (libssl3 via the PostgreSQL client)
# needs debian-openssl-3.0.x: the CLI then tries to download it into the
# read-only node_modules at start and `prisma migrate deploy` fails.
FROM ${NODE_IMAGE} AS os
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssl ca-certificates; \
    rm -rf /var/lib/apt/lists/*

# ── 1. production dependencies (+ generated Prisma client) ───────────────────
FROM os AS prod-deps
ARG PRISMA_BINARY_TARGET
WORKDIR /app
COPY package.json package-lock.json ./
# devOptional packages (prisma CLI, its config loader) are kept by --omit=dev.
RUN npm ci --omit=dev --no-audit --no-fund \
 && test -x "node_modules/@prisma/engines/schema-engine-${PRISMA_BINARY_TARGET}"
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npx --no-install prisma generate

# ── 2. compile (needs devDependencies: nest CLI, typescript) ─────────────────
FROM os AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm run build \
 && test -f dist/src/main.js

# ── 3. runtime ───────────────────────────────────────────────────────────────
FROM os AS runtime
ARG PG_MAJOR
ARG PRISMA_BINARY_TARGET
# PostgreSQL client from the PGDG repository (Debian's own is v15).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl tini python3; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    pg_dump --version | grep -q " ${PG_MAJOR}\." ; \
    test -x "/usr/lib/postgresql/${PG_MAJOR}/bin/pg_restore"

WORKDIR /app
ENV NODE_ENV=production \
    PG_BIN_PATH=/usr/lib/postgresql/${PG_MAJOR}/bin \
    DR_SCRIPTS_DIR=/app/scripts/dr
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json prisma.config.ts .env.example ./
COPY prisma ./prisma
COPY scripts/dr ./scripts/dr
COPY scripts/ops ./scripts/ops
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && find scripts/dr -name '*.sh' -exec chmod 0755 {} + \
 && mkdir -p uploads backups && chown -R node:node uploads backups

USER node
# Fail the build unless the Prisma CLI runs as the runtime user with the engine
# already in the image (node_modules stays root-owned and read-only).
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npx --no-install prisma --version \
      | grep -F "schema-engine-${PRISMA_BINARY_TARGET})"
# App Platform routes to http_port (default 8080) and injects PORT; the app
# listens on $PORT.
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
