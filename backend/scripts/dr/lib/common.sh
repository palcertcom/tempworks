# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# TempWorks Disaster-Recovery toolkit — shared helpers
#
# Sourced by backup.sh / restore.sh / verify.sh / preflight.sh. Deliberately
# self-contained: it depends only on a POSIX shell, coreutils, and the
# PostgreSQL client tools. It never requires the application, Node, or the
# backup-catalog database — so it keeps working on a clean replacement server
# where all we have is the DR package and an empty PostgreSQL instance.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Per-process scratch dir (avoids clobbering when backups/restores/drills run
# concurrently on the same host).
DR_TMP="$(mktemp -d "${TMPDIR:-/tmp}/dr.XXXXXX")"
export DR_TMP

# ── Logging ──────────────────────────────────────────────────────────────────
# Everything goes to stderr so stdout stays clean for machine-readable output.
_ts()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
log()   { printf '%s [dr] %s\n'      "$(_ts)" "$*" >&2; }
warn()  { printf '%s [dr][WARN] %s\n' "$(_ts)" "$*" >&2; }
err()   { printf '%s [dr][ERROR] %s\n' "$(_ts)" "$*" >&2; }
die()   { err "$*"; exit 1; }

# ── Test-only failure injection ──────────────────────────────────────────────
# DR_TEST_FAIL_STAGE=<stage> makes that stage fail with exit status 97 so the
# regression tests can prove that (a) the ORIGINAL failure status propagates
# through the cleanup traps and (b) no partial package is left behind. Never
# set in production.
dr_test_fail() {   # $1 = stage name
  if [ "${DR_TEST_FAIL_STAGE:-}" = "$1" ]; then
    printf '%s [dr][TEST] injecting failure at stage %s (rc=97)\n' "$(_ts)" "$1" >&2
    return 97
  fi
  return 0
}

# ── Secret redaction ─────────────────────────────────────────────────────────
# Never print a password or a full connection string. redact() masks the
# userinfo portion of a postgres URL so it is safe to log.
redact() {
  printf '%s' "$1" | sed -E 's#(postgres(ql)?://)[^@/]+@#\1***:***@#'
}

# ── DATABASE_URL parsing ─────────────────────────────────────────────────────
# Populates the libpq PG* environment from a DATABASE_URL. We export the
# standard PG* vars rather than passing flags so every downstream tool
# (pg_dump, pg_restore, psql, pg_dumpall) inherits them identically and the
# password is never visible in `ps` output.
#
# Supported shape:
#   postgresql://user:pass@host:port/dbname?sslmode=require&...
parse_database_url() {
  local url="${1:-${DATABASE_URL:-}}"
  [ -n "$url" ] || die "DATABASE_URL is not set (and no URL argument given)."

  # Strip scheme
  local rest="${url#*://}"
  # Split off query string
  local query=""
  case "$rest" in
    *\?*) query="${rest#*\?}"; rest="${rest%%\?*}" ;;
  esac

  # userinfo@hostport/db
  local userinfo="" hostpart="" dbpart=""
  case "$rest" in
    *@*) userinfo="${rest%%@*}"; rest="${rest#*@}" ;;
  esac
  hostpart="${rest%%/*}"
  dbpart="${rest#*/}"

  local user="${userinfo%%:*}"
  local pass=""
  case "$userinfo" in *:*) pass="${userinfo#*:}" ;; esac

  local host="${hostpart%%:*}"
  local port=""
  case "$hostpart" in *:*) port="${hostpart#*:}" ;; esac

  # URL-decode user/pass (handle %XX and +)
  user="$(_urldecode "$user")"
  pass="$(_urldecode "$pass")"

  export PGHOST="${host:-localhost}"
  export PGPORT="${port:-5432}"
  export PGUSER="$user"
  export PGPASSWORD="$pass"
  export PGDATABASE="${dbpart%%\?*}"

  # Forward sslmode so SSL-only managed servers accept the connection.
  local sslmode=""
  if [ -n "$query" ]; then
    sslmode="$(printf '%s' "$query" | tr '&' '\n' | sed -n 's/^sslmode=//p' | head -n1)"
  fi
  if [ -n "$sslmode" ]; then
    export PGSSLMODE="$sslmode"
  fi
  # Certificate trust for libpq tools (same policy as prisma/pg-ssl.ts): a CA
  # given as PEM text in DATABASE_CA_CERT is written to a private temp file and
  # exported as PGSSLROOTCERT. libpq then VERIFIES the server chain even for
  # sslmode=require (and uses it as the anchor for verify-ca / verify-full).
  if [ -n "${DATABASE_CA_CERT:-}" ] && [ -z "${PGSSLROOTCERT:-}" ]; then
    ( umask 077; printf '%b\n' "$DATABASE_CA_CERT" >"$DR_TMP/db-ca.crt" )   # %b: also accepts a one-line value with literal \n
    export PGSSLROOTCERT="$DR_TMP/db-ca.crt"
  fi
}

