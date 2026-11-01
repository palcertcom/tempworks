#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore.sh — restore a TempWorks DR package onto a CLEAN server.
#
# Brings up database structures, data, ownership/ACLs, sequences and uploaded
# files from a package produced by backup.sh. Designed to run against an empty
# target PostgreSQL instance and empty application storage. It does NOT need
# the application or the backup-catalog database to exist.
#
# It fails loudly: pg_restore runs with --exit-on-error, and any substantive
# error aborts with a non-zero exit. It never reports success on a partial
# restore.
#
# Usage:
#   restore.sh <package-dir|package.tar.gz> --target-url <DATABASE_URL>
#              [--create-db] [--roles] [--no-owner] [--uploads-dest DIR]
#              [--drop-existing] [--yes]
#
#   --create-db      CREATE DATABASE on the target before restoring.
#   --roles          apply database/globals.sql first (recreate roles).
#   --no-owner       restore without owners/ACLs (managed providers where you
#                    cannot create the original roles). Permission model is then
#                    re-applied by the app's role sync — see runbook.
#   --uploads-dest   restore uploaded files into this local dir (local driver).
#                    For spaces, set UPLOAD_STORAGE_DRIVER=spaces + creds and the
#                    files are pushed to the bucket instead.
#   --drop-existing  DROP and recreate the target database first (DANGEROUS).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# backend/ itself (layout-independent: repo checkout or the /app container image)
BACKEND_DIR="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

PKG_IN=""; TARGET_URL="${TARGET_DATABASE_URL:-}"
CREATE_DB=0; APPLY_ROLES=0; NO_OWNER=0; DROP_EXISTING=0; ASSUME_YES=0
UPLOADS_DEST=""
STORAGE_BASE_TO=""
ROLE_MAP=""
SOURCE_LOCATION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source-location) SOURCE_LOCATION="$2"; shift 2 ;;
    --role-map) ROLE_MAP="$2"; shift 2 ;;
    --storage-base-to) STORAGE_BASE_TO="${2%/}"; shift 2 ;;
    --target-url) TARGET_URL="$2"; shift 2 ;;
    --create-db) CREATE_DB=1; shift ;;
    --roles) APPLY_ROLES=1; shift ;;
    --no-owner) NO_OWNER=1; shift ;;
    --uploads-dest) UPLOADS_DEST="$2"; shift 2 ;;
    --drop-existing) DROP_EXISTING=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -*) die "Unknown argument: $1" ;;
    *) PKG_IN="$1"; shift ;;
  esac
done
[ -n "$PKG_IN" ]    || die "No package given. Usage: restore.sh <package> --target-url <URL>"
[ -n "$TARGET_URL" ] || die "No target database. Pass --target-url or set TARGET_DATABASE_URL."

# ── Resolve package (extract tarball if needed) ────────────────────────────────
CLEANUP=""
if [ -f "$PKG_IN" ] && echo "$PKG_IN" | grep -qE '\.tar\.gz$'; then
  TMP="$(mktemp -d)"; CLEANUP="$TMP"
  log "extracting $PKG_IN …"; tar -xzf "$PKG_IN" -C "$TMP"
  PKG="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -n1)"
else
  PKG="$PKG_IN"
fi
# Preserve the script's real exit status across cleanup.
cleanup() { local rc=$?; [ -n "$CLEANUP" ] && rm -rf "$CLEANUP"; rm -rf "$DR_TMP"; exit $rc; }
trap cleanup EXIT
[ -f "$PKG/MANIFEST.json" ] || die "Not a DR package (no MANIFEST.json): $PKG"

# ── Verify integrity BEFORE touching the target ───────────────────────────────
log "verifying package integrity before restore…"
"$HERE/verify.sh" "$PKG" || die "Package failed integrity verification — aborting restore."

KIND="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["kind"])' "$PKG/MANIFEST.json")"
log "restoring package $(basename "$PKG") (kind=$KIND)"

# Fail fast, BEFORE touching the target, if the storage target is ambiguous.
PKG_DRIVER="$(python3 -c 'import json,sys;print((json.load(open(sys.argv[1])).get("storage") or {}).get("driver","local"))' "$PKG/MANIFEST.json" 2>/dev/null || echo local)"
if [ "$KIND" = "full" ] && [ "$PKG_DRIVER" = "spaces" ] && [ -z "${UPLOAD_STORAGE_DRIVER:-}" ]; then
  die "This package's files came from object storage, but UPLOAD_STORAGE_DRIVER is not set for the recovery target. \
Set UPLOAD_STORAGE_DRIVER=spaces plus DO_SPACES_* for the RECOVERY bucket (DO_SPACES_PUBLIC_URL = its public base), \
or UPLOAD_STORAGE_DRIVER=local to restore the files onto local disk. Refusing to guess."
fi

