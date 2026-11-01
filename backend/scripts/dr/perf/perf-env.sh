#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# perf-env.sh — throwaway, production-shaped dataset for resource measurements.
#
#   PostgreSQL 18 (:$PERF_PG, real Prisma schema, non-superuser owner) with
#     * $PERF_DB_MB MiB of incompressible bytes in a filler table (worst case
#       for the compressed dump), and
#     * one `documents` row per uploaded object (references → consistency check)
#   S3-compatible SIMULATOR (s3rver :$PERF_S3) with buckets
#     live-uploads (the app's upload bucket) and dr-backups (backup destination)
#     holding $PERF_OBJ_COUNT objects × $PERF_OBJ_MB MiB of random bytes.
#
# Usage: perf-env.sh up | down | env      (env prints the variables to source)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/../../.." && pwd)"
W="${PERF_DIR:-/tmp/dr-perf}"
PGBIN="${PG_BIN_PATH:-/usr/lib/postgresql/18/bin}"
PERF_PG="${PERF_PG:-58500}"; PERF_S3="${PERF_S3:-5577}"
PERF_DB_MB="${PERF_DB_MB:-300}"; PERF_OBJ_COUNT="${PERF_OBJ_COUNT:-300}"; PERF_OBJ_MB="${PERF_OBJ_MB:-2}"
S3RVER_MOD="${S3RVER_MOD:-/tmp/s3mock/node_modules/s3rver}"

print_env() {
cat <<EOF
export DATABASE_URL='postgresql://perf_app:perf_pw@127.0.0.1:$PERF_PG/perf?sslmode=disable'
export UPLOAD_STORAGE_DRIVER=spaces DO_SPACES_ENDPOINT=http://127.0.0.1:$PERF_S3 DO_SPACES_REGION=us-east-1
export DO_SPACES_BUCKET=live-uploads DO_SPACES_ACCESS_KEY=S3RVER DO_SPACES_SECRET_KEY=S3RVER
export DO_SPACES_PUBLIC_URL=http://127.0.0.1:$PERF_S3/live-uploads DO_SPACES_FORCE_PATH_STYLE=1
export BACKUP_SPACES_ENDPOINT=http://127.0.0.1:$PERF_S3 BACKUP_SPACES_REGION=us-east-1 BACKUP_SPACES_BUCKET=dr-backups
export BACKUP_SPACES_ACCESS_KEY=S3RVER BACKUP_SPACES_SECRET_KEY=S3RVER BACKUP_SPACES_FORCE_PATH_STYLE=1 BACKUP_SPACES_PREFIX=dr/
EOF
}

down() {
  fuser -k "$PERF_S3/tcp" >/dev/null 2>&1 || true
  [ -f "$W/pg/postmaster.pid" ] && sudo -u postgres "$PGBIN/pg_ctl" -D "$W/pg" stop -m fast >/dev/null 2>&1 || true
  rm -rf "$W"
}

up() {
  down; mkdir -p "$W/s3data"; chown postgres "$W"
  sudo -u postgres "$PGBIN/initdb" -D "$W/pg" -U postgres --auth-local=trust --auth-host=trust -E UTF8 >/dev/null
  { echo "port = $PERF_PG"; echo "unix_socket_directories = '$W'"; } >>"$W/pg/postgresql.conf"
  sudo -u postgres "$PGBIN/pg_ctl" -D "$W/pg" -l "$W/pg.log" -o "-p $PERF_PG" start >/dev/null; sleep 2
  P="$PGBIN/psql -h 127.0.0.1 -p $PERF_PG -U postgres -qtAX"
  $P -c "CREATE ROLE perf_app LOGIN PASSWORD 'perf_pw' NOSUPERUSER" -c "CREATE DATABASE perf OWNER perf_app"
  ( cd "$BACKEND" && npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script >"$W/schema.sql" )
  PGPASSWORD=perf_pw "$PGBIN/psql" -h 127.0.0.1 -p "$PERF_PG" -U perf_app -d perf -q -v ON_ERROR_STOP=1 -f "$W/schema.sql" >/dev/null
  A="$PGBIN/psql -h 127.0.0.1 -p $PERF_PG -U perf_app -d perf -qtAX -v ON_ERROR_STOP=1"
  export PGPASSWORD=perf_pw
  $A <<'SQL'
INSERT INTO tenants (id,slug,name,"updatedAt") VALUES ('t1','perf','Perf',now());
INSERT INTO roles (id,name,"updatedAt") VALUES ('r1','System Admin',now());
INSERT INTO agencies (id,name,country,"contactPerson",email,phone,"updatedAt","tenantId") VALUES ('a1','A','SK','c','a@a.a','1',now(),'t1');
INSERT INTO users (id,email,"passwordHash","firstName","lastName","roleId","agencyId","updatedAt") VALUES ('u1','u@a.a','x','U','A','r1','a1',now());
INSERT INTO document_types (id,name,category,"updatedAt") VALUES ('d1','Contract','CONTRACT',now());
INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,"dateOfBirth","addressLine1",city,country,"postalCode","updatedAt","tenantId")
  VALUES ('e1','P','E','p@e.e','1','SK','1990-01-01','a','b','SK','1',now(),'t1');
