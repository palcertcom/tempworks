#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# image-checks.sh — validate the FINAL production image as it will run:
# non-root, from its own entry point, with nothing but environment variables.
#
#   1  identity (image id, user, entrypoint, size) + non-root
#   2  PostgreSQL client tools (major 18) and the Prisma CLI inside the image
#      (as the image user, no network: the schema engine must already be there)
#   3  schema from the image's Prisma schema + seed rows — both are
#      preconditions: if either fails the run STOPS (no backup/restore of an
#      empty database is reported); then the
#      startup path: non-empty DB without migration history → P3005, server
#      NOT started; baselined DB → "No pending migrations" → listening on $PORT
#      (NODE_ENV=production, DATABASE_TLS_STRICT_MIGRATIONS=1 with the DB CA)
#   4  graceful stop (SIGTERM) → exits promptly, schedulers stopped
#   5  the documented TLS diagnostic `node scripts/ops/tls-check.mjs` from the
#      image: DB over TLS with a private CA (wrong CA → failure); with
#      CHECK_EXTERNAL=1 also the real public endpoints (DigitalOcean Spaces
#      fra1/ams3 incl. bucket host names, api.resend.com, www.google.com)
#   6  backup → restore cycle entirely from the image: streaming snapshot of the
#      TLS database (pg_dumpall refused for the app role), deep verify,
#      materialize, restore into a FRESH cluster as a NON-superuser admin;
#      the restored data must equal the source (row counts of every table,
#      content hashes of the seeded tables)
#
# IMAGE_CHECKS_FAULT=schema|seed (test-only) injects that failure.
#
# Uses host PostgreSQL 18 (initdb, run as the postgres OS user via sudo), a
# local S3 simulator (s3rver) and `docker run --network host`. Runs the same in
# CI and locally.   Usage: image-checks.sh <image> <evidence-dir>
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
IMG="$1"; EV="$2"; mkdir -p "$EV"
PGBIN="${PG_BIN_PATH:-/usr/lib/postgresql/18/bin}"
W="$(mktemp -d /tmp/imgchk-pg.XXXXXX)"; chmod 755 "$W"     # PostgreSQL clusters (owned by postgres)
X="$(mktemp -d /tmp/imgchk-x.XXXXXX)"                         # everything else (owned by the caller)
PG1=55432; PG2=55433; S3=55590; APPPORT=58080; H=pg-ci.internal
pass=0; fail=0; results=()
ok() { echo "  ✓ $*"; pass=$((pass+1)); results+=("{\"ok\":true,\"check\":$(printf '%s' "$*" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}"); }
no() { echo "  ✗ $*"; fail=$((fail+1)); results+=("{\"ok\":false,\"check\":$(printf '%s' "$*" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}"); }
chk() { if eval "$2"; then ok "$1"; else no "$1"; fi; }
finish() {
  printf '{"image":"%s","passed":%d,"failed":%d,"stoppedAfter":%s,"checks":[%s]}\n' "$IMG" "$pass" "$fail" \
    "$([ -n "${1:-}" ] && printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' || echo null)" \
    "$(IFS=,; echo "${results[*]}")" >"$EV/image-checks.json"
  echo "result: $pass passed, $fail failed${1:+ — STOPPED after: $1}"
  [ "$fail" -eq 0 ]; exit
}
# Precondition: when it fails, every later check would test nothing (e.g. a
# backup/restore of an empty database), so stop instead of reporting them.
must() { if eval "$2"; then ok "$1"; else no "$1"; echo "  STOP: precondition failed — later checks would be meaningless"; finish "$1"; fi; }
run() { docker run --rm --network host --add-host "$H:127.0.0.1" "$@"; }
cleanup() {
  docker rm -f twci-app >/dev/null 2>&1
  for p in $PG1 $PG2; do sudo -u postgres "$PGBIN/pg_ctl" -D "$W/pg$p" stop -m fast >/dev/null 2>&1; done
  [ -n "${S3PID:-}" ] && kill "$S3PID" 2>/dev/null
  sudo rm -rf "$W" "$X"
}
trap cleanup EXIT
grep -q " $H\$" /etc/hosts || echo "127.0.0.1 $H" | sudo tee -a /etc/hosts >/dev/null

