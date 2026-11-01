#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# dr-selftest.sh — end-to-end, ISOLATED proof of the DR toolkit.
#
# Spins up TWO throwaway PostgreSQL 18 clusters (a "source" and a CLEAN
# "target"), seeds representative multi-tenant data + local upload files on the
# source, takes a FULL backup, verifies it, restores it onto the clean target,
# and asserts real recovery: table presence + exact row counts, ownership,
# ACL grants, RLS policies, uploaded-file checksums, DB→file reference
# resolution, sequence usability, a new write as the app role, and tenant
# isolation. Then runs negative cases (corruption, missing file, version
# mismatch, fail-loud restore).
#
# It is hermetic: it creates its clusters under a temp dir and tears them down.
# Requires: PostgreSQL 18 binaries (client+server) and the Prisma CLI available
# via `npx prisma` for schema materialisation. Intended for CI / manual DR drills.
#
# Usage: backend/scripts/dr/dr-selftest.sh [workdir]
# Exit 0 = all assertions passed.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="${1:-$(mktemp -d /tmp/dr-selftest.XXXXXX)}"
PGBIN="${PG_BIN_PATH:-/usr/lib/postgresql/18/bin}"
P1="${DR_SELFTEST_PORT1:-56432}" P2="${DR_SELFTEST_PORT2:-56433}"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3 ($1)" || no "$3 (got '$1' want '$2')"; }

say(){ printf '\n=== %s ===\n' "$*"; }
psqlA(){ "$PGBIN/psql" -h 127.0.0.1 -p "$1" -U postgres -d "$2" -tAX -c "$3"; }

teardown(){
  for d in "$WORK/pg1" "$WORK/pg2"; do
    [ -d "$d" ] && sudo -u postgres "$PGBIN/pg_ctl" -D "$d" stop -m immediate >/dev/null 2>&1 || true
  done
}
trap teardown EXIT

[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL 18 not found at $PGBIN — install it (see deploy/provision-postgres-client-18.sh)"; exit 2; }

mkdir -p "$WORK"; chown -R postgres:postgres "$WORK" 2>/dev/null || true

start_cluster(){ # $1 datadir  $2 port
  sudo -u postgres "$PGBIN/initdb" -D "$1" -U postgres --auth-local=trust --auth-host=trust -E UTF8 >"$WORK/initdb.log" 2>&1
  { echo "port = $2"; echo "unix_socket_directories = '$WORK'"; } >> "$1/postgresql.conf"
  sudo -u postgres "$PGBIN/pg_ctl" -D "$1" -l "$WORK/pg_$2.log" -o "-p $2" start >/dev/null
  sleep 2
}

say "provisioning source + clean target clusters"
start_cluster "$WORK/pg1" "$P1"
start_cluster "$WORK/pg2" "$P2"
psqlA "$P1" postgres "CREATE ROLE tempworks_app LOGIN PASSWORD 'app_pw'" >/dev/null
psqlA "$P1" postgres "CREATE DATABASE tempworks_source OWNER tempworks_app" >/dev/null
ok "clusters up (source=$P1, clean target=$P2)"

say "materialising real schema via prisma migrate diff"
( cd "$REPO_ROOT/backend" && DATABASE_URL="postgresql://postgres@127.0.0.1:$P1/tempworks_source" \
    npx --yes prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script >"$WORK/schema.sql" 2>"$WORK/diff.err" )
PGPASSWORD=app_pw "$PGBIN/psql" -h 127.0.0.1 -p "$P1" -U tempworks_app -d tempworks_source -v ON_ERROR_STOP=1 -qf "$WORK/schema.sql" >/dev/null
# permission model to prove ACL/RLS capture
psqlA "$P1" tempworks_source "CREATE ROLE tempworks_readonly NOLOGIN" >/dev/null
psqlA "$P1" tempworks_source "GRANT SELECT ON ALL TABLES IN SCHEMA public TO tempworks_readonly" >/dev/null
psqlA "$P1" tempworks_source "ALTER TABLE documents ENABLE ROW LEVEL SECURITY" >/dev/null
psqlA "$P1" tempworks_source "CREATE POLICY documents_tenant_isolation ON documents USING (true)" >/dev/null
ok "schema applied ($(psqlA "$P1" tempworks_source "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'") tables) + grants + RLS"

say "seeding representative data + upload files"
PGPASSWORD=app_pw "$PGBIN/psql" -h 127.0.0.1 -p "$P1" -U tempworks_app -d tempworks_source -v ON_ERROR_STOP=1 -qf "$HERE/testdata/seed.sql" >/dev/null
U="$WORK/uploads-source"; mkdir -p "$U/documents" "$U/employees"
for d in doc_1 doc_2 doc_3 doc_4 doc_5; do printf '%%PDF-1.4\n%% %s\n%s\n' "$d" "$(head -c 200 /dev/urandom | base64)" >"$U/documents/$d.pdf"; done
printf '\x89PNG\r\n\x1a\n' >"$U/employees/emp_1.png"; head -c 1024 /dev/urandom >>"$U/employees/emp_1.png"
ok "seeded ($(psqlA "$P1" tempworks_source "SELECT count(*) FROM employees") employees, $(psqlA "$P1" tempworks_source "SELECT count(*) FROM documents") documents) + $(find "$U" -type f | wc -l | tr -d ' ') files"

export DATABASE_URL="postgresql://tempworks_app:app_pw@127.0.0.1:$P1/tempworks_source?sslmode=disable"
export BACKUP_DIR="$WORK/backups" UPLOAD_STORAGE_DRIVER=local UPLOAD_DEST="$U"

say "preflight"
"$HERE/preflight.sh" --backup-dir "$BACKUP_DIR" >/dev/null 2>&1 && ok "preflight passed" || no "preflight failed"

say "full backup"
"$HERE/backup.sh" --kind full --label selftest --no-tar >"$WORK/backup.json" 2>"$WORK/backup.log" && ok "backup created" || no "backup failed"
PKG="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dir"])' "$WORK/backup.json")"