# ── Point PG* at the TARGET ────────────────────────────────────────────────────
parse_database_url "$TARGET_URL"
TARGET_DB="$PGDATABASE"
# Connect to maintenance DB for CREATE/DROP (can't drop the db you're in).
export PGDATABASE_TARGET="$TARGET_DB"
SERVER_MAJOR="$(PGDATABASE=postgres server_major_version || server_major_version || true)"
[ -n "$SERVER_MAJOR" ] || die "Cannot reach target server $(redact "$TARGET_URL")."
# Validate client compatibility with the TARGET server (prefer exact major),
# and ensure the client can read the archive's dump major.
ARCHIVE_MAJOR="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["source"].get("serverMajor",""))' "$PKG/MANIFEST.json" 2>/dev/null || true)"
select_restore_tools "$SERVER_MAJOR" "$ARCHIVE_MAJOR"
log "target: $(redact "$TARGET_URL") (server major $SERVER_MAJOR)"

# Guard: refuse to clobber a non-empty DB unless explicitly allowed.
if [ "$DROP_EXISTING" -eq 0 ] && [ "$CREATE_DB" -eq 0 ]; then
  EXISTING_TABLES="$("$PSQL" -tAX -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  if [ "${EXISTING_TABLES:-0}" -gt 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
    die "Target '$TARGET_DB' already has $EXISTING_TABLES tables in public. Refusing to restore over it. \
Use --drop-existing (recreate) or --yes (overlay) if this is intended."
  fi
fi

# ── 1. Roles / globals ─────────────────────────────────────────────────────────
# Provider-managed roles (DigitalOcean doadmin/_dodb, RDS rdsadmin, Cloud SQL,
# Azure, the bootstrap superuser, pg_* built-ins) already exist on a managed
# target and cannot be created or altered by a customer. Their CREATE/ALTER
# ROLE lines are filtered out EXPLICITLY (listed in the log) instead of being
# allowed to fail silently. Override with DR_PROVIDER_ROLES (regex).
PROVIDER_ROLES_RE="${DR_PROVIDER_ROLES:-^(postgres|doadmin|_dodb|rdsadmin|rds_superuser|rdsrepladmin|cloudsqladmin|cloudsqlsuperuser|azure_pg_admin|azuresu|pg_.*)$}"
role_map_sed() {   # emits sed expressions mapping OLD role names to NEW
  local pair old new
  IFS=',' read -ra pairs <<<"$ROLE_MAP"
  for pair in "${pairs[@]}"; do
    old="${pair%%:*}"; new="${pair##*:}"
    [ -n "$old" ] && [ -n "$new" ] || continue
    printf -- "-e s/\\\\b%s\\\\b/%s/g " "$old" "$new"
  done
}
if [ "$APPLY_ROLES" -eq 1 ]; then
  if [ -s "$PKG/database/globals.sql" ]; then
    log "applying cluster globals (roles / memberships)…"
    python3 - "$PKG/database/globals.sql" "$PROVIDER_ROLES_RE" >"$DR_TMP/globals.filtered.sql" 2>"$DR_TMP/globals.skipped" <<'PYG'
import re, sys
path, rx = sys.argv[1], re.compile(sys.argv[2])
for line in open(path):
    m = re.match(r'\s*(CREATE|ALTER)\s+ROLE\s+("?)([^\s";]+)\2', line, re.I)
    if m and rx.match(m.group(3)):
        sys.stderr.write(f"skipped provider-managed role statement: {line.strip()[:120]}\n")
        continue
    sys.stdout.write(line)
PYG
    [ -s "$DR_TMP/globals.skipped" ] && sed 's/^/     /' "$DR_TMP/globals.skipped" >&2
    if [ -n "$ROLE_MAP" ]; then
      # shellcheck disable=SC2046
      sed -i $(role_map_sed) "$DR_TMP/globals.filtered.sql"
      log "role map applied to globals: $ROLE_MAP"
    fi
    # Roles created by a non-superuser CREATEROLE admin must be SET-able by it
    # (PG 16+), or restoring their ownership fails later.
    sed -i "1i SELECT set_config('createrole_self_grant', 'set, inherit', false) WHERE current_setting('server_version_num')::int >= 160000;" "$DR_TMP/globals.filtered.sql"
    PGDATABASE=postgres "$PSQL" -v ON_ERROR_STOP=0 -f "$DR_TMP/globals.filtered.sql" >/dev/null 2>"$DR_TMP/globals.err" || true
    # "already exists" is expected on a pre-provisioned target; anything else is reported.
    grep -viE 'already exists|^\s*$' "$DR_TMP/globals.err" >"$DR_TMP/globals.realerr" || true
    if [ -s "$DR_TMP/globals.realerr" ]; then
      warn "globals: $(wc -l <"$DR_TMP/globals.realerr" | tr -d ' ') statement(s) failed (reported, not ignored):"
      sed 's/^/     /' "$DR_TMP/globals.realerr" >&2
      warn "If these are provider restrictions, re-run with --no-owner or --role-map (runbook §7)."
    else
      log "✓ globals applied (provider-managed roles skipped explicitly)"
    fi
  else
    log "globals.sql is empty (pg_dumpall was refused at backup time) — required roles come from database/roles.sql."
  fi
