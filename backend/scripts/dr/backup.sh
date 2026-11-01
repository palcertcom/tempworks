#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup.sh — produce a portable TempWorks disaster-recovery package.
#
# A package is a self-describing directory (optionally tarred) containing:
#   database/globals.sql    roles, role memberships, tablespaces (pg_dumpall)
#   database/database.dump  schema + data + owners + ACLs + RLS + large objects
#                           (pg_dump --format=custom; internally consistent)
#   uploads/                (FULL kind) user files (local disk or Spaces mirror)
#   uploads.manifest.json   (FULL kind) per-file key/size/sha256 + DB x-ref
#   config/                 redacted env template, prisma schema, release id
#   MANIFEST.json           components, versions, sizes, checksums, consistency
#   CHECKSUMS.sha256        checksum of every component file
#
# The package restores on a clean server with restore.sh and needs neither the
# application nor the backup-catalog database to exist.
#
# Usage:
#   backup.sh --kind database|full [--out DIR] [--label TEXT]
#             [--offsite] [--no-tar] [--maintenance]
#
# Env: DATABASE_URL (required), BACKUP_DIR (default ./backups),
#      UPLOAD_STORAGE_DRIVER (local|spaces), UPLOAD_DEST, DO_SPACES_*/BACKUP_SPACES_*
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# backend/ itself (layout-independent: repo checkout or the /app container image)
BACKEND_DIR="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
trap 'rc=$?; rm -rf "$DR_TMP"; exit $rc' EXIT

KIND="database"
OUT_ROOT="${BACKUP_DIR:-$(pwd)/backups}"
LABEL=""
DO_OFFSITE=0
DO_TAR=1
MAINTENANCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="$2"; shift 2 ;;
    --out) OUT_ROOT="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --offsite) DO_OFFSITE=1; shift ;;
    --no-tar) DO_TAR=0; shift ;;
    --maintenance) MAINTENANCE=1; shift ;;
    *) die "Unknown argument: $1" ;;
  esac
done
case "$KIND" in database|full) ;; *) die "--kind must be 'database' or 'full'";; esac

parse_database_url
SERVER_MAJOR="$(server_major_version || true)"
[ -n "$SERVER_MAJOR" ] || die "Cannot reach database to read server version. Run preflight.sh for diagnostics."
select_pg_tools "$SERVER_MAJOR"

# ── Allocate package dir (atomic: build in .partial, publish at the end) ───────
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
ID="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
PKG_NAME="tempworks-dr_${TS}_${ID}"
WORK="$OUT_ROOT/.partial_$PKG_NAME"
FINAL="$OUT_ROOT/$PKG_NAME"
mkdir -p "$WORK/database" "$WORK/config"
# Preserve the ORIGINAL failing command's exit status: capture $? at trap entry
# and re-exit with it after cleaning the partial package, so a failure in any
# stage (dump, file copy, archive, verify, manifest) propagates unchanged and
# never leaves a half-written package behind that could look complete.
trap 'rc=$?; err "backup aborted at stage (rc=$rc); removing partial package"; rm -rf "$WORK"; exit $rc' ERR

log "DR backup starting: kind=$KIND package=$PKG_NAME"
log "source: $(redact "postgresql://$PGUSER:x@$PGHOST:$PGPORT/$PGDATABASE") (server major $SERVER_MAJOR)"

CONSISTENCY="online-snapshot"
if [ "$MAINTENANCE" -eq 1 ]; then
  CONSISTENCY="maintenance-window"
  warn "maintenance mode requested — caller is responsible for pausing writes (see runbook §Consistency)."
fi

# ── 1. Cluster globals (roles / memberships / tablespaces) ─────────────────────
GLOBALS_OK=true; GLOBALS_ERR=""
log "dumping cluster globals (--globals-only --no-role-passwords)…"
if ! "$PGDUMPALL" --globals-only --no-role-passwords >"$WORK/database/globals.sql" 2>$DR_TMP/dr_globals_err; then
  GLOBALS_OK=false
  GLOBALS_ERR="$(tr '\n' ' ' <$DR_TMP/dr_globals_err | sed 's/  */ /g')"
  warn "globals dump failed (managed provider may restrict this): $GLOBALS_ERR"
  warn "continuing — database dump still captures per-object ownership/ACLs; roles must be recreated at restore (runbook §Roles)."
  : >"$WORK/database/globals.sql"