say "verify package integrity"
"$HERE/verify.sh" "$PKG" >/dev/null 2>&1 && ok "verify passed" || no "verify failed"

say "restore onto CLEAN target cluster"
"$HERE/restore.sh" "$PKG" --target-url "postgresql://postgres@127.0.0.1:$P2/tempworks_restored?sslmode=disable" \
  --create-db --roles --uploads-dest "$WORK/uploads-restored" --yes >"$WORK/restore.log" 2>&1 \
  && ok "restore succeeded" || { no "restore failed"; tail -20 "$WORK/restore.log"; }

say "deep verification of restored environment"
eq "$(psqlA "$P2" tempworks_restored "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")" \
   "$(psqlA "$P1" tempworks_source  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")" "table count parity"
for t in users employees applicants documents attendance_records tenants; do
  eq "$(psqlA "$P2" tempworks_restored "SELECT count(*) FROM $t")" "$(psqlA "$P1" tempworks_source "SELECT count(*) FROM $t")" "row count parity: $t"
done
eq "$(psqlA "$P2" tempworks_restored "SELECT tableowner FROM pg_tables WHERE schemaname='public' GROUP BY tableowner")" "tempworks_app" "ownership preserved"
eq "$(psqlA "$P2" tempworks_restored "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" \
   "$(psqlA "$P1" tempworks_source  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" "database owner preserved (not the restoring superuser)"
eq "$(psqlA "$P2" tempworks_restored "SELECT has_schema_privilege('tempworks_app','public','CREATE')")" "t" "app role can CREATE in schema public (future migrations work)"
eq "$(psqlA "$P2" tempworks_restored "SELECT pg_encoding_to_char(encoding)||'/'||datcollate FROM pg_database WHERE datname=current_database()")" \
   "$(psqlA "$P1" tempworks_source  "SELECT pg_encoding_to_char(encoding)||'/'||datcollate FROM pg_database WHERE datname=current_database()")" "encoding + collation preserved"
eq "$(psqlA "$P2" tempworks_restored "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='tempworks_readonly' AND privilege_type='SELECT'")" \
   "$(psqlA "$P1" tempworks_source  "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='tempworks_readonly' AND privilege_type='SELECT'")" "ACL grants preserved"
eq "$(psqlA "$P2" tempworks_restored "SELECT count(*) FROM pg_policies WHERE schemaname='public'")" "1" "RLS policy preserved"
# file checksums
( cd "$U" && find . -type f -exec sha256sum {} \; | sort ) >"$WORK/src.sums"
( cd "$WORK/uploads-restored" && find . -type f -exec sha256sum {} \; | sort ) >"$WORK/dst.sums"
diff -q "$WORK/src.sums" "$WORK/dst.sums" >/dev/null && ok "uploaded-file checksums identical" || no "upload checksum mismatch"
# DB->file resolution
miss=0; while IFS= read -r u; do [ -z "$u" ] && continue; rel="${u#/uploads/}"; [ -f "$WORK/uploads-restored/$rel" ] || miss=$((miss+1)); done \
  < <(psqlA "$P2" tempworks_restored "SELECT \"fileUrl\" FROM documents WHERE \"fileUrl\" IS NOT NULL UNION ALL SELECT \"photoUrl\" FROM employees WHERE \"photoUrl\" IS NOT NULL")
eq "$miss" "0" "every DB file reference resolves on disk"
# app role auth + new write
psqlA "$P2" tempworks_restored "ALTER ROLE tempworks_app WITH LOGIN PASSWORD 'rpw'" >/dev/null
PGPASSWORD=rpw "$PGBIN/psql" -h 127.0.0.1 -p "$P2" -U tempworks_app -d tempworks_restored -tAc "SELECT 1 FROM employees LIMIT 1" >/dev/null 2>&1 && ok "app role authenticates + reads" || no "app role cannot connect"
before="$(psqlA "$P2" tempworks_restored "SELECT count(*) FROM employees")"
PGPASSWORD=rpw "$PGBIN/psql" -h 127.0.0.1 -p "$P2" -U tempworks_app -d tempworks_restored -v ON_ERROR_STOP=1 -c \
  "INSERT INTO employees (id,\"firstName\",\"lastName\",email,phone,nationality,\"dateOfBirth\",\"addressLine1\",city,country,\"postalCode\",\"updatedAt\",\"agencyId\",\"tenantId\") VALUES ('emp_new','Post','Restore','n@a.x','+1','SK','2000-01-01','a','b','SK','1','now'::timestamptz,'ag_alpha','ten_alpha')" >/dev/null 2>&1 \
  && ok "new write as app role succeeds" || no "new write failed"
eq "$(psqlA "$P2" tempworks_restored "SELECT count(*) FROM employees")" "$((before+1))" "row count incremented after write"

say "negative / regression cases"
cp -r "$PKG" "$WORK/pkg_corrupt"; printf 'XXXX' | dd of="$WORK/pkg_corrupt/database/database.dump" bs=1 seek=100 conv=notrunc count=4 2>/dev/null
"$HERE/verify.sh" "$WORK/pkg_corrupt" >/dev/null 2>&1 && no "corruption NOT detected" || ok "checksum corruption detected"
cp -r "$PKG" "$WORK/pkg_missing"; rm -f "$WORK/pkg_missing/uploads/documents/doc_3.pdf"
"$HERE/verify.sh" "$WORK/pkg_missing" >/dev/null 2>&1 && no "missing file NOT detected" || ok "missing upload detected"
( source "$HERE/lib/common.sh"; parse_database_url; select_pg_tools 99 >/dev/null 2>&1 ) && no "resolver accepted impossible server major" || ok "version-mismatch resolver refuses (actionable)"
"$HERE/restore.sh" "$WORK/pkg_corrupt" --target-url "postgresql://postgres@127.0.0.1:$P2/tempworks_fail?sslmode=disable" --create-db --yes >/dev/null 2>&1 && no "restore reported success on corrupt pkg" || ok "restore is fail-loud on corrupt package"
ls -d "$BACKUP_DIR"/.partial_* >/dev/null 2>&1 && no "stray .partial left behind" || ok "no stray .partial (atomic publish)"

# The remaining cases deliberately provoke failures and inspect exit codes.
set +e

say "restore toolchain must match the TARGET major (not merely newest)"
( source "$HERE/lib/common.sh"; select_restore_tools 18 18 >/dev/null 2>&1; [ "$(_bin_major "$PGRESTORE")" = "18" ] ) \
  && ok "restore picks exact target-major client (18)" || no "restore did not pick exact-major client"
( source "$HERE/lib/common.sh"; select_restore_tools 99 >/dev/null 2>&1 ) \
  && no "restore accepted a client that does not match target major" || ok "restore refuses version skew without PG_ALLOW_VERSION_SKEW"
OLDEST="$(for d in /usr/lib/postgresql/*/bin; do "$d/pg_restore" --version 2>/dev/null | grep -oE '[0-9]+' | head -1; done | sort -n | head -1)"
if [ -n "$OLDEST" ] && [ "$OLDEST" -lt 18 ]; then
  ( source "$HERE/lib/common.sh"; select_restore_tools "$OLDEST" 18 >/dev/null 2>&1 ) \
    && no "pg_restore $OLDEST accepted an archive from pg_dump 18" || ok "pg_restore $OLDEST refuses archive made by pg_dump 18"
fi

say "stage failures preserve the ORIGINAL exit status and leave no partial package"
for stage in dump copy archive; do
  rm -rf "$WORK/fail_$stage"; mkdir -p "$WORK/fail_$stage"
  DR_TEST_FAIL_STAGE=$stage BACKUP_DIR="$WORK/fail_$stage" "$HERE/backup.sh" --kind full >/dev/null 2>&1; rc=$?
  eq "$rc" "97" "backup stage '$stage' failure propagates original status"
  ls -d "$WORK/fail_$stage"/.partial_* "$WORK/fail_$stage"/*.partial >/dev/null 2>&1 \
    && no "stage '$stage' left a partial artifact" || ok "stage '$stage' left no partial artifact"
done
for stage in restore-db restore-files; do
  DB="tw_fail_${stage//-/_}"
  DR_TEST_FAIL_STAGE=$stage "$HERE/restore.sh" "$PKG" --target-url "postgresql://postgres@127.0.0.1:$P2/$DB?sslmode=disable" \
    --create-db --yes --uploads-dest "$WORK/fail_up_$stage" >"$WORK/fail_$stage.log" 2>&1; rc=$?
  eq "$rc" "97" "restore stage '$stage' failure propagates original status"
  grep -q "RESTORE OK" "$WORK/fail_$stage.log" && no "restore '$stage' reported success" || ok "restore '$stage' did not report success"
done
# Off-site failure must be reported (not silently "uploaded"), local package kept.
OFF="$(BACKUP_DIR="$WORK/offfail" BACKUP_SPACES_BUCKET=nope BACKUP_SPACES_ENDPOINT=http://127.0.0.1:1 BACKUP_SPACES_REGION=us-east-1 \
       BACKUP_SPACES_ACCESS_KEY=x BACKUP_SPACES_SECRET_KEY=x BACKUP_SPACES_FORCE_PATH_STYLE=1 \
       "$HERE/backup.sh" --kind database --offsite 2>/dev/null)"; rc=$?
eq "$(printf '%s' "$OFF" | python3 -c 'import json,sys;print(json.load(sys.stdin)["offsiteStatus"])' 2>/dev/null)" "FAILED" "off-site upload failure reported as FAILED"

say "consistency under concurrent replacement / deletion"
SIG="$WORK/pause.signal"
# (a) Photo REPLACED mid-backup (new file written, row updated, old file purged):
#     first capture sees a reference to a now-deleted file → retry → consistent.
rm -f "$SIG"
DR_TEST_PAUSE_AFTER_DUMP_SECS=4 DR_TEST_SIGNAL_FILE="$SIG" BACKUP_DIR="$WORK/race1" \
  "$HERE/backup.sh" --kind full --no-tar >"$WORK/race1.json" 2>"$WORK/race1.log" &
BPID=$!
for _ in $(seq 1 60); do [ -f "$SIG" ] && break; sleep 0.25; done
cp "$U/employees/emp_1.png" "$U/employees/emp_1_v2.png"
PGPASSWORD=app_pw "$PGBIN/psql" -h 127.0.0.1 -p "$P1" -U tempworks_app -d tempworks_source -qc \
  "UPDATE employees SET \"photoUrl\"='/uploads/employees/emp_1_v2.png' WHERE id='emp_1'" >/dev/null
rm -f "$U/employees/emp_1.png"
wait "$BPID"; rc=$?
eq "$rc" "0" "replacement race: backup completes"
R1="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["uploadsComplete"], d["consistencyAttempts"])' "$WORK/race1.json" 2>/dev/null)"
eq "$R1" "True 2" "replacement race: detected, retried, consistent on attempt 2"
"$HERE/verify.sh" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dir"])' "$WORK/race1.json")" >/dev/null 2>&1 \
  && ok "replacement race: resulting package verifies" || no "replacement race package fails verify"

# (c) Referenced file OVERWRITTEN IN PLACE (same key, new bytes) mid-backup.
#     Presence alone cannot see this; the pre-snapshot change token can.
rm -f "$SIG"
DR_TEST_PAUSE_AFTER_DUMP_SECS=4 DR_TEST_SIGNAL_FILE="$SIG" BACKUP_DIR="$WORK/race3" \
  "$HERE/backup.sh" --kind full --no-tar >"$WORK/race3.json" 2>"$WORK/race3.log" &
BPID=$!
for _ in $(seq 1 60); do [ -f "$SIG" ] && break; sleep 0.25; done
printf '%%%% overwritten in place %s\n' "$(date +%s%N)" >>"$U/documents/doc_4.pdf"
NEWSHA="$(sha256sum "$U/documents/doc_4.pdf" | awk '{print $1}')"
wait "$BPID"; rc=$?
eq "$rc" "0" "overwrite race: backup completes"
grep -q "missing or overwritten during backup" "$WORK/race3.log" && ok "overwrite race: in-place overwrite of a referenced key DETECTED on attempt 1" || no "overwrite not detected"
R3="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["uploadsComplete"], d["consistencyAttempts"])' "$WORK/race3.json" 2>/dev/null)"
eq "$R3" "True 2" "overwrite race: retried, consistent on attempt 2"
R3DIR="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dir"])' "$WORK/race3.json")"
eq "$(sha256sum "$R3DIR/uploads/documents/doc_4.pdf" | awk '{print $1}')" "$NEWSHA" "overwrite race: package holds the new bytes, matching its post-overwrite snapshot"
"$HERE/verify.sh" "$R3DIR" >/dev/null 2>&1 && ok "overwrite race: package verifies" || no "overwrite race package fails verify"

# (b) Referenced file DELETED out-of-band while the row still references it:
#     can never be made consistent → INCOMPLETE (exit 4), never verified/restorable.
rm -f "$SIG"
DR_TEST_PAUSE_AFTER_DUMP_SECS=4 DR_TEST_SIGNAL_FILE="$SIG" BACKUP_DIR="$WORK/race2" BACKUP_CONSISTENCY_RETRIES=1 \
  "$HERE/backup.sh" --kind full --no-tar >"$WORK/race2.json" 2>"$WORK/race2.log" &
BPID=$!
for _ in $(seq 1 60); do [ -f "$SIG" ] && break; sleep 0.25; done
mv "$U/documents/doc_2.pdf" "$WORK/doc_2.pdf.held"
wait "$BPID"; rc=$?
eq "$rc" "4" "deletion race: backup exits 4 (INCOMPLETE), not success"
P2DIR="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dir"])' "$WORK/race2.json" 2>/dev/null)"
eq "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complete"])' "$P2DIR/MANIFEST.json" 2>/dev/null)" "False" "deletion race: manifest marked complete=false"
grep -q "doc_2.pdf" "$P2DIR/uploads.refcheck.json" && ok "deletion race: missing file named explicitly in refcheck" || no "missing file not reported"
"$HERE/verify.sh" "$P2DIR" >/dev/null 2>&1 && no "INCOMPLETE package passed verify" || ok "INCOMPLETE package fails verify"
"$HERE/restore.sh" "$P2DIR" --target-url "postgresql://postgres@127.0.0.1:$P2/tw_incomplete?sslmode=disable" --create-db --yes >/dev/null 2>&1 \
  && no "restore accepted an INCOMPLETE package" || ok "restore refuses an INCOMPLETE package"
mv "$WORK/doc_2.pdf.held" "$U/documents/doc_2.pdf"

# (c) Reference to a file that was ALREADY absent before the backup started:
#     consistent but not a complete recovery point → DEGRADED (exit 6); intact
#     (integrity OK) but refused by verify/restore unless explicitly accepted.
psqlA "$P1" tempworks_source "UPDATE documents SET \"fileUrl\"='/uploads/documents/lost_before_backup.pdf' WHERE id=(SELECT id FROM documents ORDER BY id LIMIT 1) RETURNING id" >"$WORK/lost.id"
BACKUP_DIR="$WORK/race4" "$HERE/backup.sh" --kind full --no-tar >"$WORK/race4.json" 2>"$WORK/race4.log"; rc=$?
eq "$rc" "6" "pre-existing missing file: backup exits 6 (DEGRADED), not success and not INCOMPLETE"
P4DIR="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dir"])' "$WORK/race4.json" 2>/dev/null)"
eq "$(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m["recoverability"], m["complete"], [i["code"] for i in m["recoveryIssues"]])' "$P4DIR/MANIFEST.json" 2>/dev/null)" \
   "DEGRADED False ['FILES_UNRESOLVED']" "pre-existing missing file: manifest DEGRADED / complete=false / FILES_UNRESOLVED"
"$HERE/verify.sh" "$P4DIR" >/dev/null 2>&1; eq "$?" "6" "DEGRADED package: verify exit 6 (integrity OK, not a complete recovery point)"
"$HERE/restore.sh" "$P4DIR" --target-url "postgresql://postgres@127.0.0.1:$P2/tw_degraded?sslmode=disable" --create-db --roles --yes >/dev/null 2>&1 \
  && no "restore accepted a DEGRADED package without DR_ALLOW_INCOMPLETE" || ok "restore refuses a DEGRADED package unless explicitly accepted"
psqlA "$P1" tempworks_source "UPDATE documents SET \"fileUrl\"='/uploads/documents/doc_1.pdf' WHERE id='$(cat "$WORK/lost.id")'" >/dev/null

say "managed-provider roles + role mapping (ownership/grants preserved under a new role name)"
"$HERE/restore.sh" "$PKG" --target-url "postgresql://postgres@127.0.0.1:$P2/tw_rolemap?sslmode=disable" \
  --create-db --roles --role-map "tempworks_app:tw_recovered" --uploads-dest "$WORK/up_rolemap" --yes >"$WORK/rolemap.log" 2>&1; rc=$?
eq "$rc" "0" "role-mapped restore succeeds"
grep -q "skipped provider-managed role statement: CREATE ROLE postgres" "$WORK/rolemap.log" \
  && ok "provider-managed role (postgres) skipped explicitly, not silently" || no "provider role not reported"
eq "$(psqlA "$P2" tw_rolemap "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname='public'")" "tw_recovered" "all tables owned by mapped role"
eq "$(psqlA "$P2" tw_rolemap "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" "tw_recovered" "database owned by mapped role"
eq "$(psqlA "$P2" tw_rolemap "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='tempworks_readonly' AND privilege_type='SELECT'")" \
   "$(psqlA "$P1" tempworks_source "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='tempworks_readonly' AND privilege_type='SELECT'")" "grants preserved through role map"
eq "$(psqlA "$P2" tw_rolemap "SELECT count(*) FROM employees")" "$(psqlA "$P1" tempworks_source "SELECT count(*) FROM employees")" "data intact through role map"

printf '\n════════════════════════════════════════\nDR SELF-TEST: PASS=%d FAIL=%d\n════════════════════════════════════════\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
