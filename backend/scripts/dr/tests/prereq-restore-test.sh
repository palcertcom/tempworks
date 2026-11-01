#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# prereq-restore-test.sh — database prerequisites survive a restore into a
# GENUINELY FRESH cluster, without pg_dumpall and without roles left over from
# the source, including on a provider-like target where the restoring role is
# NOT a superuser.
#
# SOURCE cluster (managed-provider shape):
#   tw_owner     NOLOGIN — owns the database and every object
#   tw_app       LOGIN, member of tw_owner — the role the app connects as;
#                ALTER ROLE … SET statement_timeout
#   tw_readonly  NOLOGIN — SELECT grants, default privileges, an RLS policy
#   tw_report    LOGIN, member of tw_readonly; a column-level grant
#   unrelated    LOGIN — must NOT be required or recreated
#   pgcrypto extension; CONNECT on postgres/template1 revoked from PUBLIC so
#   `pg_dumpall --globals-only` (run as tw_app) is REFUSED, like on a managed DB.
# Backups (streaming engine and staging engine) run as tw_app.
#
# TARGET 1 (provider-like): fresh initdb; the restore runs as `dbadmin`
#   (LOGIN CREATEROLE CREATEDB, not superuser — like DigitalOcean doadmin).
# TARGET 2 (provider-owned source): source database owned by a role named
#   `doadmin`; restored onto a fresh cluster with --role-map doadmin:tw_recovered.
# Negative cases: required role missing without --roles → aborted before the
# target is touched; prerequisite capture failure → INCOMPLETE (exit 4).
#
# Needs: PostgreSQL 18 server+client, node + backend node_modules, an S3
# endpoint (perf-env.sh race env: PERF_S3) with bucket dr-backups.
# Usage: prereq-restore-test.sh <evidence-dir>
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
EV="${1:-/tmp/prereq-test}"; mkdir -p "$EV"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; DR="$(cd "$HERE/.." && pwd)"; BACKEND="$(cd "$DR/../.." && pwd)"
PGBIN=/usr/lib/postgresql/18/bin; W=/tmp/prereq-test; S3=${PERF_S3:-5578}
SRC=58611; T1=58612; T2=58613
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass+1)); }
no() { echo "  ✗ $*"; fail=$((fail+1)); }
chk() { if eval "$2"; then ok "$1"; else no "$1"; fi; }
cluster() { # $1 port
  local d="$W/pg$1"; sudo -u postgres "$PGBIN/initdb" -D "$d" -U postgres --auth-local=trust --auth-host=scram-sha-256 --pwfile="$W/pw" -E UTF8 >/dev/null
  { echo "port = $1"; echo "unix_socket_directories = '$W'"; echo "listen_addresses = '127.0.0.1'"; } >>"$d/postgresql.conf"
  sudo -u postgres "$PGBIN/pg_ctl" -D "$d" -l "$d.log" start >/dev/null; sleep 1.5
}
# statements are fed on stdin (autocommit per statement, so CREATE DATABASE works)
su_sql() { PGPASSWORD=superpw "$PGBIN/psql" -h 127.0.0.1 -p "$1" -U postgres -d "${3:-postgres}" -X -qtA -v ON_ERROR_STOP=1 <<<"$2"; }
as_sql() { PGPASSWORD="$3" "$PGBIN/psql" -h 127.0.0.1 -p "$1" -U "$2" -d "${5:-twdb}" -X -qtA -v ON_ERROR_STOP=1 <<<"$4"; }

for p in $SRC $T1 $T2; do fuser -k $p/tcp >/dev/null 2>&1; done; sleep 0.5
rm -rf "$W"; mkdir -p "$W"; echo superpw >"$W/pw"; chown -R postgres "$W"
echo "== source cluster (managed-provider shape)"
cluster $SRC
su_sql $SRC "CREATE ROLE tw_owner NOLOGIN; CREATE ROLE tw_app LOGIN PASSWORD 'src-app-pw' IN ROLE tw_owner;
  ALTER ROLE tw_app SET statement_timeout = '60s';
  CREATE ROLE tw_readonly NOLOGIN; CREATE ROLE tw_report LOGIN PASSWORD 'src-report-pw' IN ROLE tw_readonly;
  CREATE ROLE unrelated LOGIN; CREATE DATABASE twdb OWNER tw_owner;
  REVOKE CONNECT ON DATABASE postgres FROM PUBLIC; REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;"