fi

# ── 2. Database dump (full fidelity: owners, ACLs, RLS, large objects) ─────────
# ── 1b. Database-level properties (owner, encoding/locale, DB grants, settings) ──
# A plain pg_dump archive does NOT contain these (they are only emitted with
# --create). Without them a recovered database is owned by whoever ran
# CREATE DATABASE and the app role loses CREATE on schema public (PG15+), so
# its boot-time schema healing and every future migration fail. Capture them
# with pg_dump's own version-correct --create logic, keeping only the
# database-level statements.
log "capturing database-level properties (owner, encoding, locale, DB grants, settings)…"
"$PGDUMP" --create --schema-only --no-comments -f "$DR_TMP/create.sql"
grep -E '^(CREATE DATABASE|ALTER DATABASE|GRANT .* ON DATABASE|REVOKE .* ON DATABASE|ALTER ROLE .* IN DATABASE)' \
  "$DR_TMP/create.sql" >"$WORK/database/database-properties.sql" || true
DB_PROPS="$("$PSQL" -tAX -F '|' -c "SELECT d.datname, pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding),
  d.datcollate, d.datctype, d.datlocprovider FROM pg_database d WHERE d.datname = current_database()")"
IFS='|' read -r DB_NAME DB_OWNER DB_ENCODING DB_COLLATE DB_CTYPE DB_LOCPROV <<<"$DB_PROPS"
log "database '$DB_NAME': owner=$DB_OWNER encoding=$DB_ENCODING collate=$DB_COLLATE ctype=$DB_CTYPE provider=$DB_LOCPROV"
grep -q '^CREATE DATABASE' "$WORK/database/database-properties.sql" \
  || die "could not capture CREATE DATABASE properties (pg_dump --create produced none)"

# ── 1c. Database prerequisites (required roles, memberships, settings,
#        extensions) from catalogs any role can read — works where pg_dumpall is
#        refused, and makes a restore into a FRESH cluster possible (lib/prereqs.sql).
PREREQ_OK=false; PREREQ_ERR=""; PREREQ_SUMMARY='{}'
PROVIDER_ROLES_RE="${DR_PROVIDER_ROLES:-^(postgres|doadmin|_dodb|rdsadmin|rds_superuser|rdsrepladmin|cloudsqladmin|cloudsqlsuperuser|azure_pg_admin|azuresu|pg_.*)$}"
log "capturing database prerequisites (required roles, memberships, extensions)…"
if dr_test_fail prereqs 2>"$DR_TMP/prereq.err" \
   && "$PSQL" -X -q -tA -v ON_ERROR_STOP=1 -f "$HERE/lib/prereqs.sql" >"$WORK/database/prerequisites.json" 2>>"$DR_TMP/prereq.err" \
   && python3 "$HERE/lib/prereqs.py" roles-sql "$WORK/database/prerequisites.json" "$PROVIDER_ROLES_RE" >"$WORK/database/roles.sql" 2>>"$DR_TMP/prereq.err" \
   && PREREQ_SUMMARY="$(python3 "$HERE/lib/prereqs.py" summary "$WORK/database/prerequisites.json" "$PROVIDER_ROLES_RE")"; then
  PREREQ_OK=true
  log "prerequisites: required roles $(printf '%s' "$PREREQ_SUMMARY" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["requiredRoles"], "extensions", d["extensions"])')"
else
  PREREQ_ERR="$(tr '\n' ' ' <"$DR_TMP/prereq.err" | sed 's/  */ /g' | tail -c 400)"
  err "database prerequisites could not be captured: $PREREQ_ERR — the package will be marked INCOMPLETE"
  rm -f "$WORK/database/prerequisites.json" "$WORK/database/roles.sql"
fi

