#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# spaces-real-test.sh — controlled test of the backup engine against REAL
# DigitalOcean Spaces, using ONLY isolated test objects:
#   * live side : a DEDICATED, EMPTY test bucket (TEST_LIVE_BUCKET) — never the
#                 production upload bucket (refused if it equals
#                 tempworks-uploads or already contains objects)
#   * backup side: the real backup bucket, under a separate test prefix
#                 (BACKUP_SPACES_PREFIX defaults to dr-test/<timestamp>/)
#   * database  : a throwaway local PostgreSQL 18 cluster
# It exercises what the S3 simulator cannot prove: real multipart uploads (a
# 40 MiB object + the dump), listing, metadata (write-once version evidence
# set by StorageService), ETags, DeleteObjects, the checksum-header settings
# and TLS — then restores into a second fresh cluster and compares hashes.
# Everything it created is deleted at the end (test bucket objects + prefix).
#
# Run on a host with this repository (backend `npm ci` done), PostgreSQL 18
# server+client and sudo — e.g. the temporary recovery droplet:
#   export TEST_LIVE_BUCKET=<empty test bucket>  DO_SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com DO_SPACES_REGION=fra1
#   export DO_SPACES_ACCESS_KEY=… DO_SPACES_SECRET_KEY=…        # key allowed on the TEST bucket
#   export BACKUP_SPACES_ENDPOINT=https://ams3.digitaloceanspaces.com BACKUP_SPACES_REGION=ams3
#   export BACKUP_SPACES_BUCKET=<backup bucket> BACKUP_SPACES_ACCESS_KEY=… BACKUP_SPACES_SECRET_KEY=…
#   bash backend/scripts/dr/tests/spaces-real-test.sh <evidence-dir>
# Credentials are read from the environment only and never printed.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
EV="${1:-./spaces-real-test-evidence}"; mkdir -p "$EV"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; DR="$(cd "$HERE/.." && pwd)"; BACKEND="$(cd "$DR/../.." && pwd)"
PGBIN=/usr/lib/postgresql/18/bin; W="$(mktemp -d /tmp/spaces-test.XXXXXX)"; P1=58711; P2=58712
for v in TEST_LIVE_BUCKET DO_SPACES_ENDPOINT DO_SPACES_REGION DO_SPACES_ACCESS_KEY DO_SPACES_SECRET_KEY BACKUP_SPACES_BUCKET BACKUP_SPACES_ACCESS_KEY BACKUP_SPACES_SECRET_KEY; do
  [ -n "${!v:-}" ] || { echo "set $v"; exit 2; }