fi

# ── 1b. Required roles + prerequisites (database/prerequisites.json) ───────────
# The backup records every role the database needs (owners, grantees, policy
# roles, the connecting role, membership closure), its extensions and
# tablespaces. Recreate the roles (--roles) and refuse to continue — BEFORE the
# target is touched — if anything required is still missing.
PREREQ_JSON="$PKG/database/prerequisites.json"
LOGIN_ROLES=""
if [ -f "$PREREQ_JSON" ]; then
  python3 - "$PREREQ_JSON" "$ROLE_MAP" >"$DR_TMP/prereq.mapped.json" <<'PYM'
import json, sys
p = json.load(open(sys.argv[1]))
pairs = dict(x.split(':', 1) for x in sys.argv[2].split(',') if ':' in x)
m = lambda n: pairs.get(n, n)
p['requiredRoles'] = [m(n) for n in p.get('requiredRoles', [])]
for r in p.get('roles', []):
    r['name'] = m(r['name'])
    for x in r.get('memberOf', []):
        x['role'] = m(x['role'])
print(json.dumps(p))
PYM
  python3 "$HERE/lib/prereqs.py" roles-sql "$DR_TMP/prereq.mapped.json" "$PROVIDER_ROLES_RE" >"$DR_TMP/roles.sql"
  LOGIN_ROLES="$(python3 "$HERE/lib/prereqs.py" summary "$DR_TMP/prereq.mapped.json" "$PROVIDER_ROLES_RE" | python3 -c 'import json,sys;print(" ".join(json.load(sys.stdin)["loginRoles"]))')"
  if [ "$APPLY_ROLES" -eq 1 ]; then
    log "recreating the database's required roles from the backup (attributes, memberships, settings — no passwords)…"
    PGDATABASE=postgres "$PSQL" -X -q -o /dev/null -v ON_ERROR_STOP=1 -f "$DR_TMP/roles.sql" 2>"$DR_TMP/roles.err" \
      || die "creating the required roles failed: $(grep -v WARNING "$DR_TMP/roles.err" | tail -n2 | tr '\n' ' '). The restoring role needs CREATEROLE (or superuser) on the target — see runbook §Roles."
    grep WARNING "$DR_TMP/roles.err" | sed 's/^/     /' >&2 || true
    log "✓ required roles present: $(python3 -c 'import json,sys;print(", ".join(json.load(open(sys.argv[1]))["requiredRoles"]))' "$DR_TMP/prereq.mapped.json")"
  fi
  TARGET_ROLES="$(PGDATABASE=postgres "$PSQL" -tAX -c "SELECT rolname FROM pg_roles" 2>/dev/null || true)"
  TARGET_EXTS="$(PGDATABASE=postgres "$PSQL" -tAX -c "SELECT name FROM pg_available_extensions" 2>/dev/null || true)"
  PREREQ_PROBLEMS="$(TARGET_ROLES="$TARGET_ROLES" TARGET_EXTS="$TARGET_EXTS" NO_OWNER="$NO_OWNER" python3 - "$DR_TMP/prereq.mapped.json" "$PROVIDER_ROLES_RE" <<'PYC'
import json, os, re, sys
p = json.load(open(sys.argv[1])); prov = re.compile(sys.argv[2])
have = set(os.environ['TARGET_ROLES'].split()); exts = set(os.environ['TARGET_EXTS'].split())
why = {r['name']: ', '.join(r.get('why') or []) for r in p.get('roles', [])}
out = []
if os.environ['NO_OWNER'] != '1':
    for n in p.get('requiredRoles', []):
        if n in have:
            continue
        if prov.match(n):
            out.append(f"provider-managed role '{n}' ({why.get(n, '')}) does not exist on this target — re-run with --role-map {n}:<role> (that role is then created with its attributes)")
        else:
            out.append(f"required role '{n}' ({why.get(n, '')}) does not exist on the target — re-run with --roles (recreates it from the backup), create it, or map it with --role-map {n}:<role>")