# ── 2+3. Consistent capture: database dump + uploaded files ─────────────────────
#
# Coordination strategy (online, no write pause):
#   1. pg_dump takes ONE repeatable-read MVCC snapshot → internally consistent DB.
#   2. Files are captured AFTER the snapshot.
#   3. refcheck.py extracts every storage reference FROM THE DUMP ITSELF (same
#      snapshot) and checks each one is present in the captured files.
#   4. A reference can only go missing if the object was deleted/replaced-and-
#      purged between the snapshot and the file capture. If that happens the
#      whole capture is retried (BACKUP_CONSISTENCY_RETRIES, default 2). If it
#      still fails, the package is published but marked INCOMPLETE and the
#      script exits 4 — it is never reported as a complete/verified backup.
#   Uploads created after the snapshot appear as harmless unreferenced objects.
UPLOADS_INCLUDED=false
UPLOADS_COUNT=0
UPLOADS_BYTES=0
UPLOADS_DRIVER="${UPLOAD_STORAGE_DRIVER:-local}"
LEGACY_LOCAL_COUNT=0
STORAGE_BASE=""
[ "$UPLOADS_DRIVER" = "spaces" ] && STORAGE_BASE="${DO_SPACES_PUBLIC_URL%/}"
MAX_ATTEMPTS=$(( 1 + ${BACKUP_CONSISTENCY_RETRIES:-2} ))
ATTEMPT=0
UPLOADS_COMPLETE=true
REFCHECK_JSON='{}'