done
[ "$TEST_LIVE_BUCKET" != "tempworks-uploads" ] || { echo "refusing: TEST_LIVE_BUCKET must not be the production upload bucket"; exit 2; }
export DO_SPACES_BUCKET="$TEST_LIVE_BUCKET" UPLOAD_STORAGE_DRIVER=spaces
export DO_SPACES_PUBLIC_URL="${DO_SPACES_PUBLIC_URL:-https://$TEST_LIVE_BUCKET.$(echo "$DO_SPACES_ENDPOINT" | sed -E 's#^https?://##')}"
export BACKUP_SPACES_PREFIX="${BACKUP_SPACES_PREFIX:-dr-test/$(date -u +%Y%m%dT%H%M%SZ)/}" BACKUP_ENGINE=stream PG_BIN_PATH=$PGBIN
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass+1)); }; no() { echo "  ✗ $*"; fail=$((fail+1)); }
chk() { if eval "$2"; then ok "$1"; else no "$1"; fi; }
s3() { ( cd "$BACKEND" && node -e "$1" ); }
cleanup() {
  echo "== cleanup: test objects in $TEST_LIVE_BUCKET and s3://$BACKUP_SPACES_BUCKET/$BACKUP_SPACES_PREFIX"
  s3 "
const {S3Client,ListObjectsV2Command,DeleteObjectsCommand}=require('@aws-sdk/client-s3');
const ps=(v)=>v==='1'||v==='true';
const mk=(e,r,k,s,f)=>new S3Client({endpoint:e,region:r,forcePathStyle:ps(f),credentials:{accessKeyId:k,secretAccessKey:s},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
async function wipe(c,b,p){let t;do{const r=await c.send(new ListObjectsV2Command({Bucket:b,Prefix:p,ContinuationToken:t}));const o=(r.Contents||[]).map(x=>({Key:x.Key}));if(o.length)await c.send(new DeleteObjectsCommand({Bucket:b,Delete:{Objects:o,Quiet:true}}));t=r.IsTruncated?r.NextContinuationToken:undefined}while(t)}
(async()=>{await wipe(mk(process.env.DO_SPACES_ENDPOINT,process.env.DO_SPACES_REGION,process.env.DO_SPACES_ACCESS_KEY,process.env.DO_SPACES_SECRET_KEY,process.env.DO_SPACES_FORCE_PATH_STYLE),process.env.TEST_LIVE_BUCKET,undefined);
await wipe(mk(process.env.BACKUP_SPACES_ENDPOINT||process.env.DO_SPACES_ENDPOINT,process.env.BACKUP_SPACES_REGION||process.env.DO_SPACES_REGION,process.env.BACKUP_SPACES_ACCESS_KEY,process.env.BACKUP_SPACES_SECRET_KEY,process.env.BACKUP_SPACES_FORCE_PATH_STYLE),process.env.BACKUP_SPACES_BUCKET,process.env.BACKUP_SPACES_PREFIX)})().catch(e=>{console.error('cleanup:',e.message);process.exit(1)})" && echo "  cleaned"
  for p in $P1 $P2; do sudo -u postgres "$PGBIN/pg_ctl" -D "$W/pg$p" stop -m fast >/dev/null 2>&1; done; sudo rm -rf "$W"
}
trap cleanup EXIT

echo "== 0. the live test bucket must be empty (isolation)"
n="$(s3 "const {S3Client,ListObjectsV2Command}=require('@aws-sdk/client-s3');new S3Client({endpoint:process.env.DO_SPACES_ENDPOINT,region:process.env.DO_SPACES_REGION,forcePathStyle:['1','true'].includes(process.env.DO_SPACES_FORCE_PATH_STYLE),credentials:{accessKeyId:process.env.DO_SPACES_ACCESS_KEY,secretAccessKey:process.env.DO_SPACES_SECRET_KEY}}).send(new ListObjectsV2Command({Bucket:process.env.TEST_LIVE_BUCKET})).then(r=>console.log((r.Contents||[]).length))")"
[ "$n" = "0" ] || { trap - EXIT; echo "refusing: $TEST_LIVE_BUCKET is not empty ($n objects) — use a dedicated empty test bucket"; exit 2; }
ok "test bucket $TEST_LIVE_BUCKET is empty"

echo "== 1. throwaway database + test objects written by the real StorageService"
sudo chown postgres "$W"; echo pw | sudo -u postgres tee "$W/pw" >/dev/null
for p in $P1 $P2; do
  sudo -u postgres "$PGBIN/initdb" -D "$W/pg$p" -U postgres --auth-host=scram-sha-256 --auth-local=trust --pwfile="$W/pw" >/dev/null
  printf "port = %s\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '%s'\n" "$p" "$W" | sudo -u postgres tee -a "$W/pg$p/postgresql.conf" >/dev/null
  sudo -u postgres "$PGBIN/pg_ctl" -D "$W/pg$p" -l "$W/pg$p.log" start >/dev/null
done; sleep 2
PGPASSWORD=pw "$PGBIN/psql" -h 127.0.0.1 -p $P1 -U postgres -qc "CREATE ROLE t_app LOGIN PASSWORD 't'" -c "CREATE DATABASE tdb OWNER t_app" >/dev/null
PGPASSWORD=t "$PGBIN/psql" -h 127.0.0.1 -p $P1 -U t_app -d tdb -qc "CREATE TABLE documents (id text primary key, \"fileUrl\" text not null)" >/dev/null
export DATABASE_URL="postgresql://t_app:t@127.0.0.1:$P1/tdb?sslmode=disable"
( cd "$BACKEND" && npx ts-node --transpile-only -e "
const {StorageService}=require('./src/common/storage/storage.service');const {randomBytes}=require('crypto');
(async()=>{const s=new StorageService();s.onModuleInit();const out=[];
for(let i=0;i<20;i++){out.push(await s.uploadFile(randomBytes(20000+i),{keyPrefix:'dr-test/docs',originalName:'t.pdf',contentType:'application/pdf'}))}
out.push(await s.uploadFile(randomBytes(40<<20),{keyPrefix:'dr-test/big',originalName:'big.bin',contentType:'application/octet-stream'}));
require('fs').writeFileSync('$W/uploaded.json',JSON.stringify(out))})().catch(e=>{console.error(e.message);process.exit(1)})" ) >/dev/null 2>"$EV/upload.err"
chk "21 test objects uploaded to real Spaces via StorageService (incl. 40 MiB)" "[ \"\$(python3 -c 'import json;print(len(json.load(open(\"$W/uploaded.json\"))))' 2>/dev/null)\" = 21 ]"
python3 -c "
import json; u=json.load(open('$W/uploaded.json'))
print('\n'.join(\"INSERT INTO documents VALUES ('d%d','%s');\" % (i, x['url']) for i, x in enumerate(u)))" | PGPASSWORD=t "$PGBIN/psql" -h 127.0.0.1 -p $P1 -U t_app -d tdb -q >/dev/null

echo "== 2. probe + streaming backup to the real backup bucket (test prefix)"
bash "$DR/preflight.sh" --engine stream >"$EV/preflight.json" 2>"$EV/preflight.log"; chk "preflight (bucket access, separation, credentials) passes" "[ $? -eq 0 ]"
bash "$DR/snapshot.sh" backup --kind full --label spaces-real-test >"$W/b.json" 2>"$EV/backup.log"; rc=$?
PKG="$(python3 -c 'import json,sys;print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["package"])' "$W/b.json" 2>/dev/null)"
chk "backup COMPLETE on real Spaces (rc=$rc)" "[ $rc -eq 0 ]"
chk "every captured object carries app write-once version evidence" \
  "bash '$DR/snapshot.sh' cat '$PKG' uploads.manifest.json | python3 -c 'import json,sys;f=json.load(sys.stdin)[\"files\"];sys.exit(0 if len(f)==21 and all(x.get(\"versionEvidence\")==\"app-write-once-unique-key\" for x in f) else 1)'"
bash "$DR/snapshot.sh" verify "$PKG" --deep >"$EV/verify.json" 2>"$EV/verify.log"; chk "deep verify (dump re-read, every blob re-hashed) on real Spaces" "[ $? -eq 0 ]"

echo "== 3. restore into a second fresh cluster + local files; compare hashes"
mkdir -p "$W/mat" "$W/restored-files"
bash "$DR/snapshot.sh" materialize "$PKG" "$W/mat" >/dev/null 2>"$EV/materialize.log"
PGPASSWORD=pw "$PGBIN/psql" -h 127.0.0.1 -p $P2 -U postgres -qc "CREATE ROLE dbadmin LOGIN CREATEROLE CREATEDB PASSWORD 'a'" >/dev/null
UPLOAD_STORAGE_DRIVER=local bash "$DR/restore.sh" "$W/mat/$PKG" --target-url "postgresql://dbadmin:a@127.0.0.1:$P2/tdb?sslmode=disable" \
  --create-db --roles --uploads-dest "$W/restored-files" --yes >"$EV/restore.log" 2>&1; chk "restore into a fresh cluster as non-superuser: RESTORE OK" "grep -q 'RESTORE OK' '$EV/restore.log'"
chk "restored rows = 21" "[ \"\$(PGPASSWORD=pw $PGBIN/psql -h 127.0.0.1 -p $P2 -U postgres -d tdb -tAc 'select count(*) from documents')\" = 21 ]"
python3 - "$W/uploaded.json" "$W/mat/$PKG/uploads.manifest.json" "$W/restored-files" >"$EV/hash-compare.txt" 2>&1 <<'PY'
import hashlib, json, os, sys
up = {x['key'] for x in json.load(open(sys.argv[1]))}; man = {f['key']: f['sha256'] for f in json.load(open(sys.argv[2]))['files']}
bad = [k for k in up if k not in man or hashlib.sha256(open(os.path.join(sys.argv[3], k), 'rb').read()).hexdigest() != man[k]]
print(f"compared={len(up)} mismatched_or_missing={len(bad)}"); sys.exit(1 if bad or not up else 0)
PY
chk "every restored file matches its SHA-256 ($(cat "$EV/hash-compare.txt"))" "[ $? -eq 0 ]"

echo "result: $pass passed, $fail failed"
printf '{"passed":%d,"failed":%d,"environment":"REAL DigitalOcean Spaces (test bucket + test prefix), local PostgreSQL 18"}\n' $pass $fail >"$EV/spaces-real-test.json"
[ $fail -eq 0 ]
