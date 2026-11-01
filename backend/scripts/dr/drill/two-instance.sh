#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# two-instance.sh — DR drill in the PRODUCTION SHAPE: two app instances
# (App Platform instance_count=2) behind one database, one upload bucket and a
# SEPARATE backup bucket, using the bucket-native streaming engine.
#
#   instance A  backend :3101 · web :8101   own BACKUP_DIR + TMPDIR
#   instance B  backend :3102               own BACKUP_DIR + TMPDIR
#   shared      PostgreSQL :57432 · src-uploads · dr-offsite (backup bucket)
#
# Object storage is the LOCAL S3 SIMULATOR (s3rver) — NOT DigitalOcean Spaces.
#
# Phases (in order for `all`):
#   init s3-up release source-up source-managed second-up source-data ui-backup
#   concurrency core schedule termination disaster recover verify
# Source is managed-provider shaped (pg_dumpall refused for the app role).
# DRILL_RECOVER_IMAGE=<image>: recovery runs from the production image only
# (see recover-image.sh).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
export DRILL_DIR="${DRILL_DIR:-/tmp/tw-drill2}" DRILL_ENGINE=stream
TI_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drill.sh
. "$TI_HERE/drill.sh"
# shellcheck source=recover-image.sh
. "$TI_HERE/recover-image.sh"
SRC_API_B=3102

env_b() { # instance B: same everything, own port + local dirs
  sed -e "s#^PORT=.*#PORT=$SRC_API_B#" \
      -e "s#^BACKUP_DIR=.*#BACKUP_DIR=$DRILL/source/backups-b#" \
      -e "s#^TMPDIR=.*#TMPDIR=$DRILL/source/backups-b.tmp#" "$DRILL/source/backend.env" >"$DRILL/source/backend-b.env"
  chmod 600 "$DRILL/source/backend-b.env"
}
restart_a() { start_backend "$REPO/backend" "$DRILL/source/backend.env" "$SRC_API" "$DRILL/source/backend.log"; }
restart_b() { env_b; start_backend "$REPO/backend" "$DRILL/source/backend-b.env" "$SRC_API_B" "$DRILL/source/backend-b.log"; }
set_env() { # $1 file  $2 KEY  $3 value|"" (delete)
  sed -i "/^$2=/d" "$1"; [ -n "${3:-}" ] && printf '%s=%s\n' "$2" "$3" >>"$1"; return 0
}

phase_second_up() {
  load_secrets
  log "second-up: instance B on :$SRC_API_B (same DB, buckets and secrets; its own local disk)"
  restart_b
  echo "instances: A http://127.0.0.1:$SRC_API  B http://127.0.0.1:$SRC_API_B"
}

phase_core() {
  load_secrets
  log "core: create on A → list/verify/download on B → wipe both local disks → still recoverable"
  ( cd "$REPO/backend" && node "$TI_HERE/two-instance.mjs" core "http://127.0.0.1:$SRC_API/api/v1" "http://127.0.0.1:$SRC_API_B/api/v1" "$EV" "$DRILL" )
}

phase_schedule() {
  load_secrets
  log "schedule: BOTH instances run the same cron — each occurrence must run exactly once"
  for f in backend.env backend-b.env; do
    set_env "$DRILL/source/$f" BACKUP_SCHEDULE_CRON '"* * * * *"'
    set_env "$DRILL/source/$f" BACKUP_SCHEDULE_KIND DATABASE
  done
  restart_a; start_backend "$REPO/backend" "$DRILL/source/backend-b.env" "$SRC_API_B" "$DRILL/source/backend-b.log"
  local since; since="$(date -u +%FT%TZ)"
  echo "waiting for 3 scheduled occurrences (≈3–4 min)…"
  sleep 200
  # Stop between occurrences: wait until mid-minute and until no scheduled run
  # is still in flight, so the restart below cannot interrupt one.
  while [ "$(date +%S | sed 's/^0//')" -lt 30 ] || [ "$(date +%S | sed 's/^0//')" -gt 40 ]; do sleep 1; done
  for _ in $(seq 1 20); do [ "$(psqlp "$SRC_PG" tempworks "SELECT count(*) FROM system_backups WHERE status='RUNNING'")" = 0 ] && break; sleep 1; done
  sed 's/\x1b\[[0-9;]*m//g' "$DRILL/source/backend.log" >"$EV/schedule-instance-A.log"
  sed 's/\x1b\[[0-9;]*m//g' "$DRILL/source/backend-b.log" >"$EV/schedule-instance-B.log"
  for f in backend.env backend-b.env; do set_env "$DRILL/source/$f" BACKUP_SCHEDULE_CRON ""; done
  restart_a; start_backend "$REPO/backend" "$DRILL/source/backend-b.env" "$SRC_API_B" "$DRILL/source/backend-b.log"
  python3 - "$EV/two-instance-schedule.json" "$since" \
    "$(psqlp "$SRC_PG" tempworks "SELECT json_agg(json_build_object('occurrence',occurrence,'instance',instance) ORDER BY occurrence) FROM backup_schedule_claims WHERE occurrence LIKE 'backup:%' AND \"claimedAt\" >= '$since'")" \
    "$(psqlp "$SRC_PG" tempworks "SELECT count(*) FROM system_backups WHERE notes = '[SCHEDULED]' AND \"createdAt\" >= '$since'")" \
    "$(psqlp "$SRC_PG" tempworks "SELECT count(*) FROM system_backups WHERE notes = '[SCHEDULED]' AND \"createdAt\" >= '$since' AND status = 'COMPLETED'")" \
    "$(grep -c 'already claimed by another instance' "$EV/schedule-instance-A.log" || true)" \
    "$(grep -c 'already claimed by another instance' "$EV/schedule-instance-B.log" || true)" <<'PY'