manifest_for_dir() {   # $1 dir  $2 driver-label -> JSON on stdout
  python3 - "$1" "$2" <<'PY'
import hashlib, json, os, sys
root, drv = sys.argv[1], sys.argv[2]
files = []
for dp, _, fns in os.walk(root):
    for fn in fns:
        p = os.path.join(dp, fn)
        h = hashlib.sha256()
        with open(p, 'rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                h.update(chunk)
        st = os.stat(p)
        files.append({"key": os.path.relpath(p, root).replace(os.sep, '/'),
                      "size": st.st_size, "sha256": h.hexdigest(),
                      "token": f"{st.st_size}:{st.st_mtime_ns}"})
print(json.dumps({"driver": drv, "count": len(files), "files": files}, indent=0))
PY
}

# Change tokens of every stored object, taken BEFORE the database snapshot.
# refcheck.py compares them with the tokens of the bytes actually captured:
# a referenced object whose token changed was overwritten after the snapshot,
# so its captured bytes may not match the database state -> retry.
#   object storage: ETag    local files: "<size>:<mtime_ns>"
pre_tokens() {         # -> JSON {"object":{key:token}, "local":{key:token}} on stdout
  local obj='{}' loc_dir=""
  if [ "$UPLOADS_DRIVER" = "spaces" ]; then
    obj="$(node "$HERE/spaces-sync.mjs" list-tokens 2>>"$DR_TMP/tokens.err")" || die "could not list object tokens: $(tail -n1 "$DR_TMP/tokens.err")"
    loc_dir="${LEGACY_UPLOADS_DIR:-${UPLOAD_DEST:-$BACKEND_DIR/uploads}}"
  else
    loc_dir="${UPLOAD_DEST:-$BACKEND_DIR/uploads}"
  fi
  printf '%s' "$obj" | python3 -c '
import json, os, sys
obj = json.load(sys.stdin); root = sys.argv[1]; loc = {}
if os.path.isdir(root):
    for dp, _, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            try: st = os.stat(p)
            except FileNotFoundError: continue
            loc[os.path.relpath(p, root).replace(os.sep, "/")] = f"{st.st_size}:{st.st_mtime_ns}"
print(json.dumps({"object": obj, "local": loc}))' "$loc_dir"
}

copy_local_tree() {    # $1 src  $2 dest
  mkdir -p "$2"
  [ -d "$1" ] || return 0
  ( cd "$1" && find . -type f -not -path './.partial_*' -print0 \
      | while IFS= read -r -d '' f; do
          d="$2/${f#./}"; mkdir -p "$(dirname "$d")"
          # A file deleted between listing and copying (concurrent purge) is
          # not fatal — refcheck.py decides whether the DB still needs it.
          cp -p "$f" "$d" 2>/dev/null || [ ! -e "$f" ] || { echo "copy failed: $f" >&2; exit 1; }
        done )
}

while :; do
  ATTEMPT=$((ATTEMPT + 1))
  rm -rf "$WORK/uploads" "$WORK/uploads-legacy-local" "$WORK/uploads.manifest.json" \
         "$WORK/uploads-legacy-local.manifest.json" "$WORK/database/database.dump"

  if [ "$KIND" = "full" ]; then
    pre_tokens >"$DR_TMP/pre-tokens.json"
    # Every key seen in ANY attempt: a file that existed during the backup and
    # vanished is a race (→ INCOMPLETE), never a "pre-existing" gap.
    python3 - "$DR_TMP/pre-tokens.json" "$DR_TMP/seen-tokens.json" <<'PYS'
import json, os, sys
cur = json.load(open(sys.argv[1])); seen = json.load(open(sys.argv[2])) if os.path.exists(sys.argv[2]) else {"object": {}, "local": {}}
for ns in ("object", "local"):
    seen.setdefault(ns, {}).update(cur.get(ns, {}))
json.dump(seen, open(sys.argv[2], "w"))
PYS
  fi
  log "dumping database '$PGDATABASE' (custom format, owners+ACLs+large objects) [attempt $ATTEMPT/$MAX_ATTEMPTS]…"
  "$PGDUMP" \
    --format=custom \
    --verbose \
    --file="$WORK/database/database.dump" \
    2> >(grep -vE '^pg_dump: (dumping|reading|finding|saving|processing)' >&2 || true)
  log "database dump complete ($(human_bytes "$(file_size "$WORK/database/database.dump")"))"
  dr_test_fail dump

  [ "$KIND" = "full" ] || break

  # TEST-ONLY hook: widen the snapshot→file-capture window so the concurrency
  # test can deterministically race deletions/replacements against a backup.
  if [ -n "${DR_TEST_PAUSE_AFTER_DUMP_SECS:-}" ] && [ "$ATTEMPT" -eq 1 ]; then
    warn "DR_TEST_PAUSE_AFTER_DUMP_SECS=$DR_TEST_PAUSE_AFTER_DUMP_SECS (test hook) — pausing before file capture"
    : >"${DR_TEST_SIGNAL_FILE:-/dev/null}" 2>/dev/null || true
    sleep "$DR_TEST_PAUSE_AFTER_DUMP_SECS"
  fi

  mkdir -p "$WORK/uploads"
  if [ "$UPLOADS_DRIVER" = "spaces" ]; then
    log "mirroring object-storage bucket into package (driver=spaces)…"
    command -v node >/dev/null 2>&1 && [ -d "$BACKEND_DIR/node_modules/@aws-sdk/client-s3" ] \
      || die "driver=spaces but node / @aws-sdk/client-s3 unavailable; cannot mirror uploads. Run from the backend host after 'npm ci'."
    node "$HERE/spaces-sync.mjs" download "$WORK/uploads" >"$WORK/uploads.manifest.json" 2>$DR_TMP/dr_spaces_err \
      || die "object-storage mirror failed: $(tail -n2 $DR_TMP/dr_spaces_err)"
    # Historical rows may still reference legacy local "/uploads/..." files
    # served from <cwd>/uploads even when new uploads go to object storage.
    LEGACY_SRC="${LEGACY_UPLOADS_DIR:-${UPLOAD_DEST:-$BACKEND_DIR/uploads}}"
    if [ -d "$LEGACY_SRC" ] && [ -n "$(find "$LEGACY_SRC" -type f ! -name .gitkeep -print -quit 2>/dev/null)" ]; then
      log "also capturing legacy local uploads from $LEGACY_SRC …"
      copy_local_tree "$LEGACY_SRC" "$WORK/uploads-legacy-local"
      find "$WORK/uploads-legacy-local" -name .gitkeep -delete 2>/dev/null || true
      manifest_for_dir "$WORK/uploads-legacy-local" "legacy-local" >"$WORK/uploads-legacy-local.manifest.json"
    fi
  else
    SRC="${UPLOAD_DEST:-$BACKEND_DIR/uploads}"
    log "copying local uploads from $SRC …"
    [ -d "$SRC" ] || warn "local uploads dir not found ($SRC) — package will contain no files."
    copy_local_tree "$SRC" "$WORK/uploads"
    find "$WORK/uploads" -name .gitkeep -delete 2>/dev/null || true
    manifest_for_dir "$WORK/uploads" "local" >"$WORK/uploads.manifest.json"
  fi
  UPLOADS_INCLUDED=true
  dr_test_fail copy

  log "checking every storage reference in the dump is present in the capture…"
  REFCHECK_JSON="$(python3 "$HERE/lib/refcheck.py" "$PGRESTORE" "$WORK/database/database.dump" "$WORK" "$UPLOADS_DRIVER" "$STORAGE_BASE" "$DR_TMP/pre-tokens.json" "$DR_TMP/seen-tokens.json")"
  printf '%s\n' "$REFCHECK_JSON" >"$WORK/uploads.refcheck.json"
  # Races (vanished/overwritten while the backup ran) are retried; references
  # already absent BEFORE the snapshot are a pre-existing gap → DEGRADED.
  MISSING_N="$(printf '%s' "$REFCHECK_JSON" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("raceCount",d.get("missingCount",1)))')"
  DANGLING_N="$(printf '%s' "$REFCHECK_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("danglingCount",0))')"
  REF_N="$(printf '%s' "$REFCHECK_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("referenced",0))')"
  if [ "$MISSING_N" = "0" ]; then
    UPLOADS_COMPLETE=true
    if [ "$DANGLING_N" != "0" ]; then
      UPLOADS_COMPLETE=false
      warn "consistency: $DANGLING_N referenced file(s) were already absent from this host's storage before the backup — package will be DEGRADED"
    fi
    log "✓ consistency: no referenced file changed or vanished during the backup ($REF_N referenced)"
    break
  fi
  if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
    warn "consistency: $MISSING_N referenced file(s) missing or overwritten during backup — retrying capture"
    continue
  fi
  UPLOADS_COMPLETE=false
  err "consistency: $MISSING_N referenced file(s) still missing after $ATTEMPT attempt(s) — package will be marked INCOMPLETE"
  break
