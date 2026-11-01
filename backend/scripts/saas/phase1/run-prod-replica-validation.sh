#!/usr/bin/env bash
# Orchestrates the read-only validation suite, redirecting outputs into the
# phase1-prod-replica/ tree. Designed to be run against a sanitized prod
# replica OR — when one isn't available — the staging fixture as a proxy.
#
# Usage:
#   DATABASE_URL=... bash backend/scripts/saas/phase1/run-prod-replica-validation.sh
#
# This script is bash; on Windows use the equivalent commands or run inside
# WSL.  All it does is invoke the existing npm scripts and copy the
# generated JSON+MD files into phase1-prod-replica/{,reconciliation/,backfill-dry-run/}.

set -e

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SRC="$ROOT/backend/reports/saas/phase1"
DST="$ROOT/backend/reports/saas/phase1-prod-replica"
mkdir -p "$DST/reconciliation" "$DST/backfill-dry-run" "$DST/staging-apply"

cd "$ROOT/backend"

echo "----- env-safety -----"
npm run --silent saas:env-safety || true

echo "----- preflight -----"
npm run --silent saas:phase1-preflight || true
cp "$SRC"/PHASE1_PREFLIGHT_SUMMARY.{json,md}  "$DST"/ 2>/dev/null || true
cp "$SRC"/0[1-7]*.{json,md}                   "$DST"/ 2>/dev/null || true

echo "----- reconciliation A..E (dry-run) -----"
for s in A-user-identity B-agency-tenant-projection C-unique-constraints D-data-ownership E-reports-sql; do
  npx ts-node "scripts/saas/phase1/reconciliation/${s}.recon.ts" || true
  for ext in json md; do
    [ -f "$SRC/recon-${s}.${ext}" ] && cp "$SRC/recon-${s}.${ext}" "$DST/reconciliation/" || true
  done
done

echo "----- dry-run tenant backfill -----"
npm run --silent saas:phase1-backfill-dry-run -- --max-quarantine 50 || true
cp "$SRC"/PHASE1_DRY_RUN_BACKFILL.{json,md}   "$DST/backfill-dry-run/" 2>/dev/null || true

echo "----- seq snapshot (dry-run) -----"
npm run --silent saas:phase1-seq-snapshot || true
cp "$SRC"/recon-seq-snapshot.{json,md}        "$DST/" 2>/dev/null || true

echo "----- verify (pre-backfill or post-backfill) -----"
npm run --silent saas:phase1-verify-backfill || true
cp "$SRC"/recon-verify-backfill.{json,md}     "$DST/" 2>/dev/null || true

echo "Done. See $DST/"