su_sql $SRC "CREATE EXTENSION pgcrypto" twdb
( cd "$BACKEND" && npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script >"$W/schema.sql" 2>/dev/null )
PGPASSWORD=src-app-pw "$PGBIN/psql" -h 127.0.0.1 -p $SRC -U tw_app -d twdb -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
SET ROLE tw_owner;
\i $W/schema.sql
INSERT INTO tenants (id,slug,name,"updatedAt") VALUES ('t1','acme','Acme',now());
INSERT INTO roles (id,name,"updatedAt") VALUES ('r1','System Admin',now());
INSERT INTO agencies (id,name,country,"contactPerson",email,phone,"updatedAt","tenantId") VALUES ('a1','A','SK','c','a@a.a','1',now(),'t1');
INSERT INTO users (id,email,"passwordHash","firstName","lastName","roleId","agencyId","updatedAt") VALUES ('u1','u@a.a','x','U','A','r1','a1',now());
GRANT USAGE ON SCHEMA public TO tw_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tw_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE tw_owner IN SCHEMA public GRANT SELECT ON TABLES TO tw_readonly;
REVOKE SELECT ON users FROM tw_readonly; GRANT SELECT (id, email) ON users TO tw_report;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY ro_tenants ON tenants FOR SELECT TO tw_readonly USING (true);
CREATE TABLE secrets_probe (id serial PRIMARY KEY, token bytea DEFAULT gen_random_bytes(8));
INSERT INTO secrets_probe DEFAULT VALUES;
SQL
SRC_USERS="$(as_sql $SRC tw_app src-app-pw 'SELECT count(*) FROM users')"
chk "source: pg_dumpall --globals-only is REFUSED for the app role (managed-like)" \
  "! PGPASSWORD=src-app-pw $PGBIN/pg_dumpall -h 127.0.0.1 -p $SRC -U tw_app --globals-only --no-role-passwords >/dev/null 2>&1"

export BACKUP_SPACES_ENDPOINT=http://127.0.0.1:$S3 BACKUP_SPACES_REGION=us-east-1 BACKUP_SPACES_BUCKET=dr-backups \
  BACKUP_SPACES_ACCESS_KEY=S3RVER BACKUP_SPACES_SECRET_KEY=S3RVER BACKUP_SPACES_FORCE_PATH_STYLE=1 BACKUP_SPACES_PREFIX=prereq-test/ \
  PG_BIN_PATH=$PGBIN UPLOAD_STORAGE_DRIVER=local UPLOAD_DEST="$W/empty-uploads"
mkdir -p "$W/empty-uploads"; unset DO_SPACES_BUCKET DO_SPACES_ENDPOINT
SRC_URL="postgresql://tw_app:src-app-pw@127.0.0.1:$SRC/twdb?sslmode=disable"

echo "== backup (streaming engine) as tw_app"
DATABASE_URL="$SRC_URL" bash "$DR/snapshot.sh" backup --kind database --label prereq >"$W/b1.json" 2>"$EV/backup-stream.log"; rc=$?
PKG="$(python3 -c 'import json,sys;print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["package"])' "$W/b1.json" 2>/dev/null)"
chk "stream backup exit 0 (COMPLETE) although pg_dumpall was refused (rc=$rc)" "[ $rc -eq 0 ]"
python3 - "$W/b1.json" >"$EV/backup-stream-manifest-excerpt.json" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1]).read().strip().splitlines()[-1]); m = d['manifest']
print(json.dumps({'recoverability': d['recoverability'], 'recoveryIssues': d['recoveryIssues'], 'globals': m['components']['globals']['captured'],
                  'prerequisites': m['components']['prerequisites']}, indent=2))