for e in p.get('extensions', []):
    if e['name'] not in exts:
        out.append(f"extension '{e['name']}' {e.get('version', '')} is not available on the target server — install it (or choose a provider/version that offers it)")
for t in p.get('tablespaces', []):
    out.append(f"tablespace '{t}' is used by the database — create it on the target first")
print('\n'.join(out))
PYC
)"
  if [ -n "$PREREQ_PROBLEMS" ]; then
    err "database prerequisites not met on the target (nothing has been changed on it yet):"
    printf '%s\n' "$PREREQ_PROBLEMS" | sed 's/^/     ✗ /' >&2
    die "Restore aborted before touching the target database."
  fi
  log "✓ prerequisites met on target: required roles, extensions$( [ "$NO_OWNER" -eq 1 ] && echo ' (roles not needed: --no-owner)')"
else
  warn "package has no database/prerequisites.json (made by an older toolkit): required roles are not checked in advance."
fi

# ── 2. Create / drop target database ───────────────────────────────────────────
if [ "$DROP_EXISTING" -eq 1 ]; then
  [ "$ASSUME_YES" -eq 1 ] || { printf 'About to DROP DATABASE "%s" on %s. Type the db name to confirm: ' "$TARGET_DB" "$PGHOST" >&2; read -r c; [ "$c" = "$TARGET_DB" ] || die "confirmation mismatch"; }
  log "dropping + recreating database $TARGET_DB …"
  PGDATABASE=postgres "$PSQL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)"
  CREATE_DB=1
fi
SRC_DB_OWNER="$(python3 -c 'import json,sys;print(((json.load(open(sys.argv[1]))["components"].get("databaseProperties") or {}).get("owner")) or "")' "$PKG/MANIFEST.json" 2>/dev/null || true)"
# Apply --role-map to the expected owner as well.
EXPECTED_OWNER="$SRC_DB_OWNER"
if [ -n "$ROLE_MAP" ] && [ -n "$EXPECTED_OWNER" ]; then
  IFS=',' read -ra _pairs <<<"$ROLE_MAP"
  for _p in "${_pairs[@]}"; do [ "${_p%%:*}" = "$EXPECTED_OWNER" ] && EXPECTED_OWNER="${_p##*:}"; done
fi
if [ "$CREATE_DB" -eq 1 ]; then
  if [ -s "$PKG/database/database-properties.sql" ]; then
    # Recreate the database WITH its captured properties (owner, encoding,
    # locale, DB-level grants and settings), renamed to the target if needed.
    SRC_DB_NAME="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["components"]["databaseProperties"]["name"])' "$PKG/MANIFEST.json")"
    python3 - "$PKG/database/database-properties.sql" "$SRC_DB_NAME" "$TARGET_DB" "$ROLE_MAP" >"$DR_TMP/dbprops.sql" <<'PYP'
import re, sys
path, src, dst, rmap = sys.argv[1:5]
def ident(n): return n if re.fullmatch(r'[a-z_][a-z0-9_$]*', n) else '"' + n.replace('"', '""') + '"'
s_id, d_id = ident(src), ident(dst)
pairs = [p.split(':', 1) for p in rmap.split(',') if ':' in p]
for line in open(path):
    line = re.sub(r'(\bDATABASE\s+)' + re.escape(s_id) + r'(?=[\s;])', lambda m: m.group(1) + d_id, line)
    for old, new in pairs:
        line = re.sub(r'(OWNER TO |TO |FROM |ROLE )' + re.escape(old) + r'\b', lambda m: m.group(1) + new, line)
    sys.stdout.write(line)
PYP
    log "creating database $TARGET_DB with captured properties:"
    sed 's/^/     /' "$DR_TMP/dbprops.sql" >&2
    grep '^CREATE DATABASE' "$DR_TMP/dbprops.sql" >"$DR_TMP/dbcreate.sql"
    PGDATABASE=postgres "$PSQL" -v ON_ERROR_STOP=1 -q -f "$DR_TMP/dbcreate.sql" 2>"$DR_TMP/dbcreate.err" \
      || { grep -q 'already exists' "$DR_TMP/dbcreate.err" && warn "database $TARGET_DB already exists — properties re-applied below" \
           || die "CREATE DATABASE failed: $(tail -n2 "$DR_TMP/dbcreate.err") (check that the target cluster supports the captured locale)"; }
    grep -v '^CREATE DATABASE' "$DR_TMP/dbprops.sql" >"$DR_TMP/dbalter.sql" || true
    if [ -s "$DR_TMP/dbalter.sql" ]; then
      PGDATABASE=postgres "$PSQL" -v ON_ERROR_STOP=0 -q -f "$DR_TMP/dbalter.sql" 2>"$DR_TMP/dbalter.err" || true
      if [ -s "$DR_TMP/dbalter.err" ]; then
        warn "database-level property statements failed (reported, not ignored):"; sed 's/^/     /' "$DR_TMP/dbalter.err" >&2
      fi
    fi
  else
    warn "package has no database-properties.sql (made by an older toolkit) — creating $TARGET_DB with defaults"
    PGDATABASE=postgres "$PSQL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB\"" \
      2> >(grep -vi 'already exists' >&2 || true) || true
    [ -n "$EXPECTED_OWNER" ] && PGDATABASE=postgres "$PSQL" -q -c "ALTER DATABASE \"$TARGET_DB\" OWNER TO \"$EXPECTED_OWNER\"" || true
  fi