_urldecode() {
  local s="${1//+/ }"
  printf '%b' "${s//%/\\x}"
}

# ── PostgreSQL toolchain resolution (the version-mismatch fix) ───────────────
# Root cause of the production 500: pg_dump refuses to dump a server whose
# major version is NEWER than the client (pg_dump 17.7 vs server 18.6). The
# old code picked /usr/bin/pg_dump first, so an installed v18 client was never
# used. Here we:
#   1. read the server's major version,
#   2. enumerate every candidate bindir,
#   3. choose the first whose pg_dump major >= server major (prefer exact),
#   4. fail with an actionable message if none qualifies.
#
# Honour PG_BIN_PATH as an explicit override (highest priority).

_bin_major() {            # $1 = path to pg_dump/pg_restore/etc.
  "$1" --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?' | head -n1 | cut -d. -f1
}

_candidate_bindirs() {
  [ -n "${PG_BIN_PATH:-}" ] && printf '%s\n' "$PG_BIN_PATH"
  # PGDG / RedHat / Homebrew versioned installs, newest first.
  ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -t/ -k5 -rn
  ls -d /usr/pgsql-*/bin          2>/dev/null | sort -rn
  ls -d /opt/homebrew/opt/postgresql@*/bin 2>/dev/null | sort -rn
  printf '%s\n' /usr/local/bin /usr/bin /opt/homebrew/bin
  # Anything else already on PATH.
  printf '%s\n' "${PATH//:/$'\n'}"
}

# Caches the resolved bindir in PG_RESOLVED_BINDIR.
resolve_pg_bindir() {
  local server_major="${1:-}"
  if [ -n "${PG_RESOLVED_BINDIR:-}" ]; then
    printf '%s' "$PG_RESOLVED_BINDIR"; return 0
  fi

  local best="" best_major=0 exact=""
  local seen=""
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    case ":$seen:" in *":$dir:"*) continue ;; esac
    seen="$seen:$dir"
    [ -x "$dir/pg_dump" ] || continue
    local m; m="$(_bin_major "$dir/pg_dump")"
    [ -n "$m" ] || continue
    if [ -n "$server_major" ] && [ "$m" -eq "$server_major" ] && [ -z "$exact" ]; then
      exact="$dir"
    fi
    if [ "$m" -gt "$best_major" ]; then best_major="$m"; best="$dir"; fi
  done < <(_candidate_bindirs)

  local chosen=""
  if [ -n "$exact" ]; then
    chosen="$exact"
  elif [ -n "$server_major" ] && [ "$best_major" -ge "$server_major" ]; then
    chosen="$best"        # newer client than server is fine for dumping
  elif [ -z "$server_major" ]; then
    chosen="$best"        # no server to compare against (offline restore)
  fi

  [ -n "$chosen" ] || return 1
  export PG_RESOLVED_BINDIR="$chosen"
  printf '%s' "$chosen"
}

# Echo server major version (e.g. 18) or empty on failure.
server_major_version() {
  local bindir
  bindir="$(resolve_pg_bindir "" 2>/dev/null || true)"
  local psql="${bindir:+$bindir/}psql"
  command -v "$psql" >/dev/null 2>&1 || psql="psql"
  local num
  num="$("$psql" -tAX -c "SHOW server_version_num" 2>/dev/null | tr -d '[:space:]')" || return 1
  [ -n "$num" ] || return 1
  printf '%s' $(( num / 10000 ))
}

# Sets PGDUMP / PGRESTORE / PSQL / PGDUMPALL to version-correct absolute paths.
# Pass the server major version when known; empty for offline restore targets.
select_pg_tools() {
  local server_major="${1:-}"
  local bindir
  if ! bindir="$(resolve_pg_bindir "$server_major")"; then
    local have
    have="$(for d in $(_candidate_bindirs); do [ -x "$d/pg_dump" ] && _bin_major "$d/pg_dump"; done | sort -rn | head -n1)"
    die "No pg_dump found whose major version >= server major (${server_major:-unknown}). \
Highest client available: ${have:-none}. Install the matching client, e.g. \
'postgresql-client-${server_major:-18}', or set PG_BIN_PATH to its bin directory. \
(See backend/scripts/dr/README.md / deploy/provision-postgres-client-18.sh.)"
  fi
  # Cache in the PARENT shell (resolve_pg_bindir's own export happens inside a
  # command-substitution subshell and would not propagate here).
  export PG_RESOLVED_BINDIR="$bindir"
  export PGDUMP="$bindir/pg_dump"
  export PGRESTORE="$bindir/pg_restore"
  export PSQL="$bindir/psql"
  export PGDUMPALL="$bindir/pg_dumpall"
  for t in "$PGDUMP" "$PGRESTORE" "$PSQL" "$PGDUMPALL"; do
    [ -x "$t" ] || die "Required tool missing in $bindir: $(basename "$t")"
  done
  log "pg toolchain: $bindir ($(pg_clean_version "$PGDUMP"))"
}

