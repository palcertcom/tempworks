#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-maintenance-migration.sh — reproducible proof for the
# enhance_maintenance_records.sql fix, on a THROWAWAY PostgreSQL 18 cluster.
#
#   1. real schema (prisma db push, app role = non-superuser DB owner)
#   2. ORIGINAL migration (from git, BEFORE_REF)   → must FAIL (uuid vs text FK)
#      and leave NO objects behind (single implicit transaction)
#   3. FIXED migration                             → must succeed
#   4. FIXED migration again                       → idempotent
#   5. FIXED on a PARTIALLY-applied database        → succeeds, keeps existing
#   6. FK behaviour (ON DELETE SET NULL / CASCADE)
#   7. full runner (db:migrate:all) on a fresh DB  → all files succeed
#
# Usage: backend/scripts/migrations/verify-maintenance-migration.sh [BEFORE_REF]
# Never point this at a real database: it creates and destroys its own cluster.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$BACKEND/.." && pwd)"
BEFORE_REF="${1:-a51b657}"
PGBIN="${PG_BIN_PATH:-/usr/lib/postgresql/18/bin}"
PORT="${MIGRATION_TEST_PORT:-58432}"
WORK="$(mktemp -d /tmp/mig-verify.XXXXXX)"; chown postgres "$WORK"
MIG="prisma/migrations/enhance_maintenance_records.sql"
PASS=0; FAIL=0
ok(){ echo "  ✓ $*"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $*"; FAIL=$((FAIL+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3 ($1)" || no "$3 (got '$1' want '$2')"; }
su_sql(){ "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$1" -tAX -c "$2"; }
app_file(){ PGPASSWORD=app_pw "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U tw_app -d "$1" -v ON_ERROR_STOP=1 -q -f "$2"; }
teardown(){ sudo -u postgres "$PGBIN/pg_ctl" -D "$WORK/pg" stop -m immediate >/dev/null 2>&1; rm -rf "$WORK"; }
trap teardown EXIT

sudo -u postgres "$PGBIN/initdb" -D "$WORK/pg" -U postgres --auth-local=trust --auth-host=trust -E UTF8 >/dev/null
{ echo "port = $PORT"; echo "unix_socket_directories = '$WORK'"; } >>"$WORK/pg/postgresql.conf"
sudo -u postgres "$PGBIN/pg_ctl" -D "$WORK/pg" -l "$WORK/pg.log" -o "-p $PORT" start >/dev/null; sleep 2
su_sql postgres "CREATE ROLE tw_app LOGIN PASSWORD 'app_pw' NOSUPERUSER" >/dev/null

newdb(){ # $1 db name — real schema via prisma db push, owned by the app role
  su_sql postgres "CREATE DATABASE $1 OWNER tw_app" >/dev/null
  ( cd "$BACKEND" && DATABASE_URL="postgresql://tw_app:app_pw@127.0.0.1:$PORT/$1?sslmode=disable" \
      npx prisma db push --accept-data-loss >"$WORK/push-$1.log" 2>&1 ) || { echo "db push failed"; tail "$WORK/push-$1.log"; exit 2; }
}
git -C "$REPO" show "$BEFORE_REF:backend/$MIG" >"$WORK/original.sql"
FIXED="$BACKEND/$MIG"
COLS="'driverId','driverNameOverride','dropOffDriverId','dropOffDriverNameOverride','dropOffDateTime','pickUpDriverId','pickUpDriverNameOverride','pickUpDateTime','approvedById','approvedAt','workDescription'"
ncols(){ su_sql "$1" "SELECT count(*) FROM information_schema.columns WHERE table_name='maintenance_records' AND column_name IN ($COLS)"; }
nfks(){ su_sql "$1" "SELECT count(*) FROM pg_constraint WHERE conrelid IN ('maintenance_records'::regclass) AND contype='f' AND conname ~ '(driverId|DriverId|approvedById)'"; }

echo "== 1-2. ORIGINAL migration ($BEFORE_REF) on the real schema =="
newdb t_orig
if app_file t_orig "$WORK/original.sql" 2>"$WORK/orig.err"; then no "original migration unexpectedly succeeded"
else ok "original migration fails: $(grep -oE 'foreign key constraint .* cannot be implemented' "$WORK/orig.err" | head -1)"
     grep -q "incompatible types: uuid and text" "$WORK/orig.err" && ok "cause: incompatible types uuid vs text"
fi
eq "$(ncols t_orig)" "0" "original leaves NO new columns (whole file rolled back)"

echo "== 3-4. FIXED migration =="
newdb t_fix
app_file t_fix "$FIXED" 2>"$WORK/fix.err" && ok "fixed migration applies" || { no "fixed migration failed"; cat "$WORK/fix.err"; }
eq "$(ncols t_fix)" "11" "all 11 maintenance columns created"
eq "$(su_sql t_fix "SELECT string_agg(DISTINCT data_type, ',') FROM information_schema.columns WHERE table_name='maintenance_records' AND column_name IN ('driverId','dropOffDriverId','pickUpDriverId','approvedById')")" "text" "driver/approver key columns are TEXT"
eq "$(nfks t_fix)" "4" "4 foreign keys to users(id)"
eq "$(su_sql t_fix "SELECT to_regclass('public.maintenance_record_attachments') IS NOT NULL")" "t" "maintenance_record_attachments table exists"
eq "$(su_sql t_fix "SELECT count(*) FROM pg_constraint WHERE conrelid='maintenance_record_attachments'::regclass AND contype='f'")" "2" "attachments table has 2 foreign keys"
app_file t_fix "$FIXED" 2>/dev/null && ok "re-running the fixed migration is a no-op (idempotent)" || no "re-run failed"
eq "$(nfks t_fix)" "4" "re-run did not duplicate foreign keys"

echo "== 5. FIXED on a partially-applied database =="
newdb t_partial
PGPASSWORD=app_pw "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U tw_app -d t_partial -qc \
  "ALTER TABLE maintenance_records ADD COLUMN \"driverNameOverride\" TEXT; ALTER TABLE maintenance_records ADD COLUMN \"workDescription\" TEXT; UPDATE maintenance_records SET \"workDescription\"='kept'"
app_file t_partial "$FIXED" 2>/dev/null && ok "fixed migration applies over pre-existing columns" || no "partial-state apply failed"
eq "$(ncols t_partial)" "11" "all 11 columns present after partial-state apply"

echo "== 6. foreign-key behaviour =="
PGPASSWORD=app_pw "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U tw_app -d t_fix -v ON_ERROR_STOP=1 -q <<'SQL' 2>"$WORK/fk.err"
INSERT INTO roles (id,name,"updatedAt") VALUES ('r1','Driver role',now());
INSERT INTO agencies (id,name,country,"contactPerson",email,phone,"updatedAt") VALUES ('a1','A','SK','c','a@a.a','1',now());
INSERT INTO users (id,email,"passwordHash","firstName","lastName","roleId","agencyId","updatedAt") VALUES ('u1','d@x.x','h','D','R','r1','a1',now());
INSERT INTO vehicles (id,"registrationNumber",make,model,"updatedAt") VALUES ('v1','BA-001','Ford','Transit',now());
INSERT INTO maintenance_records (id,"vehicleId","updatedAt","driverId","approvedById") VALUES ('m1','v1',now(),'u1','u1');
INSERT INTO maintenance_record_attachments ("maintenanceRecordId",name,"uploadedById") VALUES ('m1','invoice.pdf','u1');
SQL
if [ -s "$WORK/fk.err" ]; then no "FK fixture insert failed: $(head -2 "$WORK/fk.err")"; else
  ok "maintenance record with driver + approver + attachment inserted"
  sqlerr="$(PGPASSWORD=app_pw "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U tw_app -d t_fix -qc "UPDATE maintenance_records SET \"driverId\"='no-such-user' WHERE id='m1'" 2>&1)"
  echo "$sqlerr" | grep -q "violates foreign key" && ok "unknown driver id rejected by FK" || no "FK not enforced"
  PGPASSWORD=app_pw "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U tw_app -d t_fix -qc "DELETE FROM users WHERE id='u1'" >/dev/null 2>&1
  eq "$(su_sql t_fix "SELECT coalesce(\"driverId\",'NULL')||'/'||coalesce(\"approvedById\",'NULL') FROM maintenance_records WHERE id='m1'")" "NULL/NULL" "deleting the user sets driver/approver to NULL"
  eq "$(su_sql t_fix "SELECT coalesce(\"uploadedById\",'NULL') FROM maintenance_record_attachments")" "NULL" "attachment uploader set NULL"
  su_sql t_fix "DELETE FROM maintenance_records WHERE id='m1'" >/dev/null
  eq "$(su_sql t_fix "SELECT count(*) FROM maintenance_record_attachments")" "0" "deleting the record cascades to attachments"
fi

echo "== 7. full runner (db:migrate:all) on a fresh database =="
newdb t_all
( cd "$BACKEND" && DATABASE_URL="postgresql://tw_app:app_pw@127.0.0.1:$PORT/t_all?sslmode=disable" \
    npx ts-node --transpile-only prisma/run-all-migrations.ts >"$WORK/all.log" 2>&1 ); rc=$?
grep -E "Succeeded|Failed" "$WORK/all.log" | sed 's/^/    /'
eq "$rc" "0" "db:migrate:all exits 0"

printf '\nMIGRATION VERIFY: PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