echo "== 1. identity"
docker image inspect "$IMG" --format '{"id":"{{.Id}}","user":"{{.Config.User}}","entrypoint":"{{json .Config.Entrypoint}}","size":{{.Size}},"created":"{{.Created}}","arch":"{{.Architecture}}"}' >"$EV/image-identity.json"
cat "$EV/image-identity.json"; echo
chk "runs as a non-root user ($(run --entrypoint id "$IMG" -un))" "[ \"\$(run --entrypoint id '$IMG' -u)\" != 0 ]"

echo "== 2. tools inside the image"
run "$IMG" sh -c 'for t in pg_dump pg_restore psql pg_dumpall; do $t --version; done; python3 --version; bash --version | head -1; node --version' >"$EV/image-tools.txt" 2>&1
cat "$EV/image-tools.txt"
chk "pg_dump/pg_restore/psql/pg_dumpall are all major 18" "[ \"\$(grep -c ' 18\\.' '$EV/image-tools.txt')\" = 4 ]"
docker run --rm --network none "$IMG" npx --no-install prisma --version >"$EV/image-prisma.txt" 2>&1
PV="$(grep -m1 -E '^prisma ' "$EV/image-prisma.txt" | tr -s ' ')"; PE="$(grep -o 'schema-engine-[a-z0-9.-]*x' "$EV/image-prisma.txt" | tail -1)"
must "Prisma CLI runs as the image user without network, engine already in the image (${PV:-$(grep -m1 '^Error' "$EV/image-prisma.txt")}${PE:+; $PE})" \
  "grep -qE '^prisma +: 7\\.' '$EV/image-prisma.txt' && grep -q 'Schema Engine' '$EV/image-prisma.txt' && ! grep -q \"Can't write\" '$EV/image-prisma.txt'"

echo "== 3. database over TLS (private CA, host name $H)"
( cd "$W" && openssl req -new -x509 -days 2 -nodes -subj "/CN=CI DB CA" -keyout ca.key -out ca.crt 2>/dev/null \
  && openssl req -new -x509 -days 2 -nodes -subj "/CN=Wrong CA" -keyout wrong.key -out wrong.crt 2>/dev/null \
  && openssl req -new -nodes -subj "/CN=$H" -keyout server.key -out server.csr 2>/dev/null \
  && printf 'subjectAltName=DNS:%s\n' "$H" >san.ext \
  && openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out server.crt 2>/dev/null )
echo superpw >"$W/pw"; sudo chown -R postgres "$W"; sudo chmod 600 "$W/server.key"
cluster() { # $1 port  $2 tls(1|0)
  sudo -u postgres "$PGBIN/initdb" -D "$W/pg$1" -U postgres --auth-host=scram-sha-256 --auth-local=trust --pwfile="$W/pw" >/dev/null
  { echo "port = $1"; echo "listen_addresses = '127.0.0.1'"; echo "unix_socket_directories = '$W'"
    [ "$2" = 1 ] && { echo "ssl = on"; echo "ssl_cert_file = '$W/server.crt'"; echo "ssl_key_file = '$W/server.key'"; }; } | sudo -u postgres tee -a "$W/pg$1/postgresql.conf" >/dev/null
  sudo -u postgres "$PGBIN/pg_ctl" -D "$W/pg$1" -l "$W/pg$1.log" start >/dev/null; sleep 2
}
su_sql() { PGPASSWORD=superpw "$PGBIN/psql" -h 127.0.0.1 -p "$1" -U postgres -d "${3:-postgres}" -X -qtA -v ON_ERROR_STOP=1 <<<"$2"; }
cluster $PG1 1
su_sql $PG1 "CREATE ROLE tw_app LOGIN PASSWORD 'ci-app-pw';
CREATE DATABASE tw OWNER tw_app;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;" >/dev/null
CA="$(sudo cat "$W/ca.crt")"; WRONG="$(sudo cat "$W/wrong.crt")"
DBURL="postgresql://tw_app:ci-app-pw@$H:$PG1/tw?sslmode=require"
app_sql() { PGPASSWORD=ci-app-pw PGSSLMODE=require "$PGBIN/psql" -h 127.0.0.1 -p $PG1 -U tw_app -d tw -X -q -v ON_ERROR_STOP=1 "$@"; }
run "$IMG" npx --no-install prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script >"$X/schema.sql" 2>"$EV/schema-diff.err"; rc_diff=$?
# IMAGE_CHECKS_FAULT=schema|seed (test-only) proves that the run stops there.
[ "${IMAGE_CHECKS_FAULT:-}" = schema ] && echo 'CREATE TABLE broken (' >"$X/schema.sql"
app_sql -f "$X/schema.sql" >/dev/null 2>"$EV/schema-apply.err"; rc_apply=$?
NT="$(grep -c 'CREATE TABLE' "$X/schema.sql")"
DBT="$(su_sql $PG1 "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" tw 2>/dev/null)"
must "schema created from the image's Prisma schema (diff rc=$rc_diff, apply rc=$rc_apply, $DBT of $NT tables in the database)" \
  "[ $rc_diff -eq 0 ] && [ $rc_apply -eq 0 ] && [ \"${NT:-0}\" -gt 0 ] && [ \"${DBT:-0}\" = \"$NT\" ]"
