# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# recover-image.sh — drill phases sourced by two-instance.sh.
#
# phase_source_managed   managed-provider shape on the SOURCE: CONNECT on
#                        postgres/template1 revoked from PUBLIC, so the app
#                        role's `pg_dumpall --globals-only` is REFUSED and
#                        backups must capture required roles from the catalog.
# phase_recover_image    recovery using ONLY the production container image
#                        ($DRILL_RECOVER_IMAGE) + the backup bucket + the secret
#                        store: the snapshot is deep-verified and materialized,
#                        restore.sh runs from the image into a FRESH PostgreSQL
#                        cluster as a NON-superuser admin role (CREATEROLE
#                        CREATEDB, like a managed provider's admin) and an EMPTY
#                        bucket; the recovered backend then runs from the image.
# ─────────────────────────────────────────────────────────────────────────────

phase_source_managed() {
  load_secrets
  log "source-managed: REVOKE CONNECT on postgres/template1 FROM PUBLIC (pg_dumpall refused for the app role)"
  psqlp "$SRC_PG" postgres "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC" >/dev/null
  psqlp "$SRC_PG" postgres "REVOKE CONNECT ON DATABASE template1 FROM PUBLIC" >/dev/null
  if PGPASSWORD="$APP_DB_PASSWORD" "$PGBIN/pg_dumpall" -h 127.0.0.1 -p "$SRC_PG" -U tempworks_app --globals-only --no-role-passwords >/dev/null 2>&1; then
    die "pg_dumpall still works for the app role"
  fi
  echo "pg_dumpall --globals-only as tempworks_app: refused ✓"
}

img_run() { docker run --rm --network host "$@"; }