done

if [ "$KIND" = "full" ]; then
  UPLOADS_COUNT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("count",0))' "$WORK/uploads.manifest.json" 2>/dev/null || echo 0)"
  UPLOADS_BYTES="$(python3 -c 'import json,sys;print(sum(f["size"] for f in json.load(open(sys.argv[1])).get("files",[])))' "$WORK/uploads.manifest.json" 2>/dev/null || echo 0)"
  [ -f "$WORK/uploads-legacy-local.manifest.json" ] && \
    LEGACY_LOCAL_COUNT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("count",0))' "$WORK/uploads-legacy-local.manifest.json")"
  log "uploads captured: $UPLOADS_COUNT object(s), $(human_bytes "$UPLOADS_BYTES") (driver=$UPLOADS_DRIVER), legacy local: $LEGACY_LOCAL_COUNT"
fi
MISSING_REFS="$(printf '%s' "$REFCHECK_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("referenced",0))' 2>/dev/null || echo 0)"
RACE_N="${MISSING_N:-0}"; DANGLING_N="${DANGLING_N:-0}"
[ "$KIND" = "full" ] || { RACE_N=0; DANGLING_N=0; }
# Recovery completeness (independent of artifact integrity, which verify.sh checks):
if [ "$PREREQ_OK" != true ] || [ "$RACE_N" != "0" ]; then RECOVERABILITY=INCOMPLETE
elif [ "$DANGLING_N" != "0" ]; then RECOVERABILITY=DEGRADED
else RECOVERABILITY=COMPLETE; fi
export PREREQ_SUMMARY
log "recoverability: $RECOVERABILITY"