# Seed application data now, so that every later step (P3005 on a non-empty
# database, backup, restore) works on real rows, not on an empty schema.
[ "${IMAGE_CHECKS_FAULT:-}" = seed ] && su_sql $PG1 'DROP TABLE roles CASCADE' tw >/dev/null
app_sql >/dev/null 2>"$EV/seed.err" <<'SQL'; rc_seed=$?
INSERT INTO tenants (id,slug,name,"updatedAt") VALUES ('t1','ci','CI',now()), ('t2','ci-two','CI Two',now());
INSERT INTO roles (id,name,"updatedAt") VALUES ('r1','System Admin',now()), ('r2','Recruiter',now());
SQL
# Exact row counts of every application table plus content hashes of the
# seeded tables: "name=rows … tenants.md5=… roles.md5=…". system_backups is
# compared separately: restore.sh registers the restored package there.
FP_SQL="SELECT string_agg(format('%s=%s', table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text), ' ' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT IN ('_prisma_migrations','system_backups');
SELECT 'tenants.md5=' || md5(string_agg(t::text, '|' ORDER BY t.id)) FROM tenants t;
SELECT 'roles.md5=' || md5(string_agg(r::text, '|' ORDER BY r.id)) FROM roles r;"
fingerprint() { su_sql "$1" "$FP_SQL" tw 2>/dev/null | tr '\n' ' ' | sed 's/ *$//'; }
counts() { tr ' ' '\n' <<<"$1" | grep -E '^[a-z0-9_]+=[0-9]+$'; }
rows_of() { counts "$1" | grep "^$2=" | cut -d= -f2; }
total_rows() { counts "$1" | cut -d= -f2 | awk '{s+=$1} END {print s+0}'; }
SEEDFP="$(fingerprint $PG1)"
must "seed data inserted (rc=$rc_seed; tenants=$(rows_of "$SEEDFP" tenants), roles=$(rows_of "$SEEDFP" roles))" \
  "[ $rc_seed -eq 0 ] && [ \"\$(rows_of \"\$SEEDFP\" tenants)\" = 2 ] && [ \"\$(rows_of \"\$SEEDFP\" roles)\" = 2 ]"

APPENV=( -e DATABASE_URL="$DBURL" -e DATABASE_CA_CERT="$CA" -e DATABASE_TLS_STRICT_MIGRATIONS=1 -e PORT=$APPPORT -e NODE_ENV=production
         -e JWT_SECRET=ci-only-secret -e JWT_REFRESH_SECRET=ci-only-refresh -e UPLOAD_STORAGE_DRIVER=local )
echo "-- non-empty DB without migration history"
timeout 120 docker run --rm --network host --add-host "$H:127.0.0.1" "${APPENV[@]}" "$IMG" >"$EV/start-unbaselined.log" 2>&1; rc=$?
chk "unbaselined: migrate deploy fails (P3005), container exits non-zero (rc=$rc), server not started" \
  "[ $rc -ne 0 ] && grep -q P3005 '$EV/start-unbaselined.log' && ! grep -q 'starting dist' '$EV/start-unbaselined.log'"
for m in $(run "$IMG" sh -c 'cd prisma/migrations && for d in */; do echo "${d%/}"; done'); do
  run "${APPENV[@]}" "$IMG" npx --no-install prisma migrate resolve --applied "$m" >>"$EV/baseline.log" 2>&1