phase_recover_image() {
  load_secrets; offsite_env
  local IMG="$DRILL_RECOVER_IMAGE"
  log "recover (image mode): rebuild using ONLY the production image + off-site copies + secret store"
  local T0 t n; T0=$(now)
  local IN="$DRILL/recovery/incoming"; mkdir -p "$IN"; chown 1000:1000 "$IN"
  local pkg; pkg="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["package"])' "$EV/ui-backup.json")"
  local sha; sha="$(cat "$DRILL/release.sha")"
  docker image inspect -f '{"image":"{{.Id}}","created":"{{.Created}}","user":"{{.Config.User}}"}' "$IMG" >"$EV/recovery-image.json"
  echo "image: $IMG $(cat "$EV/recovery-image.json")"
  local BENV=( -e BACKUP_SPACES_ENDPOINT -e BACKUP_SPACES_REGION -e BACKUP_SPACES_BUCKET -e BACKUP_SPACES_ACCESS_KEY
               -e BACKUP_SPACES_SECRET_KEY -e BACKUP_SPACES_FORCE_PATH_STYLE -e BACKUP_SPACES_PREFIX )

  log "1/6 deep-verify + materialize the snapshot from the backup bucket (toolkit inside the image)"
  t=$(now)
  img_run "${BENV[@]}" "$IMG" bash scripts/dr/snapshot.sh verify "$pkg" --deep \
    >"$EV/recover-snapshot-verify.json" 2>"$EV/recover-snapshot-verify.log" || die "snapshot verification failed (see recover-snapshot-verify.log)"
  img_run "${BENV[@]}" -v "$IN:/srv/restore" "$IMG" bash scripts/dr/snapshot.sh materialize "$pkg" /srv/restore \
    >"$EV/recover-materialize.json" 2>"$EV/recover-materialize.log" || die "materialize failed"
  record_time recover_fetch_offsite "$(dur "$t" "$(now)")"

  log "2/6 FRESH PostgreSQL 18 cluster + provider-like admin role (NOT superuser)"
  t=$(now)
  start_cluster "$DRILL/recovery/pg" "$REC_PG"
  psqlp "$REC_PG" postgres "CREATE ROLE dbadmin LOGIN CREATEROLE CREATEDB PASSWORD '$PG_SUPERUSER_PASSWORD'" >/dev/null
  printf '{"sourceRolesOnFreshCluster":%s,"restoringRole":"dbadmin","restoringRoleSuperuser":%s}\n' \
    "$(psqlp "$REC_PG" postgres "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'tempworks%'")" \
    "$(psqlp "$REC_PG" postgres "SELECT rolsuper FROM pg_roles WHERE rolname='dbadmin'" | sed 's/t/true/;s/f/false/')" >"$EV/recovery-target.json"
  echo "fresh cluster: $(cat "$EV/recovery-target.json")"
  record_time recover_provision_db "$(dur "$t" "$(now)")"

  log "3/6 the recovery bucket rec-uploads must be EMPTY"
  n="$(cd "$REPO/backend" && node -e "
const {S3Client,ListObjectsV2Command}=require('@aws-sdk/client-s3');
new S3Client({endpoint:'http://127.0.0.1:$S3_PORT',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'$S3_ACCESS_KEY',secretAccessKey:'$S3_SECRET_KEY'}})
  .send(new ListObjectsV2Command({Bucket:'rec-uploads'})).then(r=>console.log((r.Contents||[]).length))")"
  [ "$n" = "0" ] || die "recovery bucket is not empty ($n objects)"
  echo '{"recoveryBucketObjectsBeforeRestore":0}' >"$EV/recovery-bucket.json"; echo "rec-uploads: 0 objects ✓"

  log "4/6 restore database + required roles + files with restore.sh FROM THE IMAGE, as dbadmin"
  t=$(now)
  local TGT="postgresql://dbadmin:$PG_SUPERUSER_PASSWORD@127.0.0.1:$REC_PG/tempworks?sslmode=disable"
  if img_run -v "$IN:/srv/restore" "$IMG" bash scripts/dr/restore.sh "/srv/restore/$pkg" \
       --target-url "${TGT/tempworks\?/guard_check?}" --create-db --roles --yes >"$EV/recover-guard.log" 2>&1; then
    die "restore without a storage target was NOT refused"
  fi
  grep -q "Refusing to guess" "$EV/recover-guard.log" && echo "✓ restore refuses to guess the storage target (no silent local fallback)"
  img_run -v "$IN:/srv/restore" -e UPLOAD_STORAGE_DRIVER=spaces -e DO_SPACES_ENDPOINT="http://127.0.0.1:$S3_PORT" \
    -e DO_SPACES_REGION=us-east-1 -e DO_SPACES_BUCKET=rec-uploads -e DO_SPACES_ACCESS_KEY="$S3_ACCESS_KEY" \
    -e DO_SPACES_SECRET_KEY="$S3_SECRET_KEY" -e DO_SPACES_FORCE_PATH_STYLE=1 -e DO_SPACES_PUBLIC_URL="http://127.0.0.1:$S3_PORT/rec-uploads" \
    "$IMG" bash scripts/dr/restore.sh "/srv/restore/$pkg" --target-url "$TGT" --create-db --roles --yes \
    --source-location "s3://dr-offsite/dr/snapshots/$pkg/" >"$EV/recover-restore.log" 2>&1 \
    || { tail -40 "$EV/recover-restore.log"; die "restore failed"; }
  grep -E "✓|RESTORE OK|remap|catalog|LOGIN roles|ALTER ROLE" "$EV/recover-restore.log" | sed 's/^.*\[dr\] //' | tail -16
  record_time recover_restore "$(dur "$t" "$(now)")"

  log "5/6 credentials from the secret store (passwords are never in backups), set by dbadmin"
  PGPASSWORD="$PG_SUPERUSER_PASSWORD" "$PGBIN/psql" -h 127.0.0.1 -p "$REC_PG" -U dbadmin -d postgres -qc \
    "ALTER ROLE tempworks_app WITH LOGIN PASSWORD '$APP_DB_PASSWORD'"

  log "6/6 start the recovered backend FROM THE IMAGE; web front from the off-site release artifact"
  t=$(now)
  write_backend_env "$DRILL/recovery/backend.env" "$REC_PG" "$REC_API" rec-uploads "$DRILL/recovery/backups" "$REC_WEB"
  docker rm -f tw-recovered >/dev/null 2>&1 || true
  docker run -d --name tw-recovered --network host --env-file "$DRILL/recovery/backend.env" \
    -e TMPDIR=/tmp -e BACKUP_DIR=/app/backups "$IMG" >/dev/null
  wait_http "http://127.0.0.1:$REC_API/api/docs" "recovered backend (image)" 180
  docker logs tw-recovered >"$DRILL/recovery/backend.log" 2>&1
  ( cd "$REPO/backend" && BACKUP_SPACES_PREFIX=artifacts/ node scripts/dr/spaces-sync.mjs offsite-get "tempworks-release-$sha.tar.gz" "$IN/release.tar.gz" ) >/dev/null 2>&1 \
    || die "release artifact not retrievable from the off-site bucket"
  rm -rf "$DRILL/recovery/app"; mkdir -p "$DRILL/recovery/app"
  tar -xzf "$IN/release.tar.gz" -C "$DRILL/recovery/app" --strip-components=1 tempworks-release/frontend-dist tempworks-release/RELEASE.json
  start_web "$REC_WEB" "$DRILL/recovery/app/frontend-dist" "$REC_API" "$DRILL/recovery/web.log"
  record_time recover_start_services "$(dur "$t" "$(now)")"
  sed 's/\x1b\[[0-9;]*m//g' "$DRILL/recovery/backend.log" | grep -aE "entrypoint|No pending|drift-heal|Storage driver|successfully started|Emails will NOT" | tail -7
  record_time recover_total_rto "$(dur "$T0" "$(now)")"
  echo "RECOVERY (image) up: web http://127.0.0.1:$REC_WEB  api http://127.0.0.1:$REC_API/api/v1"
}

phase_verify_any() {
  [ -n "${DRILL_RECOVER_IMAGE:-}" ] && { docker logs tw-recovered >"$DRILL/recovery/backend.log" 2>&1 || true; }
  phase_verify
}
