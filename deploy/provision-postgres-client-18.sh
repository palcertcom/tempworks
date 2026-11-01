#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# provision-postgres-client-18.sh — install a PostgreSQL 18 client toolchain
# that is version-compatible with the managed database (server 18.x).
#
# This is the REPRODUCIBLE fix for the production backup failure
#   "pg_dump: error: aborting because of server version mismatch
#    pg_dump: detail: server version: 18.6; pg_dump version: 17.7"
# pg_dump refuses to dump a server whose major version is NEWER than the
# client. The host shipped pg_dump 17.7; the database is 18.6.
#
# Run this on every host that executes backups (the app/worker host) as part
# of provisioning, and re-run it after any OS image rebuild/redeploy so the
# fix is not lost. It is idempotent.
#
# It installs the pinned PGDG client (pg_dump, pg_restore, psql, pg_dumpall)
# for PostgreSQL 18 WITHOUT touching or downgrading any database server.
#
# Usage:  sudo deploy/provision-postgres-client-18.sh [MAJOR]   (default 18)
# After:  set PG_BIN_PATH=/usr/lib/postgresql/18/bin  (optional; the app also
#         auto-detects the newest installed client >= the server major).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
MAJOR="${1:-18}"

if [ "$(id -u)" -ne 0 ]; then echo "Run as root (sudo)."; exit 1; fi
. /etc/os-release

echo ">> Installing PostgreSQL ${MAJOR} client tools (PGDG, pinned) …"

install -d /usr/share/postgresql-common/pgdg
curl -fsS https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

apt-get update -o Acquire::Retries=3
# Pin to the client package for the requested major version. We intentionally
# install ONLY the client tools on an app/worker host (not a database server).
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  "postgresql-client-${MAJOR}"

BINDIR="/usr/lib/postgresql/${MAJOR}/bin"
echo ">> Installed:"
"${BINDIR}/pg_dump"    --version
"${BINDIR}/pg_restore" --version
"${BINDIR}/psql"       --version
"${BINDIR}/pg_dumpall" --version

cat <<EOF

✓ PostgreSQL ${MAJOR} client tools installed at ${BINDIR}

Next steps (persist these so backups keep working after redeploys):
  1. Export PG_BIN_PATH in the app/worker service environment:
        PG_BIN_PATH=${BINDIR}
     (Optional — the app auto-detects the newest client >= the DB server major,
      but pinning avoids ambiguity if an older client is also present.)
  2. Ensure BACKUP_DIR points at a PERSISTENT volume (not ephemeral container
     storage) so backups survive restarts/redeploys — see
     docs/DISASTER_RECOVERY_RUNBOOK.md §Storage.
  3. Re-run this script from your provisioning/boot automation after every
     image rebuild so the version-correct client is always present.
EOF