done
NMIG="$(su_sql $PG1 'SELECT count(*) FROM _prisma_migrations' tw 2>/dev/null)"
chk "baseline recorded (${NMIG:-no} migrations)" "[ \"${NMIG:-0}\" -ge 1 ]"
echo "-- documented start path (no command): strict-TLS migrate deploy, then the server"
docker rm -f twci-app >/dev/null 2>&1
docker run -d --name twci-app --network host --add-host "$H:127.0.0.1" "${APPENV[@]}" "$IMG" >/dev/null
up=0; for _ in $(seq 1 90); do curl -s -o /dev/null "http://127.0.0.1:$APPPORT/api/docs" && { up=1; break; }; sleep 1; done
sleep 2; docker logs twci-app >"$EV/start-baselined.log" 2>&1
sed -n '1,6p' "$EV/start-baselined.log"
chk "migrations verified the DB certificate strictly (DATABASE_CA_CERT)" "grep -q 'verified against DATABASE_CA_CERT' '$EV/start-baselined.log'"
chk "\"No pending migrations\" then the server started" "grep -q 'No pending migrations' '$EV/start-baselined.log' && grep -q 'starting dist/src/main.js' '$EV/start-baselined.log'"
chk "listening on \$PORT=$APPPORT (HTTP 200 from /api/docs)" "[ $up = 1 ] && grep -q 'running on: http://localhost:$APPPORT' '$EV/start-baselined.log'"

echo "== 4. graceful stop"
t0=$(date +%s); docker stop -t 30 twci-app >/dev/null; t1=$(date +%s)
code="$(docker inspect -f '{{.State.ExitCode}}' twci-app)"; docker logs twci-app >"$EV/stop.log" 2>&1
chk "SIGTERM → exited in $((t1-t0)) s (code $code), schedulers stopped" "[ $((t1-t0)) -lt 25 ] && grep -q 'scheduler stopped' '$EV/stop.log'"
docker rm -f twci-app >/dev/null

