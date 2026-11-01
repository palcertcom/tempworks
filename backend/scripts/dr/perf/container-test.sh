#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# container-test.sh — exercise the production image the way App Platform runs
# it (apps-s-1vcpu-1gb: 1 GiB memory, 1 vCPU; PORT injected; NODE_ENV set by
# the App Spec) against the perf-env.sh dataset (PostgreSQL 18 + S3 SIMULATOR).
#
#   1. non-baselined, non-empty DB  → `prisma migrate deploy` fails → the
#      container exits non-zero and the server never starts (same semantics
#      as the current run command)
#   2. baselined DB (all migrations recorded) → "No pending migrations" → app
#      listens on $PORT=8080
#   3. NODE_ENV=production vs development: startup log diff
#   4. full streaming snapshot INSIDE the running container: peak cgroup RSS,
#      peak temp disk, OOM events
#   5. the old staging engine inside the same 1 GiB container (for contrast)
#   6. docker stop (SIGTERM, 30 s grace): exit status + time
#
# Usage: container-test.sh <image> <evidence-dir>
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
IMG="${1:-tempworks-backend:candidate}"; EV="${2:-/tmp/container-test}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$EV"
eval "$("$HERE/perf-env.sh" env)"
PGBIN=/usr/lib/postgresql/18/bin
# Reach PostgreSQL through a host name that matches no staging/production
# pattern, like a managed-database host name (env-safety classification).
DBURL="${DATABASE_URL/127.0.0.1/pg-managed.internal}"
log() { printf '\n== %s\n' "$*"; }
common=(--network host --add-host pg-managed.internal:127.0.0.1 --memory 1g --memory-swap 1g --cpus 1
  -e DATABASE_URL="$DBURL" -e PORT=8080 -e JWT_SECRET=container-test-only -e JWT_REFRESH_SECRET=container-test-only-2
  -e UPLOAD_STORAGE_DRIVER=spaces -e DO_SPACES_ENDPOINT -e DO_SPACES_REGION -e DO_SPACES_BUCKET -e DO_SPACES_ACCESS_KEY
  -e DO_SPACES_SECRET_KEY -e DO_SPACES_PUBLIC_URL -e DO_SPACES_FORCE_PATH_STYLE
  -e BACKUP_SPACES_ENDPOINT -e BACKUP_SPACES_REGION -e BACKUP_SPACES_BUCKET -e BACKUP_SPACES_ACCESS_KEY
  -e BACKUP_SPACES_SECRET_KEY -e BACKUP_SPACES_FORCE_PATH_STYLE -e BACKUP_SPACES_PREFIX)
cg() { echo "/sys/fs/cgroup/memory/docker/$(docker inspect -f '{{.Id}}' "$1")"; }
wait_port() { for _ in $(seq 1 90); do curl -s -o /dev/null "http://127.0.0.1:$1/api/docs" && return 0; sleep 1; done; return 1; }

# Throwaway perf DB: start from "schema present, no migration history".
PGPASSWORD=perf_pw $PGBIN/psql -h 127.0.0.1 -p "${PERF_PG:-58500}" -U perf_app -d perf -qc 'DROP TABLE IF EXISTS _prisma_migrations'
log "1. non-baselined DB: migrate deploy must fail and the server must not start"
docker rm -f tw-ct >/dev/null 2>&1
docker run --name tw-ct "${common[@]}" -e NODE_ENV=development "$IMG" >"$EV/1-unbaselined.log" 2>&1; rc=$?
grep -E "P3005|Error|entrypoint" "$EV/1-unbaselined.log" | head -4
echo "container exit status: $rc ; server started: $(grep -c 'API running' "$EV/1-unbaselined.log")"
docker rm -f tw-ct >/dev/null

