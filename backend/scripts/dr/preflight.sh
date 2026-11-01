#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# preflight.sh — verify the environment can actually produce a usable backup
# BEFORE we start one. Prints a human log to stderr and a machine-readable
# JSON summary to stdout. Exit code 0 = all hard checks passed.
#
# Checks: toolchain version compatibility, connectivity, dump permissions,
#         destination writability, and storage capacity.
#
# Usage: preflight.sh [--backup-dir DIR] [--require-offsite] [--engine staging|stream]
#   --engine stream: snapshots go straight to the backup bucket (snapshot.sh), so
#   the local destination/capacity checks are replaced by bucket access checks.
#   DATABASE_URL must be set (or exported PG* vars).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
trap 'rc=$?; rm -rf "$DR_TMP"; exit $rc' EXIT

BACKUP_DIR="${BACKUP_DIR:-$(pwd)/backups}"
REQUIRE_OFFSITE=0
ENGINE=staging
while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --require-offsite) REQUIRE_OFFSITE=1; shift ;;
    --engine) ENGINE="$2"; shift 2 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

parse_database_url

declare -a NAMES=() STATES=() DETAILS=()
HARD_FAIL=0
record() {  # $1 name  $2 state(pass|warn|fail)  $3 detail
  NAMES+=("$1"); STATES+=("$2"); DETAILS+=("$3")
  case "$2" in
    pass) log  "✓ $1 — $3" ;;
    warn) warn "~ $1 — $3" ;;
    fail) err  "✗ $1 — $3"; HARD_FAIL=1 ;;
  esac
}

# 1. Connectivity + server version ------------------------------------------------
SERVER_MAJOR=""
if SERVER_MAJOR="$(server_major_version)"; then
  record "connectivity" pass "connected to $(redact "postgresql://$PGUSER:x@$PGHOST:$PGPORT/$PGDATABASE"), server major $SERVER_MAJOR"
else
  record "connectivity" fail "cannot connect to $PGHOST:$PGPORT/$PGDATABASE as $PGUSER (check host, credentials, sslmode, firewall)"
fi

# 2. Toolchain version compatibility ---------------------------------------------
if [ -n "$SERVER_MAJOR" ]; then
  if select_pg_tools "$SERVER_MAJOR" 2>$DR_TMP/dr_tool_err; then
    CLIENT_VER="$(pg_clean_version "$PGDUMP")"
    record "toolchain" pass "pg_dump $CLIENT_VER (>= server $SERVER_MAJOR) at $PG_RESOLVED_BINDIR"
  else
    record "toolchain" fail "$(cat $DR_TMP/dr_tool_err)"
  fi
else
  record "toolchain" warn "skipped (no server version); ensure postgresql-client >= server major is installed"
fi

# 3. Dump permission (real schema-only dump to /dev/null) ------------------------
if [ -n "${PGDUMP:-}" ] && [ -n "$SERVER_MAJOR" ]; then
  if "$PGDUMP" --schema-only --no-owner --no-acl -f /dev/null >$DR_TMP/dr_perm_err 2>&1; then
    record "dump-permission" pass "role '$PGUSER' can read the full schema"
  else
    record "dump-permission" fail "pg_dump schema probe failed: $(tail -n1 $DR_TMP/dr_perm_err)"
  fi
fi

if [ "$ENGINE" = "stream" ]; then
# 4s. Backup bucket + upload source + temp disk (streaming engine) ------------------
  if PROBE="$(node "$HERE/snapshot-engine.mjs" probe 2>$DR_TMP/dr_probe_err)"; then :; fi
  if [ -n "${PROBE:-}" ]; then
    while IFS=$'\t' read -r n st d; do record "$n" "$st" "$d"; done < <(printf '%s' "$PROBE" | python3 -c '
import json, sys
for c in json.load(sys.stdin)["checks"]: print(c["name"], c["state"], c["detail"].replace("\t", " "), sep="\t")')
  else
    record "backup-destination" fail "probe failed: $(tail -n1 $DR_TMP/dr_probe_err)"
  fi
else
# 4. Destination writability -----------------------------------------------------
if mkdir -p "$BACKUP_DIR" 2>/dev/null && [ -w "$BACKUP_DIR" ]; then
  probe="$BACKUP_DIR/.dr_write_probe.$$"
  if printf 'ok' >"$probe" 2>/dev/null; then
    rm -f "$probe"
    record "destination" pass "backup dir writable: $BACKUP_DIR"
  else
    record "destination" fail "backup dir not writable: $BACKUP_DIR"
  fi
else
  record "destination" fail "cannot create/write backup dir: $BACKUP_DIR"
fi

# 5. Storage capacity vs database size -------------------------------------------
if [ -n "${PSQL:-}" ] && [ -n "$SERVER_MAJOR" ]; then
  DBSIZE="$("$PSQL" -tAX -c "SELECT pg_database_size(current_database())" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  # Available bytes on the backup filesystem.
  AVAIL_KB="$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
  AVAIL=$(( ${AVAIL_KB:-0} * 1024 ))
  # Custom-format dump is compressed; budget 60% of live size + uploads headroom.
  NEED=$(( DBSIZE * 6 / 10 ))
  if [ "$DBSIZE" -gt 0 ] && [ "$AVAIL" -gt 0 ]; then
    if [ "$AVAIL" -ge "$NEED" ]; then
      record "capacity" pass "db=$(human_bytes "$DBSIZE"), est. dump≈$(human_bytes "$NEED"), free=$(human_bytes "$AVAIL")"
    else
      record "capacity" fail "insufficient space: free=$(human_bytes "$AVAIL") < est. need=$(human_bytes "$NEED") (db=$(human_bytes "$DBSIZE"))"
    fi
  else
    record "capacity" warn "could not measure capacity (db=$DBSIZE bytes, free=${AVAIL} bytes)"
  fi
fi

# 6. Offsite destination (optional) ----------------------------------------------
if [ "$REQUIRE_OFFSITE" -eq 1 ]; then
  if [ -n "${BACKUP_SPACES_BUCKET:-}" ] && [ -n "${BACKUP_SPACES_ACCESS_KEY:-${DO_SPACES_ACCESS_KEY:-}}" ]; then
    record "offsite" pass "offsite target configured: bucket '$BACKUP_SPACES_BUCKET'"
  else
    record "offsite" fail "offsite required but BACKUP_SPACES_BUCKET / credentials are not configured"
  fi
fi

fi

# Emit JSON summary to stdout ----------------------------------------------------
{
  printf '{"preflight":"%s","serverMajor":%s,"checks":[' \
    "$([ "$HARD_FAIL" -eq 0 ] && echo ok || echo failed)" \
    "${SERVER_MAJOR:-null}"
  for i in "${!NAMES[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    printf '{"name":%s,"state":%s,"detail":%s}' \
      "$(json_escape "${NAMES[$i]}")" "$(json_escape "${STATES[$i]}")" "$(json_escape "${DETAILS[$i]}")"
  done
  printf ']}\n'
}

exit "$HARD_FAIL"