echo "== 5. TLS diagnostic (documented command) from the image"
EXT=( -e TLS_CHECK_SKIP_EXTERNAL=1 )
if [ "${CHECK_EXTERNAL:-0}" = 1 ]; then
  EXT=( -e DO_SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com -e DO_SPACES_BUCKET=tempworks-uploads
        -e DO_SPACES_PUBLIC_URL=https://tempworks-uploads.fra1.digitaloceanspaces.com
        -e BACKUP_SPACES_ENDPOINT=https://ams3.digitaloceanspaces.com -e BACKUP_SPACES_BUCKET=tempworks-dr-backups )
fi
run -e DATABASE_URL="$DBURL" -e DATABASE_CA_CERT="$CA" "${EXT[@]}" "$IMG" node scripts/ops/tls-check.mjs >"$EV/tls-check.txt" 2>&1; rc=$?
cat "$EV/tls-check.txt" | grep -v '^{'
chk "tls-check with the right CA: everything verified (rc=$rc)" "[ $rc -eq 0 ]"
run -e DATABASE_URL="$DBURL" -e DATABASE_CA_CERT="$WRONG" -e TLS_CHECK_SKIP_EXTERNAL=1 "$IMG" node scripts/ops/tls-check.mjs >"$EV/tls-check-wrong-ca.txt" 2>&1; rc=$?
chk "tls-check with a WRONG CA: reports the failure (rc=$rc)" "[ $rc -ne 0 ] && grep -q '✗' '$EV/tls-check-wrong-ca.txt'"
chk "tls-check output contains no credentials" "! grep -q 'ci-app-pw' '$EV/tls-check.txt' '$EV/tls-check-wrong-ca.txt'"

echo "== 6. backup → restore cycle from the image (fresh cluster, non-superuser admin)"
mkdir -p "$X/s3tool" && ( cd "$X/s3tool" && npm init -y >/dev/null && npm install --no-audit --no-fund s3rver@3.7.1 >/dev/null 2>&1 )
cat >"$X/s3tool/run.cjs" <<JS
const S3rver = require('s3rver');
new S3rver({ port: $S3, address: '127.0.0.1', silent: true, directory: '$X/s3data', configureBuckets: [{ name: 'ci-backups' }] }).run();
JS
node "$X/s3tool/run.cjs" & S3PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$S3/" && break; sleep 0.5; done
BK=( -e BACKUP_SPACES_ENDPOINT=http://127.0.0.1:$S3 -e BACKUP_SPACES_REGION=us-east-1 -e BACKUP_SPACES_BUCKET=ci-backups
     -e BACKUP_SPACES_ACCESS_KEY=S3RVER -e BACKUP_SPACES_SECRET_KEY=S3RVER -e BACKUP_SPACES_FORCE_PATH_STYLE=1 -e BACKUP_SPACES_PREFIX=dr/ )
# Fingerprint the source as it is backed up (the app above may have added rows).
SRCFP="$(fingerprint $PG1)"; printf '%s\n' "$SRCFP" >"$EV/source-data.txt"
must "source holds application data before the backup ($(total_rows "$SRCFP") rows; tenants=$(rows_of "$SRCFP" tenants), roles=$(rows_of "$SRCFP" roles))" \
  "[ \"\$(rows_of \"\$SRCFP\" tenants)\" = 2 ] && [ \"\$(rows_of \"\$SRCFP\" roles)\" -ge 2 ]"
run "${BK[@]}" -e DATABASE_URL="$DBURL" -e DATABASE_CA_CERT="$CA" -e UPLOAD_STORAGE_DRIVER=local "$IMG" \
  bash scripts/dr/snapshot.sh backup --kind database --label ci >"$X/backup.json" 2>"$EV/cycle-backup.log"; rc=$?
PKG="$(python3 -c 'import json,sys;print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["package"])' "$X/backup.json" 2>/dev/null)"
chk "streaming backup from the image over verified TLS: COMPLETE (rc=$rc) although pg_dumpall is refused" \
  "[ $rc -eq 0 ] && grep -q 'pg_dumpall --globals-only refused' '$EV/cycle-backup.log'"
run "${BK[@]}" "$IMG" bash scripts/dr/snapshot.sh verify "$PKG" --deep >/dev/null 2>"$EV/cycle-verify.log"; rc=$?
chk "deep verify from the image (rc=$rc)" "[ $rc -eq 0 ]"
mkdir -p "$X/mat"; sudo chown 1000:1000 "$X/mat"
run "${BK[@]}" -v "$X/mat:/srv/restore" "$IMG" bash scripts/dr/snapshot.sh materialize "$PKG" /srv/restore >/dev/null 2>"$EV/cycle-materialize.log"
cluster $PG2 0
su_sql $PG2 "CREATE ROLE dbadmin LOGIN CREATEROLE CREATEDB PASSWORD 'dbadmin-pw'" >/dev/null
run -v "$X/mat:/srv/restore" "$IMG" bash scripts/dr/restore.sh "/srv/restore/$PKG" \
  --target-url "postgresql://dbadmin:dbadmin-pw@127.0.0.1:$PG2/tw?sslmode=disable" --create-db --roles --yes >"$EV/cycle-restore.log" 2>&1; rc=$?
chk "restore from the image into a FRESH cluster as non-superuser dbadmin: RESTORE OK (rc=$rc)" "[ $rc -eq 0 ] && grep -q 'RESTORE OK' '$EV/cycle-restore.log'"
chk "restored database tw owned by tw_app" "[ \"\$(su_sql $PG2 \"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='tw'\")\" = tw_app ]"
DSTFP="$(fingerprint $PG2)"; printf '%s\n' "$DSTFP" >"$EV/restored-data.txt"
chk "restored application data identical to the source: row counts of all $(counts "$SRCFP" | wc -l) tables ($(total_rows "$DSTFP") rows) and content hashes of tenants/roles" \
  "[ -n \"\$DSTFP\" ] && [ \"\$DSTFP\" = \"\$SRCFP\" ]"
SRCCAT="$(su_sql $PG1 'SELECT count(*) FROM system_backups' tw 2>/dev/null)"
DSTCAT="$(su_sql $PG2 "SELECT count(*) || '/' || count(*) FILTER (WHERE \"fileName\" = '$PKG' AND status = 'COMPLETED' AND \"restoreTestedAt\" IS NOT NULL) FROM system_backups" tw 2>/dev/null)"
chk "restored backup catalog = source catalog ($SRCCAT rows) + this package registered as restore-tested ($DSTCAT)" \
  "[ -n '$PKG' ] && [ '$DSTCAT' = \"\$(( ${SRCCAT:-0} + 1 ))/1\" ]"

finish
