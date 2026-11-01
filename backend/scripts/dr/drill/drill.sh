#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# drill.sh — complete LOCAL application disaster-recovery drill for TempWorks.
#
# Builds two fully separate local stacks and proves the application (not just
# the database) can be recovered from an independently retained backup:
#
#   SOURCE   PostgreSQL :57432 · backend :3101 · web :8101 · bucket src-uploads
#   RECOVERY PostgreSQL :57433 · backend :3201 · web :8201 · bucket rec-uploads
#   OFF-SITE bucket dr-offsite  (backup packages + release artifact)
#   SECRET STORE  $DRILL/secret-store  (credentials kept OUT of the backup)
#
# Object storage is a LOCAL S3-COMPATIBLE SIMULATION (s3rver on :5555). It
# exercises the real AWS SDK code paths but is NOT DigitalOcean Spaces.
# Nothing here touches production: all endpoints are 127.0.0.1, email has no
# API key, and no webhook/SMS integrations exist.
#
# DRILL_ENGINE=staging (default here) | stream — which backup engine the app
# uses (BACKUP_ENGINE). two-instance.sh sources this file and runs the stream
# engine on two app instances.
#
# Usage: drill.sh <phase>|all
#   phases: init s3-up release source-up source-data ui-backup concurrency schedule
#           disaster recover verify down
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
DRILL="${DRILL_DIR:-/tmp/tw-drill}"
PGBIN="${PG_BIN_PATH:-/usr/lib/postgresql/18/bin}"
S3_PORT=5555
SRC_PG=57432 SRC_API=3101 SRC_WEB=8101
REC_PG=57433 REC_API=3201 REC_WEB=8201
EV="$DRILL/evidence"
SS="$DRILL/secret-store/secrets.env"