import json, sys
out, since, claims, runs, done, standA, standB = sys.argv[1], sys.argv[2], json.loads(sys.argv[3] or "[]") or [], int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
occ = [c["occurrence"] for c in claims]
checks = [
  ("at least 3 occurrences fired", len(occ) >= 3),
  ("every occurrence claimed exactly once (unique)", len(occ) == len(set(occ))),
  ("one backup row per claimed occurrence (no duplicates)", runs == len(occ)),
  ("all scheduled runs COMPLETED", done == runs),
  ("the non-owning instance stood down (logged) for each occurrence", standA + standB >= len(occ)),
]
for n, ok in checks: print(f"  {'✓' if ok else '✗'} {n}")
json.dump({"since": since, "claims": claims, "scheduledRows": runs, "completed": done,
           "standDownLogLines": {"A": standA, "B": standB}, "checks": [{"name": n, "ok": ok} for n, ok in checks]},
          open(out, "w"), indent=2)
sys.exit(0 if all(ok for _, ok in checks) else 1)
PY
}

phase_termination() {
  load_secrets
  log "termination: instance A stopped mid-backup (SIGTERM = redeploy; SIGKILL of the whole container)"
  local sig="$DRILL/a.paused" id pid
  for mode in term kill; do
    set_env "$DRILL/source/backend.env" DR_TEST_PAUSE_AFTER_DUMP_SECS 40
    set_env "$DRILL/source/backend.env" DR_TEST_SIGNAL_FILE "$sig"
    restart_a
    id="$( cd "$REPO/backend" && node "$TI_HERE/two-instance.mjs" start-paused "http://127.0.0.1:$SRC_API/api/v1" "$EV" "$sig" )"
    pid="$(fuser "$SRC_API/tcp" 2>/dev/null | tr -s ' ' | sed 's/^ //' | cut -d' ' -f1)"
    if [ "$mode" = term ]; then
      echo "backup $id paused on A (pid $pid) → SIGTERM"
      kill -TERM "$pid"
      for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill -0 "$pid" 2>/dev/null && echo "A still running after 30 s" || echo "A exited after SIGTERM"
    else
      echo "backup $id paused on A (pid $pid) → SIGKILL to A's whole process group (container kill)"
      kill -KILL -- "-$pid"
    fi
    sed 's/\x1b\[[0-9;]*m//g' "$DRILL/source/backend.log" | grep -aE "shutting down|interrupting|SIGTERM|aborting" | tail -3 || true
    ( cd "$REPO/backend" && node "$TI_HERE/two-instance.mjs" after-kill "http://127.0.0.1:$SRC_API_B/api/v1" "$EV" "$id" "$mode" "$DRILL" )
  done
  set_env "$DRILL/source/backend.env" DR_TEST_PAUSE_AFTER_DUMP_SECS ""
  set_env "$DRILL/source/backend.env" DR_TEST_SIGNAL_FILE ""
  restart_a
}

phase_disaster_both() {
  kill_port "$SRC_API_B"
  phase_disaster   # stops A + web + DB, moves the whole source host (both instances' dirs) away, deletes the live bucket
}

recover_any() { if [ -n "${DRILL_RECOVER_IMAGE:-}" ]; then phase_recover_image; else phase_recover; fi; }

case "${1:-}" in
  init) phase_init ;; s3-up) phase_s3_up ;; release) phase_release ;; source-up) phase_source_up ;;
  source-managed) phase_source_managed ;;
  second-up) phase_second_up ;; source-data) phase_source_data ;; ui-backup) phase_ui_backup ;;
  concurrency) phase_concurrency ;; core) phase_core ;; schedule) phase_schedule ;; termination) phase_termination ;;
  disaster) phase_disaster_both ;; recover) recover_any ;; verify) phase_verify_any ;;
  down) docker rm -f tw-recovered >/dev/null 2>&1 || true; kill_port "$SRC_API_B"; phase_down ;;
  all) phase_init; phase_s3_up; phase_release; phase_source_up; phase_source_managed; phase_second_up; phase_source_data; phase_ui_backup
       phase_concurrency; phase_core; phase_schedule; phase_termination; phase_disaster_both; recover_any; phase_verify_any ;;
  *) die "usage: two-instance.sh init|s3-up|release|source-up|source-managed|second-up|source-data|ui-backup|concurrency|core|schedule|termination|disaster|recover|verify|down|all" ;;
esac
