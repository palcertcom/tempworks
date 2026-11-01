#!/bin/sh
# Container start sequence — same order and failure semantics as the previous
# App Platform run command: apply Prisma migrations, then start the server.
# A failed migration stops the start (the deploy fails and the previous
# deployment keeps serving). Concurrent starts of several instances are safe:
# `prisma migrate deploy` serialises on a PostgreSQL advisory lock.
set -eu
cd /app
# An explicit command (docker run <image> <cmd…>, a console/one-off job) runs
# as-is, e.g. `node scripts/ops/tls-check.mjs` or `bash scripts/dr/snapshot.sh list`.
# With no command (App Platform service: no run_command) the server starts.
if [ "$#" -gt 0 ]; then exec "$@"; fi
echo "[entrypoint] $(node --version); $(pg_dump --version)"
if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=1 — not running prisma migrate deploy"
else
  # Prisma's migration engine does its own TLS (it ignores the Node adapter and
  # DATABASE_CA_CERT); sslmode=require alone does NOT verify the server. With
  # DATABASE_TLS_STRICT_MIGRATIONS=1 the CA is handed to it explicitly and the
  # certificate chain + host name are verified for this one command.
  MIGRATE_URL="$DATABASE_URL"
  if [ "${DATABASE_TLS_STRICT_MIGRATIONS:-0}" = "1" ] && [ -n "${DATABASE_CA_CERT:-}" ]; then
    ( umask 077; printf '%b\n' "$DATABASE_CA_CERT" >/tmp/db-ca.crt )
    case "$DATABASE_URL" in *\?*) sep='&' ;; *) sep='?' ;; esac
    MIGRATE_URL="${DATABASE_URL}${sep}sslcert=/tmp/db-ca.crt&sslaccept=strict"
    echo "[entrypoint] prisma migrate deploy (TLS: chain + host name verified against DATABASE_CA_CERT)"
  else
    echo "[entrypoint] prisma migrate deploy"
  fi
  DATABASE_URL="$MIGRATE_URL" npx --no-install prisma migrate deploy
fi
echo "[entrypoint] starting dist/src/main.js"
exec node dist/src/main.js