log()  { printf '\n\033[1;36m[drill %s]\033[0m %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die()  { printf '\033[1;31m[drill ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
now()  { date +%s.%N; }
dur()  { python3 -c "print(round($2-$1,2))"; }
record_time() { printf '%s\t%s\n' "$1" "$2" >>"$EV/timings.tsv"; }
psqlp() { PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$PGBIN/psql" -h 127.0.0.1 -p "$1" -U postgres -d "$2" -tAX -c "$3"; }
wait_http() { for _ in $(seq 1 "${3:-90}"); do curl -s -o /dev/null "$1" && return 0; sleep 1; done; die "timeout waiting for $1 ($2)"; }
kill_port() { fuser -k -TERM "$1/tcp" >/dev/null 2>&1 || true; for _ in $(seq 1 20); do fuser "$1/tcp" >/dev/null 2>&1 || return 0; sleep 0.25; done; fuser -k -KILL "$1/tcp" >/dev/null 2>&1 || true; }
# Fully detached launcher: setsid -f forks into a new session and returns
# immediately, so this script never waits on long-running services.
launch() { # $1 workdir  $2 logfile  $3.. command
  local wd="$1" lg="$2"; shift 2
  setsid -f bash -c 'cd "$1" && shift && exec "$@"' _ "$wd" "$@" >"$lg" 2>&1 </dev/null
}
load_secrets() { set -a; . "$SS"; set +a; }
s3env() { # $1 bucket  -> exports app-bucket vars for the S3 simulator
  export UPLOAD_STORAGE_DRIVER=spaces DO_SPACES_ENDPOINT="http://127.0.0.1:$S3_PORT" DO_SPACES_REGION=us-east-1 DO_SPACES_BUCKET="$1"
  export DO_SPACES_ACCESS_KEY="$S3_ACCESS_KEY" DO_SPACES_SECRET_KEY="$S3_SECRET_KEY" DO_SPACES_FORCE_PATH_STYLE=1
  export DO_SPACES_PUBLIC_URL="http://127.0.0.1:$S3_PORT/$1"
}
offsite_env() {
  export BACKUP_SPACES_ENDPOINT="http://127.0.0.1:$S3_PORT" BACKUP_SPACES_REGION=us-east-1 BACKUP_SPACES_BUCKET=dr-offsite
  export BACKUP_SPACES_ACCESS_KEY="$S3_ACCESS_KEY" BACKUP_SPACES_SECRET_KEY="$S3_SECRET_KEY"
  export BACKUP_SPACES_FORCE_PATH_STYLE=1 BACKUP_SPACES_PREFIX=dr/
}
start_cluster() { # $1 dir $2 port
  local pw; pw="$(mktemp)"; printf '%s\n' "$PG_SUPERUSER_PASSWORD" >"$pw"; chown postgres "$pw"; chmod 600 "$pw"
  sudo -u postgres "$PGBIN/initdb" -D "$1" -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8 \
       --pwfile="$pw" >"$1.initdb.log" 2>&1 || { rm -f "$pw"; die "initdb failed: $(tail -3 "$1.initdb.log")"; }
  rm -f "$pw"
  { echo "port = $2"; echo "unix_socket_directories = '$DRILL/run'"; echo "listen_addresses = '127.0.0.1'"; } >>"$1/postgresql.conf"
  sudo -u postgres "$PGBIN/pg_ctl" -D "$1" -l "$1.log" -o "-p $2" start >/dev/null
  for _ in $(seq 1 30); do PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$PGBIN/pg_isready" -h 127.0.0.1 -p "$2" -q && return 0; sleep 0.5; done
  die "postgres on :$2 did not start"
}
stop_cluster() { [ -f "$1/postmaster.pid" ] && sudo -u postgres "$PGBIN/pg_ctl" -D "$1" stop -m fast >/dev/null 2>&1 || true; }

# ── phases ────────────────────────────────────────────────────────────────────

phase_init() {
  log "init: workspace $DRILL + secret store (credentials live OUTSIDE every backup)"
  mkdir -p "$DRILL"/{secret-store,run,source,recovery,evidence/screenshots,tools}
  chown postgres:postgres "$DRILL" "$DRILL/run" "$DRILL/source" "$DRILL/recovery"
  chmod 700 "$DRILL/secret-store"
  if [ ! -f "$SS" ]; then
    rnd() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }
    cat >"$SS" <<EOF
# Drill secret store (stand-in for a real secret manager). NEVER inside a backup.
PG_SUPERUSER_PASSWORD=$(rnd)
APP_DB_PASSWORD=$(rnd)
JWT_SECRET=$(rnd)$(rnd)
JWT_REFRESH_SECRET=$(rnd)$(rnd)
S3_ACCESS_KEY=S3RVER   # s3rver simulator accepts only its built-in key
S3_SECRET_KEY=S3RVER
ADMIN_EMAIL=admin@tempworks.com
ADMIN_PASSWORD=Drill-Admin-$(rnd | head -c 8)!
TENANT_USER_PASSWORD=Drill-User-$(rnd | head -c 8)!
EOF
    chmod 600 "$SS"
  fi
  : >"$EV/timings.tsv"
  if [ ! -d "$DRILL/tools/node_modules/s3rver" ]; then
    ( cd "$DRILL/tools" && npm init -y >/dev/null && npm install --no-audit --no-fund s3rver@3.7.1 >/dev/null 2>&1 )
  fi
  echo "secret store: $SS (mode 600) — values are never printed"
}

phase_s3_up() {
  load_secrets
  log "s3-up: LOCAL S3-compatible simulator (s3rver) on :$S3_PORT — NOT DigitalOcean Spaces"
  kill_port "$S3_PORT"; sleep 0.5
  mkdir -p "$DRILL/s3data"
  cat >"$DRILL/tools/s3sim.cjs" <<'JS'
const S3rver = require('s3rver');
new S3rver({ port: Number(process.env.S3_PORT), address: '127.0.0.1', silent: true,
  directory: process.env.S3_DIR, configureBuckets: [{ name: 'src-uploads' }, { name: 'rec-uploads' }, { name: 'dr-offsite' }] })
  .run().then(() => console.log('s3 simulator up')).catch((e) => { console.error(e); process.exit(1); });
JS
  export S3_PORT S3_DIR="$DRILL/s3data"; launch "$DRILL/tools" "$DRILL/s3sim.log" node s3sim.cjs
  wait_http "http://127.0.0.1:$S3_PORT/" "s3 simulator" 30
  echo "buckets: src-uploads (source), rec-uploads (recovery), dr-offsite (independently retained copies)"
}

phase_release() {
  load_secrets; offsite_env
  log "release: build the deployable artifact and retain it OFF-SITE (independent of the source server)"
  local t0; t0=$(now)
  ( cd "$REPO/backend" && npx nest build >/dev/null )
  ( cd "$REPO" && VITE_API_URL=/api/v1 npx vite build >"$DRILL/vite-build.log" 2>&1 ) || die "frontend build failed (see $DRILL/vite-build.log)"
  local sha; sha="$(git -C "$REPO" rev-parse HEAD)"
  local stage="$DRILL/release-stage/tempworks-release"; rm -rf "$DRILL/release-stage"; mkdir -p "$stage"
  git -C "$REPO" archive HEAD | tar -x -C "$stage"                 # committed source at this SHA
  cp -r "$REPO/backend/dist" "$stage/backend/dist"                  # built backend
  cp -r "$REPO/dist" "$stage/frontend-dist"                         # built SPA
  printf '{"gitSha":"%s","builtAt":"%s","dirty":%s}\n' "$sha" "$(date -u +%FT%TZ)" \
    "$( [ -z "$(git -C "$REPO" status --porcelain -- backend/src src backend/scripts backend/prisma)" ] && echo false || echo true)" >"$stage/RELEASE.json"
  ( cd "$DRILL/release-stage" && tar -czf "$DRILL/tempworks-release-$sha.tar.gz" tempworks-release )
  ( cd "$DRILL" && sha256sum "tempworks-release-$sha.tar.gz" >"tempworks-release-$sha.tar.gz.sha256" )
  ( cd "$REPO/backend" && BACKUP_SPACES_PREFIX=artifacts/ node scripts/dr/spaces-sync.mjs offsite-put "$DRILL/tempworks-release-$sha.tar.gz" >/dev/null )
  ( cd "$REPO/backend" && BACKUP_SPACES_PREFIX=artifacts/ node scripts/dr/spaces-sync.mjs offsite-verify "$DRILL/tempworks-release-$sha.tar.gz" >"$EV/release-offsite-verify.json" )
  echo "$sha" >"$DRILL/release.sha"
  record_time release_build "$(dur "$t0" "$(now)")"
  echo "release artifact: tempworks-release-$sha.tar.gz → s3://dr-offsite/artifacts/ (verified: $(python3 -c 'import json;print(json.load(open("'"$EV"'/release-offsite-verify.json"))["verified"])'))"
}

write_backend_env() { # $1 file  $2 pg_port  $3 api_port  $4 bucket  $5 backup_dir  $6 web_port
  load_secrets
  cat >"$1" <<EOF
DATABASE_URL=postgresql://tempworks_app:$APP_DB_PASSWORD@127.0.0.1:$2/tempworks?sslmode=disable
PORT=$3
NODE_ENV=production
JWT_SECRET=$JWT_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
JWT_ACCESS_EXPIRES_IN=8h
JWT_REFRESH_EXPIRES_IN=7d
FRONTEND_URL=http://127.0.0.1:$6
UPLOAD_STORAGE_DRIVER=spaces
DO_SPACES_ENDPOINT=http://127.0.0.1:$S3_PORT
DO_SPACES_REGION=us-east-1
DO_SPACES_BUCKET=$4
DO_SPACES_ACCESS_KEY=$S3_ACCESS_KEY
DO_SPACES_SECRET_KEY=$S3_SECRET_KEY
DO_SPACES_PUBLIC_URL=http://127.0.0.1:$S3_PORT/$4
DO_SPACES_FORCE_PATH_STYLE=1
BACKUP_DIR=$5
BACKUP_ENGINE=${DRILL_ENGINE:-staging}
# The drill recovers from the UI-made backup; keep enough history that the
# many test backups taken afterwards never rotate it out.
BACKUP_RETENTION_COUNT=50
TMPDIR=$5.tmp
BACKUP_SPACES_ENDPOINT=http://127.0.0.1:$S3_PORT
BACKUP_SPACES_REGION=us-east-1
BACKUP_SPACES_BUCKET=dr-offsite
BACKUP_SPACES_ACCESS_KEY=$S3_ACCESS_KEY
BACKUP_SPACES_SECRET_KEY=$S3_SECRET_KEY
BACKUP_SPACES_FORCE_PATH_STYLE=1
BACKUP_SPACES_PREFIX=dr/
# External side effects DISABLED for the drill: no email API key, no SMTP.
RESEND_API_KEY=
SMTP_FROM=
EOF
  chmod 600 "$1"
}

start_backend() { # $1 app_backend_dir $2 env_file $3 api_port $4 log
  kill_port "$3"
  ( set -a; . "$2"; set +a; mkdir -p "$TMPDIR"; launch "$1" "$4" node dist/src/main.js )
  wait_http "http://127.0.0.1:$3/api/docs" "backend :$3" 120
}
start_web() { # $1 port $2 dist $3 api_port $4 log
  kill_port "$1"
  launch "$HERE" "$4" node webproxy.mjs "$1" "$2" "http://127.0.0.1:$3"
  wait_http "http://127.0.0.1:$1/" "web :$1" 30
}

phase_source_up() {
  load_secrets
  log "source-up: SOURCE stack — PostgreSQL 18 :$SRC_PG, app role is a NON-superuser DB owner (like a managed DB)"
  stop_cluster "$DRILL/source/pg"; rm -rf "$DRILL/source/pg"
  start_cluster "$DRILL/source/pg" "$SRC_PG"
  PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$PGBIN/psql" -h 127.0.0.1 -p "$SRC_PG" -U postgres -qc \
    "CREATE ROLE tempworks_app LOGIN PASSWORD '$APP_DB_PASSWORD' NOSUPERUSER" -c "CREATE DATABASE tempworks OWNER tempworks_app"
  PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$PGBIN/psql" -h 127.0.0.1 -p "$SRC_PG" -U postgres -qc \
    "CREATE ROLE tempworks_readonly NOLOGIN"
  export DATABASE_URL="postgresql://tempworks_app:$APP_DB_PASSWORD@127.0.0.1:$SRC_PG/tempworks?sslmode=disable"

  log "schema: prisma db push (schema.prisma) → db:migrate:all (hand-written SQL migrations)"
  ( cd "$REPO/backend" && npx prisma db push --accept-data-loss >"$EV/source-dbpush.log" 2>&1 ) || { tail -20 "$EV/source-dbpush.log"; die "prisma db push failed"; }
  ( cd "$REPO/backend" && npx ts-node --transpile-only prisma/run-all-migrations.ts >"$EV/source-sql-migrations.log" 2>&1 ) \
    && echo "SQL migrations: all applied" || echo "SQL migrations: some failed — see evidence/source-sql-migrations.log (historical scripts; recorded, not hidden)"
  grep -E "Succeeded|Failed:" "$EV/source-sql-migrations.log" || true

  # Production runs `prisma migrate deploy` on every deploy, so its database
  # carries the migration history; the source must too (a recovered database
  # without it is refused by migrate deploy with P3005 — tested separately).
  log "baseline: record every Prisma migration as applied (production shape)"
  for m in $(ls -d "$REPO/backend/prisma/migrations"/*/ | xargs -n1 basename); do
    ( cd "$REPO/backend" && npx prisma migrate resolve --applied "$m" >>"$EV/source-baseline.log" 2>&1 ) || die "baseline of $m failed"
  done
  echo "migration history: $(psqlp "$SRC_PG" tempworks "SELECT count(*) FROM _prisma_migrations") migration(s) recorded"

  log "seed: real seed (roles, permissions, owner tenant/agency, platform admin)"
  ( cd "$REPO/backend" && SEED_ADMIN_EMAIL="$ADMIN_EMAIL" SEED_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
      npx tsx prisma/seed.ts >"$EV/source-seed.log" 2>&1 ) || { tail -20 "$EV/source-seed.log"; die "seed failed"; }
  tail -3 "$EV/source-seed.log"

  # Out-of-Prisma permission model to prove ACL/RLS survive recovery.
  PGPASSWORD="$APP_DB_PASSWORD" "$PGBIN/psql" -h 127.0.0.1 -p "$SRC_PG" -U tempworks_app -d tempworks -qc \
    "GRANT USAGE ON SCHEMA public TO tempworks_readonly; GRANT SELECT ON ALL TABLES IN SCHEMA public TO tempworks_readonly;"

  write_backend_env "$DRILL/source/backend.env" "$SRC_PG" "$SRC_API" src-uploads "$DRILL/source/backups" "$SRC_WEB"
  start_backend "$REPO/backend" "$DRILL/source/backend.env" "$SRC_API" "$DRILL/source/backend.log"
  start_web "$SRC_WEB" "$REPO/dist" "$SRC_API" "$DRILL/source/web.log"
  grep -aE "drift-heal|Storage driver|successfully started" "$DRILL/source/backend.log" | sed 's/\x1b\[[0-9;]*m//g' | tail -3
  echo "SOURCE up: web http://127.0.0.1:$SRC_WEB  api http://127.0.0.1:$SRC_API/api/v1"
}

phase_source_data() {
  load_secrets
  log "source-data: create multi-tenant data THROUGH THE APPLICATION API"
  ( cd "$REPO/backend" && node "$HERE/seed-api.mjs" "http://127.0.0.1:$SRC_API/api/v1" "$EV/source-data.json" )
}

phase_ui_backup() {
  load_secrets
  log "ui-backup: trigger a FULL SYSTEM backup from the admin UI (frontend → API → background job → DR tooling)"
  local t0; t0=$(now)
  ( cd "$REPO/backend" && node "$HERE/ui-backup.mjs" "http://127.0.0.1:$SRC_WEB" "$EV" )
  record_time ui_backup_end_to_end "$(dur "$t0" "$(now)")"
  # Snapshot the source schema for parity checks after recovery.
  PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$PGBIN/pg_dump" -h 127.0.0.1 -p "$SRC_PG" -U postgres -d tempworks \
    --schema-only --no-comments >"$DRILL/source-schema.sql"
}

phase_concurrency() {
  load_secrets
  log "concurrency: app-driven uploads / photo replacements (purge old object) / deletions DURING backups"
  ( cd "$REPO/backend" && node "$HERE/concurrency.mjs" "http://127.0.0.1:$SRC_API/api/v1" "$EV" "$DRILL" )
}

phase_schedule() {
  load_secrets
  log "schedule: scheduled FULL backups (cron + TZ), overlap safety, status/staleness reporting"
  sed -i '/^BACKUP_SCHEDULE_/d;/^BACKUP_STALE_HOURS/d' "$DRILL/source/backend.env"
  # Every minute ONLY for the drill; a production schedule is the operator's
  # decision (see runbook) and is NOT configured by this repository.
  printf '%s\n' 'BACKUP_SCHEDULE_CRON="* * * * *"' 'BACKUP_SCHEDULE_TZ=Europe/Bratislava' \
    'BACKUP_SCHEDULE_KIND=FULL_SYSTEM' 'BACKUP_STALE_HOURS=26' >>"$DRILL/source/backend.env"
  start_backend "$REPO/backend" "$DRILL/source/backend.env" "$SRC_API" "$DRILL/source/backend.log"
  grep -aE "Scheduled .* backups|DISABLED" "$DRILL/source/backend.log" | sed 's/\x1b\[[0-9;]*m//g' | tail -1
  ( cd "$REPO/backend" && node "$HERE/schedule-test.mjs" "http://127.0.0.1:$SRC_API/api/v1" "$EV" "$SRC_PG" )
}

phase_disaster() {
  load_secrets
  log "disaster: STOP the source app and DESTROY its server-local state + storage"
  kill_port "$SRC_WEB"; kill_port "$SRC_API"
  stop_cluster "$DRILL/source/pg"
  mv "$DRILL/source" "$DRILL/source.LOST"               # whole source host: DB files, config, local backups
  mv "$DRILL/s3data/src-uploads" "$DRILL/src-uploads.LOST"  # source object storage gone
  curl -s -o /dev/null -m 3 "http://127.0.0.1:$SRC_API/api/docs" && die "source API still reachable" || echo "source API unreachable ✓"
  PGPASSWORD=x "$PGBIN/pg_isready" -h 127.0.0.1 -p "$SRC_PG" -q && die "source DB still up" || echo "source DB unreachable ✓"
  curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$S3_PORT/src-uploads/" | grep -q 404 && echo "source bucket gone ✓" || echo "source bucket status: $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$S3_PORT/src-uploads/")"
}

phase_recover() {
  load_secrets; offsite_env
  log "recover: rebuild TempWorks on a CLEAN stack using only off-site copies + secret store + prerequisites"
  local T0; T0=$(now)
  local IN="$DRILL/recovery/incoming"; mkdir -p "$IN"
  local sha; sha="$(cat "$DRILL/release.sha")"
  local pkg; pkg="$(python3 -c 'import json;print(json.load(open("'"$EV"'/ui-backup.json"))["package"])')"

  log "1/7 fetch release artifact + backup package from OFF-SITE storage"
  local t; t=$(now)
  ( cd "$REPO/backend" && BACKUP_SPACES_PREFIX=artifacts/ node scripts/dr/spaces-sync.mjs offsite-get "tempworks-release-$sha.tar.gz" "$IN/tempworks-release-$sha.tar.gz" )
  ( cd "$REPO/backend" && BACKUP_SPACES_PREFIX=artifacts/ node scripts/dr/spaces-sync.mjs offsite-get "tempworks-release-$sha.tar.gz.sha256" "$IN/tempworks-release-$sha.tar.gz.sha256" )
  local PKGIN SRCLOC
  if [ "$(python3 -c 'import json;print(json.load(open("'"$EV"'/ui-backup.json")).get("engine","staging"))')" = "stream" ]; then
    # Bucket-native snapshot: rebuild the package directory from the backup
    # bucket (content-addressed blobs + snapshot files) on this recovery host.
    ( cd "$REPO/backend" && bash scripts/dr/snapshot.sh verify "$pkg" --deep >"$EV/recover-snapshot-verify.json" )
    ( cd "$REPO/backend" && bash scripts/dr/snapshot.sh materialize "$pkg" "$IN" >"$EV/recover-materialize.json" )
    PKGIN="$IN/$pkg"; SRCLOC="s3://dr-offsite/dr/snapshots/$pkg/"
    ( cd "$IN" && sha256sum -c "tempworks-release-$sha.tar.gz.sha256" )
  else
    ( cd "$REPO/backend" && node scripts/dr/spaces-sync.mjs offsite-get "$pkg.tar.gz" "$IN/$pkg.tar.gz" )
    ( cd "$REPO/backend" && node scripts/dr/spaces-sync.mjs offsite-get "$pkg.tar.gz.sha256" "$IN/$pkg.tar.gz.sha256" )
    ( cd "$IN" && sha256sum -c "tempworks-release-$sha.tar.gz.sha256" && sha256sum -c "$pkg.tar.gz.sha256" )
    PKGIN="$IN/$pkg.tar.gz"; SRCLOC="s3://dr-offsite/dr/$pkg.tar.gz"
  fi
  record_time recover_fetch_offsite "$(dur "$t" "$(now)")"

  log "2/7 unpack the release into a SEPARATE app directory (not the source working tree)"
  t=$(now)
  rm -rf "$DRILL/recovery/app"; mkdir -p "$DRILL/recovery/app"
  tar -xzf "$IN/tempworks-release-$sha.tar.gz" -C "$DRILL/recovery/app" --strip-components=1
  ( cd "$DRILL/recovery/app/backend" && npm ci --no-audit --no-fund >"$DRILL/recovery/npm-ci.log" 2>&1 && npx prisma generate >/dev/null 2>&1 )
  record_time recover_install_release "$(dur "$t" "$(now)")"
  local APPB="$DRILL/recovery/app/backend"

  log "3/7 fresh PostgreSQL 18 instance (no roles, no data)"
  t=$(now)
  start_cluster "$DRILL/recovery/pg" "$REC_PG"
  echo "roles named tempworks* on fresh cluster: $(PGPASSWORD="$PG_SUPERUSER_PASSWORD" psqlp "$REC_PG" postgres "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'tempworks%'")"
  record_time recover_provision_db "$(dur "$t" "$(now)")"

  log "4/7 restore database + roles + uploaded files (empty bucket rec-uploads) with the ARTIFACT's toolkit"
  # Negative check: without an explicit storage target the restore must refuse
  # (it must never silently move object-storage files onto local disk).
  if ( unset UPLOAD_STORAGE_DRIVER; PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$APPB/scripts/dr/restore.sh" "$PKGIN" \
         --target-url "postgresql://postgres:$PG_SUPERUSER_PASSWORD@127.0.0.1:$REC_PG/guard_check?sslmode=disable" \
         --create-db --roles --yes >"$EV/recover-guard.log" 2>&1 ); then
    die "restore without a storage target was NOT refused"
  fi
  grep -q "Refusing to guess" "$EV/recover-guard.log" && echo "✓ restore refuses to guess the storage target (no silent local fallback)"
  psqlp "$REC_PG" postgres "DROP DATABASE IF EXISTS guard_check" >/dev/null
  t=$(now)
  s3env rec-uploads
  PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$APPB/scripts/dr/restore.sh" "$PKGIN" \
    --target-url "postgresql://postgres:$PG_SUPERUSER_PASSWORD@127.0.0.1:$REC_PG/tempworks?sslmode=disable" \
    --create-db --roles --yes --source-location "$SRCLOC" \
    >"$EV/recover-restore.log" 2>&1 || { tail -40 "$EV/recover-restore.log"; die "restore failed"; }
  grep -E "✓|RESTORE OK|remap|skipped provider|catalog" "$EV/recover-restore.log" | sed 's/^.*\[dr\] //' | tail -14
  record_time recover_restore "$(dur "$t" "$(now)")"

  log "5/7 recover credentials from the secret store (role passwords are never in backups)"
  PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$PGBIN/psql" -h 127.0.0.1 -p "$REC_PG" -U postgres -qc \
    "ALTER ROLE tempworks_app WITH LOGIN PASSWORD '$APP_DB_PASSWORD'"

  log "6/7 recovery configuration (own ports, own bucket, side effects disabled) + start services"
  t=$(now)
  write_backend_env "$DRILL/recovery/backend.env" "$REC_PG" "$REC_API" rec-uploads "$DRILL/recovery/backups" "$REC_WEB"
  start_backend "$APPB" "$DRILL/recovery/backend.env" "$REC_API" "$DRILL/recovery/backend.log"
  start_web "$REC_WEB" "$DRILL/recovery/app/frontend-dist" "$REC_API" "$DRILL/recovery/web.log"
  record_time recover_start_services "$(dur "$t" "$(now)")"
  grep -aE "drift-heal|Storage driver|Reconciled|successfully started|Emails will NOT" "$DRILL/recovery/backend.log" | sed 's/\x1b\[[0-9;]*m//g' | tail -5

  log "7/7 recovery complete"
  record_time recover_total_rto "$(dur "$T0" "$(now)")"
  echo "RECOVERY up: web http://127.0.0.1:$REC_WEB  api http://127.0.0.1:$REC_API/api/v1"
}

phase_verify() {
  load_secrets
  log "verify: end-to-end checks against the RECOVERED application (UI + API + DB + storage)"
  local vrc=0
  ( cd "$REPO/backend" && node "$HERE/verify-recovery.mjs" "$DRILL" ) || vrc=$?
  log "schema parity: source schema (captured pre-disaster) vs recovered schema"
  PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$PGBIN/pg_dump" -h 127.0.0.1 -p "$REC_PG" -U postgres -d tempworks \
    --schema-only --no-comments >"$DRILL/recovered-schema.sql"
  # The recovered app's own boot-time drift-heal is idempotent; any difference is a real gap.
  if diff <(grep -vE '^--|^$|^\\(un)?restrict ' "$DRILL/source-schema.sql") <(grep -vE '^--|^$|^\\(un)?restrict ' "$DRILL/recovered-schema.sql") >"$EV/schema-diff.txt"; then
    echo "✓ schema parity: recovered schema-only dump is IDENTICAL to the source (incl. non-Prisma SQL objects)"
    echo '{"schemaParity":true}' >"$EV/schema-parity.json"
  else
    echo "✗ schema differs — see $EV/schema-diff.txt"; head -40 "$EV/schema-diff.txt"
    echo '{"schemaParity":false}' >"$EV/schema-parity.json"; vrc=1
  fi
  [ "$vrc" -eq 0 ] || die "recovery verification FAILED (see $EV/recovery-verification.json)"
  log "RECOVERY DRILL PASSED"
}

phase_down() {
  log "down: stop all drill services"
  for p in $SRC_WEB $SRC_API $REC_WEB $REC_API $S3_PORT; do kill_port "$p"; done
  stop_cluster "$DRILL/source/pg"; stop_cluster "$DRILL/recovery/pg"; stop_cluster "$DRILL/source.LOST/pg"
}

# Executed (not sourced): run the requested phase.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
case "${1:-}" in
  init) phase_init ;; s3-up) phase_s3_up ;; release) phase_release ;;
  source-up) phase_source_up ;; source-data) phase_source_data ;; ui-backup) phase_ui_backup ;;
  concurrency) phase_concurrency ;; schedule) phase_schedule ;; disaster) phase_disaster ;; recover) phase_recover ;;
  verify) phase_verify ;; down) phase_down ;;
  all) phase_init; phase_s3_up; phase_release; phase_source_up; phase_source_data; phase_ui_backup
       phase_concurrency; phase_schedule; phase_disaster; phase_recover; phase_verify ;;
  *) die "usage: drill.sh init|s3-up|release|source-up|source-data|ui-backup|concurrency|schedule|disaster|recover|verify|down|all" ;;
esac
fi
