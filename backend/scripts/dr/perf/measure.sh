#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# measure.sh — run a command and record its PEAK local disk and PEAK memory.
#
#   disk   : max of `du -sb` over the watched directories (temp + output dirs)
#   memory : max of the summed RSS of every process in the command's process
#            group (bash, pg_dump, node, python, tar, … — the whole tree)
#
# Usage: measure.sh <label> <out.json> <watchdir>[,<watchdir>…] -- <command…>
# Samples every 0.2 s. Prints and writes JSON.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
LABEL="$1"; OUT="$2"; WATCH="$3"; shift 3; [ "$1" = "--" ] && shift
IFS=',' read -ra DIRS <<<"$WATCH"
for d in "${DIRS[@]}"; do mkdir -p "$d"; done

T0=$(date +%s.%N)
setsid "$@" >"$OUT.stdout" 2>"$OUT.stderr" &
LEADER=$!
PEAK_DISK=0; PEAK_RSS=0
while kill -0 "$LEADER" 2>/dev/null; do
  disk=0
  for d in "${DIRS[@]}"; do s=$(du -sb "$d" 2>/dev/null | awk '{print $1}'); disk=$((disk + ${s:-0})); done
  [ "$disk" -gt "$PEAK_DISK" ] && PEAK_DISK=$disk
  rss=$(ps -eo pgid=,rss= | awk -v g="$LEADER" '$1==g {s+=$2} END {print s*1024+0}')
  [ "${rss:-0}" -gt "$PEAK_RSS" ] && PEAK_RSS=$rss
  sleep 0.2
done
wait "$LEADER"; RC=$?
DUR=$(python3 -c "print(round($(date +%s.%N)-$T0,1))")
python3 - "$LABEL" "$OUT" "$PEAK_DISK" "$PEAK_RSS" "$DUR" "$RC" <<'PY'
import json, sys
label, out, disk, rss, dur, rc = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5]), int(sys.argv[6])
r = {"label": label, "exitCode": rc, "durationS": dur,
     "peakDiskBytes": disk, "peakDiskMiB": round(disk / 2**20, 1),
     "peakRssBytes": rss, "peakRssMiB": round(rss / 2**20, 1)}
json.dump(r, open(out, "w"), indent=2)
print(json.dumps(r))
PY
exit "$RC"
