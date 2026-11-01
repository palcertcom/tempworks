#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-production-image.sh — build the UNMODIFIED production image exactly as
# App Platform does (context backend/, backend/Dockerfile, its pinned base, no
# build args, no secrets), then verify it and run the full disaster-recovery
# drill with recovery performed FROM that image. Writes evidence to ./verify-evidence.
#
# Run from the repository root on any Linux x86_64 host with Docker, sudo and
# normal (non-intercepted) internet access — e.g. an Ubuntu 22.04/24.04
# machine you already have. TLS verification is never disabled.
#
#   bash backend/scripts/ci/verify-production-image.sh --install-prereqs   # Ubuntu: apt PG 18, node 22, psmisc
#   bash backend/scripts/ci/verify-production-image.sh                     # prerequisites already present
#
# Steps: 1 build  2 identity (commit, Dockerfile sha256, base digest, image id)
#        3 image checks (image-checks.sh, incl. real public TLS endpoints)
#        4 full two-instance DR drill, recovery from the image (~10 min)
# Uses only local resources: throwaway PostgreSQL clusters + an S3 simulator.
# Exit 0 only if every step passes.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
EV="$PWD/verify-evidence"; rm -rf "$EV"; mkdir -p "$EV"
IMG=tempworks-backend:verify
# --use-image <image>: TEST-ONLY — skip the build and verify an existing image
# (used to validate this script where the exact build is impossible). Evidence
# then states that the image was NOT built by this script.
USE_IMAGE=""; [ "${1:-}" = "--use-image" ] && { USE_IMAGE="$2"; IMG="$2"; shift 2; }

if [ "${1:-}" = "--install-prereqs" ]; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg postgresql-common psmisc python3 openssl >/dev/null
  sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  sudo apt-get install -y -qq postgresql-18 >/dev/null
  sudo systemctl stop postgresql 2>/dev/null || true
  if ! node --version 2>/dev/null | grep -q '^v22\.'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
    sudo apt-get install -y -qq nodejs >/dev/null
  fi
fi
for t in docker node npm python3 openssl curl fuser /usr/lib/postgresql/18/bin/initdb; do
  command -v "$t" >/dev/null 2>&1 || [ -x "$t" ] || { echo "missing prerequisite: $t (use --install-prereqs on Ubuntu)"; exit 2; }
done

echo "== 1. build (exact Dockerfile, pinned base, no build args)"
if [ -n "$USE_IMAGE" ]; then
  echo "TEST-ONLY: build skipped, verifying existing image $USE_IMAGE (NOT the exact production build)" | tee "$EV/build.log"
else
  set -o pipefail
  docker build --pull --progress=plain -f backend/Dockerfile -t "$IMG" backend 2>&1 | tee "$EV/build.log" | grep -E '^#[0-9]+ \[|ERROR' || { echo "BUILD FAILED (see $EV/build.log)"; exit 1; }
fi
docker image inspect "$IMG" >/dev/null

echo "== 2. identity"
BASE="$(grep -m1 '^ARG NODE_IMAGE=' backend/Dockerfile | cut -d= -f2-)"
{
  echo "commit=$(git rev-parse HEAD)"
  echo "dockerfile_sha256=$(sha256sum backend/Dockerfile | cut -d' ' -f1)"
  echo "base_image=$BASE"
  echo "image_id=$(docker image inspect -f '{{.Id}}' "$IMG")"
  echo "image_user=$(docker image inspect -f '{{.Config.User}}' "$IMG")"
  echo "image_size_bytes=$(docker image inspect -f '{{.Size}}' "$IMG")"
  echo "built_at=$(date -u +%FT%TZ)"
  echo "exact_production_build=$([ -n "$USE_IMAGE" ] && echo no || echo yes)"
} | tee "$EV/image-identity.txt"

echo "== 3. image checks"
CHECK_EXTERNAL="${CHECK_EXTERNAL:-1}" bash backend/scripts/ci/image-checks.sh "$IMG" "$EV/image-checks"

echo "== 4. full DR drill, recovery from the image"
npm ci --no-audit --no-fund >/dev/null
( cd backend && npm ci --no-audit --no-fund >/dev/null && npx prisma generate >/dev/null )   # npm ci removes the generated client
PWB="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw}"
if [ "${SKIP_PLAYWRIGHT_SETUP:-0}" != 1 ]; then   # set to 1 where Playwright + Chromium are already installed
  ( cd backend && npm install --no-save --no-audit --no-fund playwright@1.49.1 >/dev/null )
  sudo mkdir -p "$PWB" && sudo chown "$(id -u)" "$PWB"
  ( cd backend && PLAYWRIGHT_BROWSERS_PATH="$PWB" npx playwright install --with-deps chromium >/dev/null )
fi
( cd backend && sudo -E env "PATH=$PATH" PLAYWRIGHT_BROWSERS_PATH="$PWB" DRILL_DIR=/tmp/tw-drill-verify \
    DRILL_RECOVER_IMAGE="$IMG" bash scripts/dr/drill/two-instance.sh all ) 2>&1 | tee "$EV/drill.log"
sudo cp -r /tmp/tw-drill-verify/evidence "$EV/drill"; sudo chown -R "$(id -u)" "$EV"
python3 -c "import json;d=json.load(open('$EV/drill/recovery-verification.json'));print('recovery verification:',d['passed'],'passed,',d['failed'],'failed');raise SystemExit(1 if d['failed'] else 0)"
( cd backend && sudo bash scripts/dr/drill/two-instance.sh down >/dev/null 2>&1 || true )
echo "ALL STEPS PASSED — evidence in $EV (no credentials are written there)"
