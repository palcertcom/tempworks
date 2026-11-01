#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# tls-local-test.sh — proves the DATABASE_CA_CERT trust path on a LOCAL
# PostgreSQL 18 with TLS and a private CA (stand-in for a managed database's
# CA). Covers: the app's pool policy (tls-check), Prisma CLI (migrate status,
# same code path as migrate deploy) and libpq tools used by DR (preflight +
# a streaming snapshot). Includes negative cases (no CA, wrong CA, host-name
# mismatch) so "verified" is shown to mean something.
# Usage: tls-local-test.sh <evidence-dir>
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
EV="${1:-/tmp/tls-test}"; mkdir -p "$EV"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; BACKEND="$(cd "$HERE/../.." && pwd)"
PGBIN=/usr/lib/postgresql/18/bin; W=/tmp/tls-pg; PORT=58502; H=pg-tls.internal
fuser -k $PORT/tcp >/dev/null 2>&1; rm -rf "$W"; mkdir -p "$W"; cd "$W"
openssl req -new -x509 -days 30 -nodes -subj "/CN=TempWorks Test DB CA" -keyout ca.key -out ca.crt 2>/dev/null
openssl req -new -x509 -days 30 -nodes -subj "/CN=Some Other CA" -keyout other.key -out other-ca.crt 2>/dev/null
openssl req -new -nodes -subj "/CN=$H" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:%s\n' "$H" >san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile san.ext -out server.crt 2>/dev/null
chown -R postgres "$W"; chmod 600 server.key
sudo -u postgres $PGBIN/initdb -D "$W/pg" -U postgres --auth-host=scram-sha-256 --pwfile=<(echo tlspw) >/dev/null 2>&1 || \
  { echo tlspw >"$W/pw"; chown postgres "$W/pw"; sudo -u postgres $PGBIN/initdb -D "$W/pg" -U postgres --auth-host=scram-sha-256 --pwfile="$W/pw" >/dev/null; }