CREATE TABLE dr_perf_blob (id int PRIMARY KEY, payload bytea NOT NULL);
SQL
  echo "filler: ${PERF_DB_MB} MiB of random bytes …"
  python3 - "$PERF_DB_MB" <<'PY' | $A -c "COPY dr_perf_blob (id, payload) FROM STDIN"
import os, sys
for i in range(int(sys.argv[1])):
    sys.stdout.write(f"{i}\t\\\\x{os.urandom(1 << 20).hex()}\n")
PY
  echo "objects: ${PERF_OBJ_COUNT} × ${PERF_OBJ_MB} MiB into the S3 simulator …"
  cat >"$W/s3.cjs" <<JS
const S3rver = require('$S3RVER_MOD');
new S3rver({ port: $PERF_S3, address: '127.0.0.1', silent: true, directory: '$W/s3data',
  configureBuckets: [{ name: 'live-uploads' }, { name: 'dr-backups' }] }).run().then(() => console.log('up'));
JS
  setsid -f node "$W/s3.cjs" >"$W/s3.log" 2>&1 </dev/null
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PERF_S3/" && break; sleep 0.3; done
  ( cd "$BACKEND" && node - "$PERF_OBJ_COUNT" "$PERF_OBJ_MB" "$PERF_S3" "$W/docs.tsv" <<'JS'
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomBytes, randomUUID } = require('crypto');
const fs = require('fs');
const [n, mb, port, out] = process.argv.slice(2);
const s3 = new S3Client({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' } });
(async () => {
  const lines = [];
  for (let i = 0; i < Number(n); i++) {
    const key = `documents/EMPLOYEE/e1/Contract/${randomUUID()}.pdf`;
    await s3.send(new PutObjectCommand({ Bucket: 'live-uploads', Key: key, Body: randomBytes(Number(mb) << 20), ContentType: 'application/pdf' }));
    lines.push([`doc${i}`, `doc ${i}`, 'd1', 'EMPLOYEE', 'e1', `http://127.0.0.1:${port}/live-uploads/${key}`, 'application/pdf', Number(mb) << 20, 'u1', 't1'].join('\t'));
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
})();
JS
  )
  $A -c "\\copy documents (id,name,\"documentTypeId\",\"entityType\",\"entityId\",\"fileUrl\",\"mimeType\",\"fileSize\",\"uploadedById\",\"tenantId\") FROM '$W/docs.tsv'" 2>/dev/null \
    || $A -c "ALTER TABLE documents ALTER COLUMN \"updatedAt\" SET DEFAULT now()" -c "\\copy documents (id,name,\"documentTypeId\",\"entityType\",\"entityId\",\"fileUrl\",\"mimeType\",\"fileSize\",\"uploadedById\",\"tenantId\") FROM '$W/docs.tsv'"
  echo "db size: $($A -c "SELECT pg_size_pretty(pg_database_size('perf'))")  objects: $(du -sh "$W/s3data/live-uploads" | cut -f1)  documents: $($A -c 'SELECT count(*) FROM documents')"
}

case "${1:-}" in up) up ;; down) down ;; env) print_env ;; *) echo "usage: perf-env.sh up|down|env"; exit 1 ;; esac