PY
REQ="$(python3 -c 'import json,sys;print(" ".join(json.load(open(sys.argv[1]))["prerequisites"]["requiredRoles"]))' "$EV/backup-stream-manifest-excerpt.json")"
chk "required roles = owner, app, readonly, report (+ provider postgres); unrelated excluded [$REQ]" \
  "[ \"$REQ\" = 'postgres tw_app tw_owner tw_readonly tw_report' ]"
chk "GLOBALS_FROM_CATALOG recorded as information, not hidden" "grep -q GLOBALS_FROM_CATALOG '$EV/backup-stream-manifest-excerpt.json'"

echo "== negative: prerequisite capture fails → INCOMPLETE"
DATABASE_URL="$SRC_URL" DR_TEST_FAIL_STAGE=prereqs bash "$DR/snapshot.sh" backup --kind database >"$W/b2.json" 2>"$EV/backup-prereq-fail.log"; rc=$?
chk "capture failure → exit 4 INCOMPLETE with an actionable reason (rc=$rc)" "[ $rc -eq 4 ] && grep -q 'PREREQ_CAPTURE_FAILED' '$EV/backup-prereq-fail.log'"

echo "== backup (staging engine) as tw_app"
DATABASE_URL="$SRC_URL" BACKUP_DIR="$W/staging" bash "$DR/backup.sh" --kind database --no-tar >"$W/b3.json" 2>"$EV/backup-staging.log"; rc=$?
SPKG="$(python3 -c 'import json,sys;print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["dir"])' "$W/b3.json" 2>/dev/null)"
chk "staging backup exit 0, prerequisites.json + roles.sql captured (rc=$rc)" "[ $rc -eq 0 ] && [ -s '$SPKG/database/prerequisites.json' ] && [ -s '$SPKG/database/roles.sql' ] && [ ! -s '$SPKG/database/globals.sql' ]"

echo "== TARGET 1: fresh cluster, restore as NON-superuser dbadmin (CREATEROLE CREATEDB)"
cluster $T1
su_sql $T1 "CREATE ROLE dbadmin LOGIN CREATEROLE CREATEDB PASSWORD 'dbadmin-pw'"
chk "target 1 starts with none of the source roles" "[ \"\$(su_sql $T1 \"SELECT count(*) FROM pg_roles WHERE rolname LIKE 'tw_%'\")\" = 0 ]"
rm -rf "$W/mat"; bash "$DR/snapshot.sh" materialize "$PKG" "$W/mat" >/dev/null 2>"$EV/materialize.log"
T1_URL="postgresql://dbadmin:dbadmin-pw@127.0.0.1:$T1/twdb?sslmode=disable"
echo "-- negative: without --roles"
bash "$DR/restore.sh" "$W/mat/$PKG" --target-url "$T1_URL" --create-db --yes >"$EV/restore-t1-noroles.log" 2>&1; rc=$?
chk "without --roles: aborted BEFORE touching the target, names the missing roles (rc=$rc)" \
  "[ $rc -ne 0 ] && grep -q \"required role 'tw_owner'\" '$EV/restore-t1-noroles.log' && [ \"\$(su_sql $T1 \"SELECT count(*) FROM pg_database WHERE datname='twdb'\")\" = 0 ]"