# ── 4. Config / release material (no secrets) ──────────────────────────────────
log "capturing config + release identifiers (redacted)…"
[ -f "$BACKEND_DIR/.env.example" ] && cp "$BACKEND_DIR/.env.example" "$WORK/config/backend.env.example"
[ -f "$REPO_ROOT/.env.example" ]         && cp "$REPO_ROOT/.env.example"         "$WORK/config/frontend.env.example"
[ -f "$BACKEND_DIR/prisma/schema.prisma" ] && cp "$BACKEND_DIR/prisma/schema.prisma" "$WORK/config/schema.prisma"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
APP_VERSION="$(node -e "console.log(require('$BACKEND_DIR/package.json').version)" 2>/dev/null || echo unknown)"
{
  echo "appVersion=$APP_VERSION"
  echo "gitSha=$GIT_SHA"
  echo "capturedAt=$(_ts)"
} >"$WORK/config/release.txt"
cp "$HERE/RUNBOOK_POINTER.txt" "$WORK/RUNBOOK.md" 2>/dev/null || \
  echo "See docs/DISASTER_RECOVERY_RUNBOOK.md in the TempWorks repository (gitSha $GIT_SHA)." >"$WORK/RUNBOOK.md"

# ── 5. Checksums + manifest ─────────────────────────────────────────────────────
log "computing checksums…"
( cd "$WORK" && find . -type f ! -name CHECKSUMS.sha256 ! -name MANIFEST.json -print0 \
    | sort -z | xargs -0 sha256sum ) >"$WORK/CHECKSUMS.sha256"

DB_DUMP_SHA="$(sha256_of "$WORK/database/database.dump")"
DB_DUMP_BYTES="$(file_size "$WORK/database/database.dump")"
GLOBALS_SHA="$(sha256_of "$WORK/database/globals.sql")"
GLOBALS_BYTES="$(file_size "$WORK/database/globals.sql")"

# Row-count snapshot for post-restore verification.
log "snapshotting table row counts for verification…"
"$PSQL" -tAX <<'SQL' >"$WORK/database/rowcounts.tsv" 2>/dev/null || true
SELECT relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY relname;
SQL
ROWCOUNT_TABLES="$(wc -l <"$WORK/database/rowcounts.tsv" | tr -d ' ')"

# Shell booleans -> Python literals for the hand-built manifest.
GLOBALS_PY=$([ "$GLOBALS_OK" = true ] && echo True || echo False)
UPLOADS_PY=$([ "$UPLOADS_INCLUDED" = true ] && echo True || echo False)

