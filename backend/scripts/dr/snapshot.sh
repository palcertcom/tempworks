#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# snapshot.sh — bounded-resource DR snapshots in a separate backup bucket.
#
# Thin wrapper around snapshot-engine.mjs: resolves a PostgreSQL toolchain whose
# major version matches/exceeds the server (same rules as backup.sh), exports
# PG* from DATABASE_URL, then runs the engine. Use this engine on hosts with a
# small ephemeral disk (App Platform); backup.sh stages the whole package
# locally and is meant for hosts with a disk larger than the dataset.
#
# Usage:
#   snapshot.sh backup --kind full|database [--label TEXT]
#   snapshot.sh list | verify <pkg> [--deep] | delete <pkg>
#   snapshot.sh export <pkg> > pkg.tar           (POSIX tar, streamed)
#   snapshot.sh materialize <pkg> <dir>          (package dir for verify.sh/restore.sh)
#   snapshot.sh cat <pkg> database/database.dump (one file to stdout)
#   snapshot.sh retention --keep N [--protect pkg1,pkg2]
#   snapshot.sh legacy-inventory                 (record THIS instance's legacy /uploads files)
#   snapshot.sh legacy-inventories               (which instances have reported, when, how many files)
# Exit: 0 ok/COMPLETE, 3 integrity failed, 4 INCOMPLETE, 5 lock busy, 6 DEGRADED (verify: intact but partial).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
trap 'rc=$?; rm -rf "$DR_TMP"; exit $rc' EXIT

CMD="${1:-}"
case "$CMD" in
  backup|retention)
    # These touch the database (dump / operation lock).
    parse_database_url
    SERVER_MAJOR="$(server_major_version || true)"
    [ -n "$SERVER_MAJOR" ] || die "Cannot reach database to read server version. Run preflight.sh for diagnostics."
    select_pg_tools "$SERVER_MAJOR" ;;
  verify) select_pg_tools "" ;;   # archive parsing only — no database needed
  list|export|materialize|cat|delete|probe|legacy-inventory|legacy-inventories) ;;
  *) die "usage: snapshot.sh backup|list|verify|export|materialize|cat|retention|delete|probe|legacy-inventory …" ;;
esac

# exec: the engine itself receives SIGTERM (redeploy) and cleans up; it also
# removes $DR_TMP on exit since this shell's EXIT trap no longer runs.
trap - EXIT
exec node "$HERE/snapshot-engine.mjs" "$@"