# Clean numeric version string, e.g. "18.6" (strips distro packaging suffix).
pg_clean_version() {       # $1 = path to a pg tool
  "$1" --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -n1
}

# Find a bindir whose pg_restore major exactly equals $1. Empty if none.
_bindir_for_major() {      # $1 = wanted major
  local want="$1" dir m
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    [ -x "$dir/pg_restore" ] || continue
    m="$(_bin_major "$dir/pg_restore")"
    if [ "$m" = "$want" ]; then printf '%s' "$dir"; return 0; fi
  done < <(_candidate_bindirs)
  return 1
}

# Toolchain selection for RESTORE. Unlike backup (where a client newer than the
# server is safe), restoring with a pg_restore whose major differs from the
# TARGET server is risky: an older client cannot read a newer archive, and a
# newer client can emit catalog SQL the older target rejects. So we:
#   1. require client major >= the archive's dump major (can read the archive),
#   2. PREFER an exact match to the target server major,
#   3. refuse a mismatch unless PG_ALLOW_VERSION_SKEW=1 (then warn loudly).
# Args: $1 target server major, $2 archive (dump) major (optional).
select_restore_tools() {
  local target_major="$1" archive_major="${2:-}"
  local exact; exact="$(_bindir_for_major "$target_major" || true)"
  local chosen=""

  if [ -n "$exact" ]; then
    chosen="$exact"
  elif [ "${PG_ALLOW_VERSION_SKEW:-0}" = "1" ]; then
    # Fall back to the newest client that can at least READ the archive.
    resolve_pg_bindir "$target_major" >/dev/null 2>&1 || true
    chosen="${PG_RESOLVED_BINDIR:-}"
    [ -n "$chosen" ] && warn "PG_ALLOW_VERSION_SKEW=1: using client major $(_bin_major "$chosen/pg_restore") against target major $target_major (version skew accepted by operator)."
  fi

  if [ -z "$chosen" ]; then
    local have; have="$(for d in $(_candidate_bindirs); do [ -x "$d/pg_restore" ] && _bin_major "$d/pg_restore"; done | sort -rn | head -n1)"
    die "No pg_restore matching the TARGET server major ($target_major) is installed (highest available: ${have:-none}). \
Install 'postgresql-client-${target_major}' (deploy/provision-postgres-client-18.sh) so the client matches the restore target, \
or set PG_ALLOW_VERSION_SKEW=1 to override (not recommended)."
  fi

  local cmaj; cmaj="$(_bin_major "$chosen/pg_restore")"
  if [ -n "$archive_major" ] && [ "$cmaj" -lt "$archive_major" ]; then
    die "pg_restore major $cmaj cannot read an archive created by pg_dump major $archive_major. \
Install a client >= $archive_major."
  fi

  export PG_RESOLVED_BINDIR="$chosen"
  export PGDUMP="$chosen/pg_dump" PGRESTORE="$chosen/pg_restore"
  export PSQL="$chosen/psql" PGDUMPALL="$chosen/pg_dumpall"
  for t in "$PGRESTORE" "$PSQL"; do [ -x "$t" ] || die "Required tool missing in $chosen: $(basename "$t")"; done
  log "restore toolchain: $chosen (pg_restore $(pg_clean_version "$PGRESTORE"); target major $target_major${archive_major:+, archive major $archive_major})"
}

# ── Checksums ────────────────────────────────────────────────────────────────
sha256_of() {            # $1 = file
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

human_bytes() {          # $1 = bytes
  local b="${1:-0}"
  awk -v b="$b" 'BEGIN{
    split("B KB MB GB TB", u, " "); i=1;
    while (b>=1024 && i<5){ b/=1024; i++ }
    printf (i==1 ? "%d %s" : "%.2f %s"), b, u[i]
  }'
}

file_size() {            # $1 = file -> bytes (0 if missing)
  [ -f "$1" ] && wc -c < "$1" | tr -d ' ' || echo 0
}

# JSON string escaper for the hand-built manifest (no jq dependency).
json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}