bash "$DR/restore.sh" "$W/mat/$PKG" --target-url "$T1_URL" --create-db --roles --yes >"$EV/restore-t1.log" 2>&1; rc=$?
chk "restore as dbadmin with --roles: RESTORE OK (rc=$rc)" "[ $rc -eq 0 ] && grep -q 'RESTORE OK' '$EV/restore-t1.log'"
grep -E "✓|LOGIN roles|ALTER ROLE" "$EV/restore-t1.log" | sed 's/^.*\[dr\] /     /' | head -12
chk "roles recreated; unrelated role NOT created" "[ \"\$(su_sql $T1 \"SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('tw_owner','tw_app','tw_readonly','tw_report','unrelated')\")\" = 'tw_app,tw_owner,tw_readonly,tw_report' ]"
chk "attributes: tw_owner NOLOGIN, tw_app LOGIN" "[ \"\$(su_sql $T1 \"SELECT string_agg(rolname||'='||rolcanlogin, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('tw_owner','tw_app')\")\" = 'tw_app=true,tw_owner=false' ]"
chk "memberships: tw_app ∈ tw_owner, tw_report ∈ tw_readonly" "[ \"\$(su_sql $T1 \"SELECT count(*) FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.member JOIN pg_roles b ON b.oid=m.roleid WHERE (a.rolname,b.rolname) IN (('tw_app','tw_owner'),('tw_report','tw_readonly'))\")\" = 2 ]"
chk "role setting: tw_app statement_timeout=60s" "su_sql $T1 \"SELECT setconfig::text FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='tw_app' AND s.setdatabase=0\" | grep -q 'statement_timeout=60s'"
chk "database owned by tw_owner" "[ \"\$(su_sql $T1 \"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='twdb'\")\" = tw_owner ]"
chk "every table owned by tw_owner" "[ \"\$(su_sql $T1 \"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner<>'tw_owner'\" twdb)\" = 0 ]"
su_sql $T1 "ALTER ROLE tw_app PASSWORD 'new-app-pw'; ALTER ROLE tw_report PASSWORD 'new-report-pw'" >/dev/null
chk "app role logs in with the password from the secret store and reads data" "[ \"\$(as_sql $T1 tw_app new-app-pw 'SELECT count(*) FROM users')\" = '$SRC_USERS' ]"
chk "app role can write + sequences advance" "[ \"\$(as_sql $T1 tw_app new-app-pw 'INSERT INTO secrets_probe DEFAULT VALUES RETURNING id')\" = 2 ]"
chk "app role can run schema changes (boot drift-heal needs this)" "as_sql $T1 tw_app new-app-pw 'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS heal_probe int' >/dev/null"
chk "grants: tw_readonly can read documents, cannot read users" "[ \"\$(su_sql $T1 \"SELECT has_table_privilege('tw_readonly','documents','SELECT')::text || has_table_privilege('tw_readonly','users','SELECT')::text\" twdb)\" = truefalse ]"
chk "column grant: tw_report may read users.email only" "[ \"\$(as_sql $T1 tw_report new-report-pw 'SELECT count(email) FROM users')\" = '$SRC_USERS' ] && ! as_sql $T1 tw_report new-report-pw 'SELECT \"passwordHash\" FROM users' >/dev/null 2>&1"
chk "default privileges: a NEW table is readable by tw_readonly" "as_sql $T1 tw_app new-app-pw 'SET ROLE tw_owner; CREATE TABLE after_restore(x int)' >/dev/null && [ \"\$(su_sql $T1 \"SELECT has_table_privilege('tw_readonly','after_restore','SELECT')\" twdb)\" = t ]"
chk "RLS policy restored" "[ \"\$(su_sql $T1 \"SELECT polname FROM pg_policy\" twdb)\" = ro_tenants ]"
chk "extension pgcrypto restored and usable" "[ \"\$(as_sql $T1 tw_app new-app-pw 'SELECT length(gen_random_bytes(4))')\" = 4 ]"