python3 - >"$WORK/MANIFEST.json" <<PY
import json
m = {
  "manifestVersion": "1.0",
  "package": "$PKG_NAME",
  "kind": "$KIND",
  "createdAt": "$(_ts)",
  "label": $(json_escape "$LABEL"),
  "consistency": "$CONSISTENCY",
  "source": {
    "host": $(json_escape "$PGHOST"),
    "database": $(json_escape "$PGDATABASE"),
    "serverMajor": $SERVER_MAJOR,
    "clientVersion": $(json_escape "$(pg_clean_version "$PGDUMP")")
  },
  "app": { "version": $(json_escape "$APP_VERSION"), "gitSha": $(json_escape "$GIT_SHA") },
  "components": {
    "globals": {
      "file": "database/globals.sql", "captured": $GLOBALS_PY,
      "bytes": $GLOBALS_BYTES, "sha256": $(json_escape "$GLOBALS_SHA"),
      "error": $(json_escape "$GLOBALS_ERR")
    },
    "database": {
      "file": "database/database.dump", "format": "custom",
      "bytes": $DB_DUMP_BYTES, "sha256": $(json_escape "$DB_DUMP_SHA"),
      "includesOwners": True, "includesAcls": True, "includesLargeObjects": True
    },
    "uploads": {
      "included": $( [ "$UPLOADS_INCLUDED" = true ] && echo True || echo False ),
      "driver": $(json_escape "$UPLOADS_DRIVER"),
      "count": $UPLOADS_COUNT, "bytes": $UPLOADS_BYTES,
      "manifest": "uploads.manifest.json",
      "legacyLocalCount": $LEGACY_LOCAL_COUNT,
      "dbReferencedObjects": ${MISSING_REFS:-0},
      "complete": $( [ "$UPLOADS_COMPLETE" = true ] && echo True || echo False ),
      "consistencyAttempts": $ATTEMPT,
      "refcheck": "uploads.refcheck.json"
    },
    "rowcounts": { "file": "database/rowcounts.tsv", "tables": $ROWCOUNT_TABLES },
    "prerequisites": dict(json.loads(__import__('os').environ.get('PREREQ_SUMMARY') or '{}'), file="database/prerequisites.json", rolesSql="database/roles.sql",
                          captured=("$PREREQ_OK" == "true"),
                          method="catalog" + ("" if $GLOBALS_PY else " (pg_dumpall refused)"),
                          error=$(json_escape "$PREREQ_ERR")),
    "databaseProperties": {
      "file": "database/database-properties.sql",
      "name": $(json_escape "$DB_NAME"), "owner": $(json_escape "$DB_OWNER"),
      "encoding": $(json_escape "$DB_ENCODING"), "collate": $(json_escape "$DB_COLLATE"),
      "ctype": $(json_escape "$DB_CTYPE"), "localeProvider": $(json_escape "$DB_LOCPROV")
    }
  },
  "storage": {
    "driver": $(json_escape "$UPLOADS_DRIVER"),
    "publicBaseUrl": $(json_escape "${STORAGE_BASE:-/uploads}"),
    "note": "fileUrl columns store this base; restore.sh rewrites it to the recovery storage base"
  },
  "recoverability": "$RECOVERABILITY",
  "recoveryIssues": [i for i in [
    dict(code="PREREQ_CAPTURE_FAILED", severity="INCOMPLETE", count=1,
         detail="required roles could not be read from the catalog: " + $(json_escape "$PREREQ_ERR"),
         action="fix catalog access for the backup role and back up again") if "$PREREQ_OK" != "true" else None,
    dict(code="FILES_CHANGED_DURING_BACKUP", severity="INCOMPLETE", count=$RACE_N,
         detail="referenced files vanished or were overwritten while the backup ran (after $ATTEMPT attempts)",
         action="not a consistent recovery point; back up again") if $RACE_N else None,
    dict(code="FILES_UNRESOLVED", severity="DEGRADED", count=$DANGLING_N,
         detail="referenced files were already absent from this host's storage before the backup (uploads.refcheck.json); the staging engine checks this host only",
         action="locate the files (other hosts/instances, earlier backups) or use the streaming engine, which also searches other instances and earlier snapshots") if $DANGLING_N else None,
    dict(code="GLOBALS_FROM_CATALOG", severity="INFO", count=1,
         detail="pg_dumpall --globals-only refused; required roles captured from the catalog (database/roles.sql)",
         action="none") if (not $GLOBALS_PY) and "$PREREQ_OK" == "true" else None,
  ] if i],
  "complete": "$RECOVERABILITY" == "COMPLETE",
  "catalogId": $(json_escape "${BACKUP_CATALOG_ID:-}"),
  "restoreWith": "backend/scripts/dr/restore.sh"
}
print(json.dumps(m, indent=2))
PY

# Refresh CHECKSUMS to include everything except itself.
( cd "$WORK" && find . -type f ! -name CHECKSUMS.sha256 -print0 \
    | sort -z | xargs -0 sha256sum ) >"$WORK/CHECKSUMS.sha256"

# ── 6. Publish atomically ───────────────────────────────────────────────────────
trap - ERR
mv "$WORK" "$FINAL"
log "package published: $FINAL"

ARTIFACT="$FINAL"
if [ "$DO_TAR" -eq 1 ]; then
  TARBALL="$FINAL.tar.gz"
  log "creating tarball $TARBALL …"
  ( cd "$OUT_ROOT" && tar -czf "$PKG_NAME.tar.gz.partial" "$PKG_NAME" && dr_test_fail archive \
      && mv "$PKG_NAME.tar.gz.partial" "$PKG_NAME.tar.gz" ) \
    || { rc=$?; err "archive creation failed (rc=$rc); removing partial tarball"; rm -f "$OUT_ROOT/$PKG_NAME.tar.gz.partial"; exit $rc; }
  TAR_SHA="$(sha256_of "$TARBALL")"
  echo "$TAR_SHA  $(basename "$TARBALL")" >"$TARBALL.sha256"
  log "tarball ready: $(human_bytes "$(file_size "$TARBALL")") sha256=$TAR_SHA"
  ARTIFACT="$TARBALL"