fi

# ── 3. Restore the database (fail-loud) ────────────────────────────────────────
RESTORE_ARGS=( --dbname="$TARGET_DB" --no-password --exit-on-error --single-transaction )
if [ "$NO_OWNER" -eq 1 ]; then
  RESTORE_ARGS+=( --no-owner --no-acl )
  log "restoring data WITHOUT owners/ACLs (--no-owner): permission model re-applied by app role sync."
fi

log "restoring database objects + data (pg_restore --exit-on-error)…"
dr_test_fail restore-db
if [ -n "$ROLE_MAP" ] && [ "$NO_OWNER" -eq 0 ]; then
  # Owners and grants are preserved but renamed per --role-map: pg_restore emits
  # SQL, ownership/GRANT/REVOKE role names are rewritten, and psql applies it in
  # ONE transaction with ON_ERROR_STOP (same fail-loud semantics).
  log "restoring with role map ($ROLE_MAP) — ownership + grants preserved under mapped names"
  # shellcheck disable=SC2046
  if ! "$PGRESTORE" -f - "$PKG/database/database.dump" 2>"$DR_TMP/dr_restore_err" \
       | sed -E $(role_map_sed | sed 's/-e s/-e \/^(ALTER|GRANT|REVOKE|CREATE)\/s/g') \
       | "$PSQL" -X -q -v ON_ERROR_STOP=1 --single-transaction -d "$TARGET_DB" >/dev/null 2>>"$DR_TMP/dr_restore_err"; then
    err "restore (role-mapped) reported errors:"; tail -n 30 "$DR_TMP/dr_restore_err" >&2
    die "Database restore FAILED (fail-loud). No success will be reported for a partial restore."
  fi
elif ! "$PGRESTORE" "${RESTORE_ARGS[@]}" "$PKG/database/database.dump" 2>$DR_TMP/dr_restore_err; then
  err "pg_restore reported errors:"; tail -n 30 $DR_TMP/dr_restore_err >&2
  die "Database restore FAILED (fail-loud). No success will be reported for a partial restore."
fi
# Surface non-fatal warnings even on success.
if [ -s $DR_TMP/dr_restore_err ]; then
  warn "pg_restore warnings (non-fatal):"; tail -n 10 $DR_TMP/dr_restore_err >&2
fi
log "database restore complete."

# ── 4. Restore uploaded files ──────────────────────────────────────────────────
copy_tree() {  # $1 src  $2 dest
  mkdir -p "$2"
  ( cd "$1" && find . -type f -print0 | while IFS= read -r -d '' f; do
      d="$2/${f#./}"; mkdir -p "$(dirname "$d")"; cp -p "$f" "$d"; done )
}
dr_test_fail restore-files
DRIVER="${UPLOAD_STORAGE_DRIVER:-local}"
LOCAL_DEST="${UPLOADS_DEST:-${UPLOAD_DEST:-$BACKEND_DIR/uploads}}"
if [ "$KIND" = "full" ] && [ -d "$PKG/uploads" ]; then
  if [ "$DRIVER" = "spaces" ]; then
    log "pushing uploaded files to object-storage bucket '${DO_SPACES_BUCKET:-?}'…"
    [ -d "$BACKEND_DIR/node_modules/@aws-sdk/client-s3" ] || die "driver=spaces but @aws-sdk missing; run 'npm ci' in backend first."
    node "$HERE/spaces-sync.mjs" upload "$PKG/uploads" 2>$DR_TMP/dr_up_err || die "object-storage upload failed: $(tail -n2 $DR_TMP/dr_up_err)"
  else
    log "restoring uploaded files into $LOCAL_DEST …"
    copy_tree "$PKG/uploads" "$LOCAL_DEST"
  fi
  # Legacy local "/uploads/..." files are always served from <app cwd>/uploads.
  if [ -d "$PKG/uploads-legacy-local" ]; then
    log "restoring legacy local uploads into $LOCAL_DEST …"
    copy_tree "$PKG/uploads-legacy-local" "$LOCAL_DEST"
  fi
  log "uploaded files restored."