echo "== TARGET 2: provider-owned source (doadmin) → fresh cluster with --role-map"
su_sql $SRC "CREATE ROLE doadmin LOGIN CREATEROLE CREATEDB PASSWORD 'do-pw'; GRANT CONNECT ON DATABASE postgres TO doadmin; CREATE DATABASE twdo OWNER doadmin" >/dev/null
PGPASSWORD=do-pw "$PGBIN/psql" -h 127.0.0.1 -p $SRC -U doadmin -d twdo -X -q -v ON_ERROR_STOP=1 -c "CREATE TABLE t(id int primary key, v text); INSERT INTO t VALUES (1,'a'),(2,'b'); GRANT SELECT ON t TO tw_readonly" >/dev/null
DATABASE_URL="postgresql://doadmin:do-pw@127.0.0.1:$SRC/twdo?sslmode=disable" bash "$DR/snapshot.sh" backup --kind database >"$W/b4.json" 2>"$EV/backup-doadmin.log"; rc=$?
PKG2="$(python3 -c 'import json,sys;print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["package"])' "$W/b4.json" 2>/dev/null)"
chk "provider-owned source backs up COMPLETE; doadmin flagged as provider-managed (rc=$rc)" "[ $rc -eq 0 ] && grep -q 'provider-managed: doadmin' '$EV/backup-doadmin.log'"
cluster $T2
rm -rf "$W/mat2"; bash "$DR/snapshot.sh" materialize "$PKG2" "$W/mat2" >/dev/null 2>&1
T2_URL="postgresql://postgres:superpw@127.0.0.1:$T2/twdo?sslmode=disable"
bash "$DR/restore.sh" "$W/mat2/$PKG2" --target-url "$T2_URL" --create-db --roles --yes >"$EV/restore-t2-nomap.log" 2>&1; rc=$?
chk "without --role-map: aborted, tells the operator to map doadmin (rc=$rc)" "[ $rc -ne 0 ] && grep -q \"provider-managed role 'doadmin'\" '$EV/restore-t2-nomap.log'"
bash "$DR/restore.sh" "$W/mat2/$PKG2" --target-url "$T2_URL" --create-db --roles --role-map doadmin:tw_recovered --yes >"$EV/restore-t2.log" 2>&1; rc=$?
chk "with --role-map doadmin:tw_recovered: RESTORE OK (rc=$rc)" "[ $rc -eq 0 ] && grep -q 'RESTORE OK' '$EV/restore-t2.log'"
chk "mapped role owns the database and its objects" "[ \"\$(su_sql $T2 \"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='twdo'\")\" = tw_recovered ] && [ \"\$(su_sql $T2 \"SELECT tableowner FROM pg_tables WHERE tablename='t'\" twdo)\" = tw_recovered ]"
chk "grant to tw_readonly preserved; data intact" "[ \"\$(su_sql $T2 \"SELECT has_table_privilege('tw_readonly','t','SELECT')::text || (SELECT count(*) FROM t)\" twdo)\" = true2 ]"

echo "== TARGET 3: source whose pg_dumpall WORKS (globals.sql non-empty) → fresh cluster as NON-superuser dbadmin"
chk "the doadmin package has a non-empty globals.sql" "[ -s '$W/mat2/$PKG2/database/globals.sql' ]"
T3=58614; fuser -k $T3/tcp >/dev/null 2>&1; cluster $T3
su_sql $T3 "CREATE ROLE dbadmin LOGIN CREATEROLE CREATEDB PASSWORD 'dbadmin-pw'" >/dev/null
bash "$DR/restore.sh" "$W/mat2/$PKG2" --target-url "postgresql://dbadmin:dbadmin-pw@127.0.0.1:$T3/twdo?sslmode=disable" \
  --create-db --roles --role-map doadmin:tw_recovered --yes >"$EV/restore-t3.log" 2>&1; rc=$?
chk "globals-created roles are SET-able by the non-superuser admin: RESTORE OK (rc=$rc)" "[ $rc -eq 0 ] && grep -q 'RESTORE OK' '$EV/restore-t3.log'"
chk "mapped owner + grant + data intact" "[ \"\$(su_sql $T3 \"SELECT tableowner FROM pg_tables WHERE tablename='t'\" twdo)\" = tw_recovered ] && [ \"\$(su_sql $T3 \"SELECT has_table_privilege('tw_readonly','t','SELECT')::text || (SELECT count(*) FROM t)\" twdo)\" = true2 ]"
sudo -u postgres "$PGBIN/pg_ctl" -D "$W/pg$T3" stop -m fast >/dev/null 2>&1

echo "result: $pass passed, $fail failed"
printf '{"passed":%d,"failed":%d,"environment":"local PostgreSQL 18 clusters (fresh initdb per target), S3 simulator"}\n' $pass $fail >"$EV/prereq-restore-test.json"
for p in $SRC $T1 $T2; do sudo -u postgres "$PGBIN/pg_ctl" -D "$W/pg$p" stop -m fast >/dev/null 2>&1; done
[ $fail -eq 0 ]