fi

# ── 7. Offsite copy (optional) + independent verification ───────────────────────
OFFSITE_STATUS="NONE"; OFFSITE_LOCATION=""
if [ "$DO_OFFSITE" -eq 1 ] && [ "$RECOVERABILITY" = "INCOMPLETE" ]; then
  OFFSITE_STATUS="SKIPPED_INCOMPLETE"
  warn "offsite upload skipped: package is INCOMPLETE (not a consistent recovery point)."
elif [ "$DO_OFFSITE" -eq 1 ]; then
  if command -v node >/dev/null 2>&1 && [ -d "$BACKEND_DIR/node_modules/@aws-sdk/client-s3" ]; then
    log "uploading package to offsite object storage…"
    if OFFSITE_PUT="$(node "$HERE/spaces-sync.mjs" offsite-put "$ARTIFACT" 2>$DR_TMP/dr_offsite_err)"; then
      OFFSITE_LOCATION="$(printf '%s' "$OFFSITE_PUT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("location",""))' 2>/dev/null || true)"
      OFFSITE_STATUS="UPLOADED"
      log "offsite upload complete: $OFFSITE_LOCATION"
      # Independently verify the uploaded copy (re-download + checksum) so an
      # incomplete/corrupt offsite copy is never reported as a usable backup.
      if node "$HERE/spaces-sync.mjs" offsite-verify "$ARTIFACT" >$DR_TMP/dr_offsite_v 2>>$DR_TMP/dr_offsite_err; then
        OFFSITE_STATUS="VERIFIED"
        log "offsite copy independently verified (sha256 match)."
      else
        OFFSITE_STATUS="VERIFY_FAILED"
        warn "offsite copy verification FAILED — treat offsite copy as unusable."
      fi
    else
      OFFSITE_STATUS="FAILED"
      warn "offsite upload failed: $(tail -n2 $DR_TMP/dr_offsite_err)"
    fi
  else
    OFFSITE_STATUS="SKIPPED"
    warn "--offsite requested but node/@aws-sdk unavailable; skipped. Copy $ARTIFACT off-server manually."
  fi
fi

# Machine-readable result to stdout (consumed by the NestJS service).
python3 - <<PY
import json
print(json.dumps({
  "package": "$PKG_NAME",
  "dir": "$FINAL",
  "artifact": "$ARTIFACT",
  "kind": "$KIND",
  "databaseSha256": "$DB_DUMP_SHA",
  "databaseBytes": $DB_DUMP_BYTES,
  "globalsCaptured": $GLOBALS_PY,
  "uploadsIncluded": $UPLOADS_PY,
  "uploadsCount": $UPLOADS_COUNT,
  "uploadsBytes": $UPLOADS_BYTES,
  "uploadsComplete": $( [ "$UPLOADS_COMPLETE" = true ] && echo True || echo False ),
  "consistencyAttempts": $ATTEMPT,
  "recoverability": "$RECOVERABILITY",
  "recoveryIssues": json.load(open("$FINAL/MANIFEST.json")).get("recoveryIssues", []),
  "danglingReferences": $DANGLING_N,
  "offsiteStatus": "$OFFSITE_STATUS",
  "offsiteLocation": "$OFFSITE_LOCATION"
}))
PY
if [ "$RECOVERABILITY" = "INCOMPLETE" ]; then
  err "DR backup INCOMPLETE: not a consistent recovery point (see MANIFEST.json recoveryIssues / uploads.refcheck.json)."
  exit 4
fi
if [ "$RECOVERABILITY" = "DEGRADED" ]; then
  err "DR backup DEGRADED: consistent, but $DANGLING_N referenced file(s) are missing — kept as a partial backup, NOT a complete recovery point."
  exit 6
fi
log "DR backup finished OK."