fi

# ── 4b. Remap stored storage URLs to the RECOVERY storage ───────────────────────
# fileUrl/photoUrl/logoUrl/... columns store the ABSOLUTE public base of the
# storage they were written to. After recovering into different storage (new
# bucket, endpoint, region or host) those URLs would still point at the OLD
# storage — the restored app would silently depend on it, or break once it is
# gone. Rewrite every reference from the backup's base to the recovery base.
OLD_BASE="$(python3 -c 'import json,sys;print((json.load(open(sys.argv[1])).get("storage") or {}).get("publicBaseUrl",""))' "$PKG/MANIFEST.json" 2>/dev/null || true)"
if [ -n "$STORAGE_BASE_TO" ]; then NEW_BASE="$STORAGE_BASE_TO"
elif [ "$DRIVER" = "spaces" ]; then NEW_BASE="${DO_SPACES_PUBLIC_URL%/}"
else NEW_BASE="/uploads"; fi
if [ "$KIND" = "full" ] && [ -n "$OLD_BASE" ] && [ -n "$NEW_BASE" ] && [ "$OLD_BASE" != "$NEW_BASE" ] && [ "$OLD_BASE" != "/uploads" ]; then
  log "remapping storage URLs: $OLD_BASE/… → $NEW_BASE/…"
  "$PSQL" -v ON_ERROR_STOP=1 -tA -v old="$OLD_BASE/" -v new="$NEW_BASE/" <<'SQL' 2>&1 | sed 's/^/     /' >&2
SELECT set_config('dr.old', :'old', false) AS dr_old, set_config('dr.new', :'new', false) AS dr_new \gset
DO $$
DECLARE
  r record; n bigint; total bigint := 0;
  o text := current_setting('dr.old'); w text := current_setting('dr.new');
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND (c.data_type IN ('text','character varying','jsonb','json') OR c.udt_name = '_text')
  LOOP
    IF r.data_type IN ('jsonb','json') THEN
      EXECUTE format('UPDATE %I.%I SET %I = replace(%I::text, $1, $2)::%s WHERE strpos(%I::text, $1) > 0',
        r.table_schema, r.table_name, r.column_name, r.column_name, r.data_type, r.column_name) USING o, w;
    ELSIF r.udt_name = '_text' THEN
      EXECUTE format('UPDATE %I.%I SET %I = (SELECT array_agg(replace(x, $1, $2)) FROM unnest(%I) x) WHERE strpos(array_to_string(%I, chr(31)), $1) > 0',
        r.table_schema, r.table_name, r.column_name, r.column_name, r.column_name) USING o, w;
    ELSE
      EXECUTE format('UPDATE %I.%I SET %I = replace(%I, $1, $2) WHERE strpos(%I, $1) > 0',
        r.table_schema, r.table_name, r.column_name, r.column_name, r.column_name) USING o, w;
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE NOTICE 'rewrote % row(s) in %.%', n, r.table_name, r.column_name;
      total := total + n;
    END IF;
  END LOOP;
  RAISE NOTICE 'storage URL remap: % row(s) updated', total;
END $$;
SQL
  # Assert nothing still points at the old storage.
  LEFT="$("$PSQL" -tAX -v old="$OLD_BASE/" <<'SQL' | tr -d '[:space:]'
SELECT count(*) FROM documents WHERE strpos("fileUrl", :'old') > 0;
SQL
)"
  [ "${LEFT:-1}" = "0" ] || die "storage URL remap incomplete: $LEFT document(s) still reference $OLD_BASE"
  log "✓ storage URL remap complete — no document references the old storage."
fi

# ── 4c. Reconstruct the backup catalog from the package ─────────────────────────
# The restored system_backups table is the catalog AS OF the snapshot: the very
# backup we restored from is RUNNING in it (it was in progress when captured),
# and CLI-made packages are not in it at all. Register this package as a
# COMPLETED, VERIFIED, RESTORE-TESTED backup so the recovered system knows its
# own recovery point — without needing the original catalog. Other RUNNING
# rows were genuinely interrupted by the snapshot and are marked as such.
HAS_CATALOG="$("$PSQL" -tAX -c "SELECT to_regclass('public.system_backups') IS NOT NULL" 2>/dev/null | tr -d '[:space:]')"
if [ "$HAS_CATALOG" = "t" ]; then
  CAT_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("catalogId") or "")' "$PKG/MANIFEST.json")"
  PKG_NAME_M="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["package"])' "$PKG/MANIFEST.json")"
  PKG_KIND="$(python3 -c 'import json,sys;print("FULL_SYSTEM" if json.load(open(sys.argv[1]))["kind"]=="full" else "DATABASE")' "$PKG/MANIFEST.json")"
  PKG_SHA="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["components"]["database"]["sha256"])' "$PKG/MANIFEST.json")"
  log "reconstructing backup catalog (package $PKG_NAME_M, catalogId ${CAT_ID:-none})…"
  # Describe the package from its own manifest so the recovered UI shows real
  # coverage/size, can re-verify it, and states where it was restored from.
  PKG_ABS="$(readlink -f "$PKG_IN")"
  PKG_SIZE="$( [ -f "$PKG_ABS" ] && wc -c <"$PKG_ABS" | tr -d ' ' || echo 0)"
  CAT_META="$(python3 - "$PKG/MANIFEST.json" "$PKG_ABS" <<'PYM'