cat >>"$W/pg/postgresql.conf" <<CONF
port = $PORT
unix_socket_directories = '$W'
ssl = on
ssl_cert_file = '$W/server.crt'
ssl_key_file = '$W/server.key'
CONF
sed -i 's/^host /hostssl /' "$W/pg/pg_hba.conf"
sudo -u postgres $PGBIN/pg_ctl -D "$W/pg" -l "$W/pg.log" start >/dev/null; sleep 2
grep -q " $H\$" /etc/hosts || echo "127.0.0.1 $H" >>/etc/hosts
cd "$BACKEND"
URL="postgresql://postgres:tlspw@$H:$PORT/postgres?sslmode=require"
IPURL="postgresql://postgres:tlspw@127.0.0.1:$PORT/postgres?sslmode=require"
CA="$(cat "$W/ca.crt")"; OTHER="$(cat "$W/other-ca.crt")"
pass=0; fail=0
expect() { # $1 name  $2 expected(0|nonzero)  $3.. cmd
  local name="$1" want="$2"; shift 2
  "$@" >"$EV/$(echo "$name" | tr ' /' '__').log" 2>&1; local rc=$?
  if { [ "$want" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want" != 0 ] && [ $rc -ne 0 ]; }; then echo "  ✓ $name (rc=$rc)"; pass=$((pass+1)); else echo "  ✗ $name (rc=$rc, expected $want)"; fail=$((fail+1)); fi
}
echo "== app pool policy via tls-check (DB only)"
expect "no CA: tls-check reports NOT verified"            1 env -u DATABASE_CA_CERT TLS_CHECK_SKIP_EXTERNAL=1 DATABASE_URL="$URL" node scripts/ops/tls-check.mjs
expect "CA via DATABASE_CA_CERT: all verified"            0 env TLS_CHECK_SKIP_EXTERNAL=1 DATABASE_URL="$URL" DATABASE_CA_CERT="$CA" node scripts/ops/tls-check.mjs
expect "CA, but host-name mismatch (IP): fails"           1 env TLS_CHECK_SKIP_EXTERNAL=1 DATABASE_URL="$IPURL" DATABASE_CA_CERT="$CA" node scripts/ops/tls-check.mjs
expect "one-line PEM with literal \\n accepted"           0 env TLS_CHECK_SKIP_EXTERNAL=1 DATABASE_URL="$URL" DATABASE_CA_CERT="$(awk '{printf "%s\\n", $0}' "$W/ca.crt")" node scripts/ops/tls-check.mjs
echo "== app pool: verification is enforced (wrong CA must fail to connect)"
expect "app policy + correct CA connects"                 0 env DATABASE_URL="$URL" DATABASE_CA_CERT="$CA" node -e "const {Client}=require('pg');const {resolvePoolSsl}=require('./prisma/pg-ssl.js');const c=new Client({connectionString:process.env.DATABASE_URL.replace('?sslmode=require',''),ssl:resolvePoolSsl(process.env.DATABASE_URL)});c.connect().then(()=>c.query('select 1')).then(()=>c.end()).catch(e=>{console.error(e.message);process.exit(1)})"
expect "app policy + WRONG CA is refused"                 1 env DATABASE_URL="$URL" DATABASE_CA_CERT="$OTHER" node -e "const {Client}=require('pg');const {resolvePoolSsl}=require('./prisma/pg-ssl.js');const c=new Client({connectionString:process.env.DATABASE_URL.replace('?sslmode=require',''),ssl:resolvePoolSsl(process.env.DATABASE_URL)});c.connect().then(()=>c.query('select 1')).then(()=>c.end()).catch(e=>{console.error(e.message);process.exit(1)})"
echo "== Prisma CLI migration engine (own TLS stack: ignores the Node adapter and DATABASE_CA_CERT)"
expect "FINDING: default sslmode=require connects even with a WRONG CA (not verified)" 0 bash -c "DATABASE_URL='$URL' DATABASE_CA_CERT=\"\$0\" npx prisma migrate status 2>&1 | grep -q 'migrations found'" "$OTHER"
expect "strict params (sslcert+sslaccept=strict) + correct CA connects"  0 bash -c "DATABASE_URL='$URL&sslcert=$W/ca.crt&sslaccept=strict' npx prisma migrate status 2>&1 | grep -q 'migrations found'"
expect "strict params + WRONG CA refused (P1011)"                       0 bash -c "DATABASE_URL='$URL&sslcert=$W/other-ca.crt&sslaccept=strict' npx prisma migrate status 2>&1 | grep -q P1011"
expect "strict params + host-name mismatch refused (P1011)"             0 bash -c "DATABASE_URL='$IPURL&sslcert=$W/ca.crt&sslaccept=strict' npx prisma migrate status 2>&1 | grep -q P1011"
IMG="${IMG:-tempworks-backend:candidate}"
if docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "== container entrypoint with DATABASE_TLS_STRICT_MIGRATIONS=1 ($IMG)"
  entry() { # $1 CA pem  $2 log file
    docker rm -f tw-tls >/dev/null 2>&1
    docker run -d --name tw-tls --network host --add-host "$H:127.0.0.1" -e DATABASE_URL="$URL" \
      -e DATABASE_TLS_STRICT_MIGRATIONS=1 -e DATABASE_CA_CERT="$1" -e JWT_SECRET=x -e JWT_REFRESH_SECRET=y -e PORT=58999 "$IMG" >/dev/null
    for _ in $(seq 1 60); do docker logs tw-tls 2>&1 | grep -qE "P1011|starting dist|Error:" && break; sleep 1; done
    sleep 2; docker logs tw-tls >"$2" 2>&1; docker rm -f tw-tls >/dev/null
  }
  entry "$OTHER" "$EV/entrypoint-wrong-ca.log"
  expect "entrypoint strict + WRONG CA: migrate refused (P1011)"   0 grep -q P1011 "$EV/entrypoint-wrong-ca.log"
  expect "entrypoint strict + WRONG CA: server NOT started"        1 grep -q "starting dist" "$EV/entrypoint-wrong-ca.log"
  entry "$CA" "$EV/entrypoint-right-ca.log"
  expect "entrypoint strict + correct CA: TLS accepted (no P1011)" 1 grep -q P1011 "$EV/entrypoint-right-ca.log"
  expect "entrypoint strict + correct CA: migrations reached"      0 grep -qE "migrations found|Applying migration|applied" "$EV/entrypoint-right-ca.log"
fi
echo "== libpq tools used by DR (preflight: psql + pg_dump)"
expect "DR preflight + correct CA"                        0 env DATABASE_URL="$URL" DATABASE_CA_CERT="$CA" PG_BIN_PATH=$PGBIN bash scripts/dr/preflight.sh --backup-dir /tmp/tls-pg/bk
expect "DR preflight + WRONG CA refused"                  1 env DATABASE_URL="$URL" DATABASE_CA_CERT="$OTHER" PG_BIN_PATH=$PGBIN bash scripts/dr/preflight.sh --backup-dir /tmp/tls-pg/bk
echo "result: $pass passed, $fail failed"
printf '{"passed":%d,"failed":%d,"environment":"local PostgreSQL 18 with TLS + private test CA"}\n' $pass $fail >"$EV/tls-local-test.json"
sudo -u postgres $PGBIN/pg_ctl -D "$W/pg" stop -m fast >/dev/null
[ $fail -eq 0 ]