log "2. baseline the DB (record every migration as applied — as on production)"
for m in $(ls -d "$HERE/../../../prisma/migrations"/*/ | xargs -n1 basename); do
  docker run --rm "${common[@]}" --entrypoint npx "$IMG" --no-install prisma migrate resolve --applied "$m" >>"$EV/2-baseline.log" 2>&1
done
echo "recorded: $(PGPASSWORD=perf_pw $PGBIN/psql -h 127.0.0.1 -p "${PERF_PG:-58500}" -U perf_app -d perf -tAc 'SELECT count(*) FROM _prisma_migrations')"

for mode in development production; do
  log "3. start with NODE_ENV=$mode (1 GiB, 1 vCPU, PORT=8080)"
  docker rm -f tw-ct >/dev/null 2>&1
  docker run -d --name tw-ct "${common[@]}" -e NODE_ENV=$mode "$IMG" >/dev/null
  if wait_port 8080; then echo "listening on 8080: yes"; else echo "listening on 8080: NO"; fi
  sleep 3
  docker logs tw-ct 2>&1 | sed 's/\x1b\[[0-9;]*m//g' >"$EV/3-start-$mode.log"
  grep -E "entrypoint|No pending|API running|refusing|classification|ERROR" "$EV/3-start-$mode.log" | sed -E 's/^\[Nest\] [0-9]+  - [^ ]+ [^ ]+ [AP]M +//' | head -8
  docker exec tw-ct node -e "const e=require('/app/dist/src/saas/tenancy/env-safety.js');const c=e.classifyRuntimeEnv();console.log('env-safety: NODE_ENV='+c.nodeEnv+' classification='+c.classification+' stagingFeatures='+e.isStagingClassification(c.classification))" | tee "$EV/3-classification-$mode.txt"
  [ "$mode" = production ] || docker rm -f tw-ct >/dev/null
done
diff <(sed -E 's/^\[Nest\] [0-9]+  - [^ ]+ [^ ]+ [AP]M +//; s/\+[0-9]+ms$//' "$EV/3-start-development.log" | grep -vE "Mapped|RoutesResolver|InstanceLoader" | sort -u) \
     <(sed -E 's/^\[Nest\] [0-9]+  - [^ ]+ [^ ]+ [AP]M +//; s/\+[0-9]+ms$//' "$EV/3-start-production.log" | grep -vE "Mapped|RoutesResolver|InstanceLoader" | sort -u) >"$EV/3-nodeenv-diff.txt"
echo "startup log differences development→production: $(grep -c '^[<>]' "$EV/3-nodeenv-diff.txt") line(s) (see 3-nodeenv-diff.txt)"

measure_in() { # $1 label  $2.. command inside the container
  local label="$1"; shift
  local C; C="$(cg tw-ct)"
  echo 0 >"$C/memory.max_usage_in_bytes" 2>/dev/null || true
  local oom0; oom0="$(grep -E '^oom_kill ' "$C/memory.oom_control" | awk '{print $2}')"
  docker exec tw-ct "$@" >"$EV/$label.stdout" 2>"$EV/$label.stderr" &
  local pid=$! peak_rss=0 peak_disk=0 r d
  while kill -0 $pid 2>/dev/null; do
    r=$(awk '$1=="total_rss"{print $2}' "$C/memory.stat"); [ "${r:-0}" -gt "$peak_rss" ] && peak_rss=$r
    d=$(docker exec tw-ct sh -c 'du -sb /tmp /app/backups 2>/dev/null | awk "{s+=\$1} END {print s+0}"' 2>/dev/null); [ "${d:-0}" -gt "$peak_disk" ] && peak_disk=$d
    sleep 0.3
  done
  wait $pid; local rc=$?
  local oom1; oom1="$(grep -E '^oom_kill ' "$C/memory.oom_control" | awk '{print $2}')"
  python3 - "$EV/$label.json" "$label" "$rc" "$peak_rss" "$(cat "$C/memory.max_usage_in_bytes")" "$peak_disk" "$(( ${oom1:-0} - ${oom0:-0} ))" <<'PY'
import json, sys
o, label, rc, rss, maxu, disk, oom = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
r = {"label": label, "exitCode": rc, "containerPeakRssMiB": round(rss / 2**20, 1), "containerPeakUsageInclCacheMiB": round(maxu / 2**20, 1),
     "peakTempDiskMiB": round(disk / 2**20, 1), "oomKills": oom, "limits": "memory 1 GiB (no swap), 1 vCPU"}
json.dump(r, open(o, "w"), indent=2); print(json.dumps(r))
PY
}

log "4. full streaming snapshot inside the running app container"
measure_in 4-stream-full bash scripts/dr/snapshot.sh backup --kind full --label container-test
tail -3 "$EV/4-stream-full.stderr"
echo "app still serving after the backup: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/docs)"

log "5. staging engine (backup.sh) inside the same container, for contrast"
measure_in 5-staging-full bash scripts/dr/backup.sh --kind full --offsite
tail -2 "$EV/5-staging-full.stderr"
echo "app still serving: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/docs) ; container OOMKilled flag: $(docker inspect -f '{{.State.OOMKilled}}' tw-ct)"

log "6. docker stop (SIGTERM, 30 s grace)"
t0=$(date +%s.%N); docker stop -t 30 tw-ct >/dev/null; t1=$(date +%s.%N)
echo "exit status: $(docker inspect -f '{{.State.ExitCode}}' tw-ct) after $(python3 -c "print(round($t1-$t0,1))") s"
docker logs tw-ct 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -3
docker rm -f tw-ct >/dev/null