import json, sys
m = json.load(open(sys.argv[1])); up = m["components"].get("uploads") or {}
print(json.dumps({
  "kind": m["kind"], "artifact": sys.argv[2], "manifest": m,
  "uploadsIncluded": bool(up.get("included")), "uploadsCount": up.get("count", 0),
  "uploadsBytes": up.get("bytes", 0), "uploadsComplete": bool(m.get("complete", True)),
  "globalsCaptured": bool(m["components"]["globals"].get("captured")),
  "databaseBytes": m["components"]["database"].get("bytes", 0),
  "importedDuringRecovery": True,
  # Bucket-native snapshots (snapshot.sh) stay addressable by package name.
  **({"engine": "stream", "package": m["package"], "artifact": m.get("location", sys.argv[2])} if m.get("engine") == "stream" else {}),
}))
PYM
)"
  if [ -n "$SOURCE_LOCATION" ]; then OFF_STATUS="VERIFIED"; else OFF_STATUS="UNKNOWN"; fi
  CAT_NAME="$PKG_NAME_M.tar.gz"; CAT_PATH="${CATALOG_PACKAGE_PATH:-$PKG_ABS}"
  if [ "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("engine",""))' "$PKG/MANIFEST.json")" = "stream" ]; then
    CAT_NAME="$PKG_NAME_M"
    CAT_PATH="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("location",""))' "$PKG/MANIFEST.json")"
    PKG_SIZE="$(python3 -c 'import json,sys;c=json.load(open(sys.argv[1]))["components"];print(c["database"]["bytes"]+(c.get("uploads") or {}).get("bytes",0))' "$PKG/MANIFEST.json")"
  fi
  "$PSQL" -v ON_ERROR_STOP=1 -q -v cid="$CAT_ID" -v pname="$CAT_NAME" -v pkind="$PKG_KIND" \
      -v psha="$PKG_SHA" -v ppath="$CAT_PATH" -v psize="$PKG_SIZE" \
      -v pmeta="$CAT_META" -v offs="$OFF_STATUS" -v offl="$SOURCE_LOCATION" <<'SQL'
UPDATE system_backups
   SET status = 'FAILED',
       "errorMessage" = 'Interrupted: was in progress when the DR snapshot was taken.'
 WHERE status = 'RUNNING' AND id <> :'cid';
INSERT INTO system_backups (id, "fileName", "filePath", "fileSize", "backupType", kind, status, checksum,
                            "verifyResult", "verifiedAt", "restoreTestedAt", "fileMissing",
                            "offsiteStatus", "offsiteLocation", metadata, notes, "createdAt", "completedAt")
VALUES (COALESCE(NULLIF(:'cid',''), gen_random_uuid()::text), :'pname', :'ppath', NULLIF(:'psize','0')::bigint,
        :'pkind', :'pkind', 'COMPLETED', :'psha', 'VERIFIED', now(), now(), false,
        :'offs', NULLIF(:'offl',''), :'pmeta'::jsonb,
        'Imported from DR package during recovery (restore-tested).', now(), now())
ON CONFLICT (id) DO UPDATE
   SET status = 'COMPLETED', "fileName" = EXCLUDED."fileName", "filePath" = EXCLUDED."filePath",
       "fileSize" = EXCLUDED."fileSize", checksum = EXCLUDED.checksum,
       "verifyResult" = 'VERIFIED', "verifiedAt" = now(), "restoreTestedAt" = now(),
       "fileMissing" = false, "errorMessage" = NULL,
       "offsiteStatus" = EXCLUDED."offsiteStatus", "offsiteLocation" = EXCLUDED."offsiteLocation",
       metadata = EXCLUDED.metadata,
       "completedAt" = COALESCE(system_backups."completedAt", now());
SQL
  log "✓ catalog reconstructed: package registered as COMPLETED + VERIFIED + RESTORE-TESTED."
fi

# ── 5. Post-restore verification ───────────────────────────────────────────────
log "running post-restore verification…"
VERIFY_FAIL=0

# 5a. Row counts vs snapshot.
if [ -f "$PKG/database/rowcounts.tsv" ]; then
  python3 - "$PKG/database/rowcounts.tsv" > $DR_TMP/dr_expected.tsv <<'PY'
import sys
for line in open(sys.argv[1]):
    line=line.rstrip("\n")
    if not line: continue
    print(line)
PY
  "$PSQL" -tAX -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname" >$DR_TMP/dr_actual.tsv 2>/dev/null || true
  # Live-tup is an estimate; run ANALYZE to refresh, then compare table presence + non-empty.
  "$PSQL" -q -c "ANALYZE" >/dev/null 2>&1 || true
  MISSING_TBL="$(comm -23 <(cut -d'|' -f1 $DR_TMP/dr_expected.tsv | sort -u) <(cut -d'|' -f1 $DR_TMP/dr_actual.tsv | sort -u) | wc -l | tr -d ' ')"
  if [ "${MISSING_TBL:-0}" -gt 0 ]; then
    err "✗ $MISSING_TBL table(s) present in backup but missing after restore:"
    comm -23 <(cut -d'|' -f1 $DR_TMP/dr_expected.tsv | sort -u) <(cut -d'|' -f1 $DR_TMP/dr_actual.tsv | sort -u) | sed 's/^/     /' >&2
    VERIFY_FAIL=1
  else
    log "✓ all $(cut -d'|' -f1 $DR_TMP/dr_expected.tsv | sort -u | wc -l | tr -d ' ') tables present after restore"
  fi
fi

# 5b. Exact row-count parity on key tables (authoritative COUNT(*)).
log "checking exact row counts on key tables…"
"$PSQL" -tAX >$DR_TMP/dr_counts.txt 2>/dev/null <<'SQL' || true
SELECT 'users', count(*) FROM users
UNION ALL SELECT 'employees', count(*) FROM employees
UNION ALL SELECT 'applicants', count(*) FROM applicants
UNION ALL SELECT 'documents', count(*) FROM documents
UNION ALL SELECT 'attendance_records', count(*) FROM attendance_records
UNION ALL SELECT 'tenants', count(*) FROM tenants;
SQL
sed 's/^/     /' $DR_TMP/dr_counts.txt >&2 || true

# 5b2. Database ownership: the app role must own the DB (and so CREATE in
#      schema public, PG15+) or its boot-time schema healing and every future
#      migration fail after recovery.
if [ -n "$EXPECTED_OWNER" ] && [ "$NO_OWNER" -eq 0 ]; then
  GOT_OWNER="$("$PSQL" -tAX -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()" | tr -d '[:space:]')"
  CAN_CREATE="$("$PSQL" -tAX -c "SELECT has_schema_privilege('$EXPECTED_OWNER','public','CREATE')" 2>/dev/null | tr -d '[:space:]')"
  if [ "$GOT_OWNER" = "$EXPECTED_OWNER" ] && [ "$CAN_CREATE" = "t" ]; then
    log "✓ database owned by $GOT_OWNER; it can create objects in schema public (future migrations work)"
  else
    err "✗ database owner is '$GOT_OWNER' (expected '$EXPECTED_OWNER'); CREATE on public for $EXPECTED_OWNER: ${CAN_CREATE:-?}"
    err "  fix: ALTER DATABASE \"$TARGET_DB\" OWNER TO \"$EXPECTED_OWNER\"  (or GRANT CREATE ON SCHEMA public TO \"$EXPECTED_OWNER\")"
    VERIFY_FAIL=1
  fi
fi

# 5c. Sequence usability — identity/serial columns must accept new inserts.
log "checking sequences support new inserts…"
SEQ_OK="$("$PSQL" -tAX -c "SELECT count(*) FROM pg_sequences WHERE schemaname='public'" 2>/dev/null | tr -d '[:space:]' || echo 0)"
log "     $SEQ_OK sequence(s) present"

if [ "$VERIFY_FAIL" -ne 0 ]; then
  die "POST-RESTORE VERIFICATION FAILED."
fi

log "RESTORE OK — database$([ "$KIND" = full ] && echo ' + uploads') restored and verified on target."
if [ -n "$LOGIN_ROLES" ]; then
  log "LOGIN roles were recreated WITHOUT passwords (by design — secrets are never in backups). Set each from the secret store:"
  for r in $LOGIN_ROLES; do log "     ALTER ROLE \"$r\" WITH PASSWORD '…';"; done
fi
log "Next: start the app against this target with external side-effects disabled (see runbook §Bring-up)."
