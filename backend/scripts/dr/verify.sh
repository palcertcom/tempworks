#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify.sh — integrity-verify a DR package WITHOUT restoring it.
#
# Confirms: all component checksums match CHECKSUMS.sha256, the database dump
# is a readable pg custom-format archive (pg_restore --list), the manifest's
# recorded component hashes match, and (FULL kind) every captured upload hashes
# to its uploads.manifest.json entry.
#
# This is integrity verification only — it is NOT proof of a successful restore.
# A real restore test is a separate state (see restore.sh / dr-selftest.sh).
#
# Usage: verify.sh <package-dir | package.tar.gz>
# Exit 0 = package integrity verified.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

[ $# -ge 1 ] || die "Usage: verify.sh <package-dir | package.tar.gz>"
TARGET="$1"
CLEANUP=""

# Accept a tarball by extracting to a temp dir.
if [ -f "$TARGET" ] && echo "$TARGET" | grep -qE '\.tar\.gz$'; then
  TMP="$(mktemp -d)"; CLEANUP="$TMP"
  log "extracting $TARGET …"
  tar -xzf "$TARGET" -C "$TMP"
  PKG="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -n1)"
else
  PKG="$TARGET"
fi
[ -d "$PKG" ] || die "Not a package directory: $PKG"
[ -f "$PKG/MANIFEST.json" ] || die "MANIFEST.json missing — not a DR package: $PKG"
# Preserve the script's real exit status across cleanup (rm of any temp extract
# dir must not overwrite a non-zero status from a failed verification).
cleanup() { local rc=$?; [ -n "$CLEANUP" ] && rm -rf "$CLEANUP"; rm -rf "$DR_TMP"; exit $rc; }
trap cleanup EXIT

FAIL=0

# 1. Checksums -------------------------------------------------------------------
log "verifying checksums…"
if [ -f "$PKG/CHECKSUMS.sha256" ]; then
  if ( cd "$PKG" && sha256sum -c --quiet CHECKSUMS.sha256 ) 2>$DR_TMP/dr_cksum_err; then
    log "✓ all component checksums match"
  else
    err "✗ checksum mismatch:"; cat $DR_TMP/dr_cksum_err >&2; FAIL=1
  fi
else
  err "✗ CHECKSUMS.sha256 missing"; FAIL=1
fi

# 2. Database dump readable ------------------------------------------------------
DUMP="$PKG/database/database.dump"
if [ -f "$DUMP" ]; then
  select_pg_tools "" 2>/dev/null || true
  PGRESTORE="${PGRESTORE:-pg_restore}"
  if "$PGRESTORE" --list "$DUMP" >$DR_TMP/dr_toc.txt 2>$DR_TMP/dr_list_err; then
    ENTRIES="$(grep -cvE '^(;|$)' $DR_TMP/dr_toc.txt || true)"
    HAS_TABLE="$(grep -c ' TABLE ' $DR_TMP/dr_toc.txt || true)"
    log "✓ dump is a readable custom-format archive ($ENTRIES TOC entries, $HAS_TABLE table defs)"
  else
    err "✗ pg_restore --list failed: $(tail -n1 $DR_TMP/dr_list_err)"; FAIL=1
  fi
else
  err "✗ database dump missing: $DUMP"; FAIL=1
fi

# 3. Manifest component hashes ---------------------------------------------------
log "verifying manifest component hashes…"
python3 - "$PKG" <<'PY' || FAIL=1
import hashlib, json, os, sys
pkg = sys.argv[1]
m = json.load(open(os.path.join(pkg, "MANIFEST.json")))
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as fh:
        for c in iter(lambda: fh.read(1<<20), b''): h.update(c)
    return h.hexdigest()
ok = True
for name in ("globals", "database"):
    comp = m["components"].get(name, {})
    f = comp.get("file"); want = comp.get("sha256")
    if not f or not want: continue
    p = os.path.join(pkg, f)
    if not os.path.exists(p):
        print(f"  ✗ {name}: file missing {f}"); ok = False; continue
    got = sha(p)
    if got != want:
        print(f"  ✗ {name}: sha mismatch want={want[:12]} got={got[:12]}"); ok = False
    else:
        print(f"  ✓ {name}: {f} sha ok")
sys.exit(0 if ok else 1)
PY

# 4. Uploads hashes (FULL kind) — object-storage mirror + legacy local files -----
for pair in "uploads.manifest.json:uploads" "uploads-legacy-local.manifest.json:uploads-legacy-local"; do
  MAN="${pair%%:*}"; DIR="${pair##*:}"
  [ -f "$PKG/$MAN" ] || continue
  log "verifying file checksums ($DIR)…"
  python3 - "$PKG" "$MAN" "$DIR" <<'PY' || FAIL=1
import hashlib, json, os, sys
pkg, manf, sub = sys.argv[1:4]
man = json.load(open(os.path.join(pkg, manf)))
root = os.path.join(pkg, sub)
bad = 0; miss = 0; n = 0
for f in man.get("files", []):
    n += 1
    p = os.path.join(root, f["key"])
    if not os.path.exists(p): miss += 1; continue
    h = hashlib.sha256()
    with open(p, 'rb') as fh:
        for c in iter(lambda: fh.read(1<<20), b''): h.update(c)
    if h.hexdigest() != f["sha256"]: bad += 1
print(f"  {sub}: files={n} ok={n-bad-miss} mismatch={bad} missing={miss}")
sys.exit(0 if (bad==0 and miss==0) else 1)
PY
done

# 5. Completeness: a FULL package whose DB references files that were not
#    captured (marked complete=false at backup time) is never "verified".
# Integrity (steps 1-4: are the bytes intact?) and recovery completeness (does
# the package contain everything a recovery needs?) are separate verdicts.
RECOV="$(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m.get("recoverability") or ("COMPLETE" if m.get("complete", True) else "INCOMPLETE"))' "$PKG/MANIFEST.json")"
ISSUES="$(python3 -c '
import json,sys
m=json.load(open(sys.argv[1]))
print("; ".join(f"{i[\"severity\"]} {i[\"code\"]} ({i.get(\"count\",\"?\")}): {i.get(\"detail\",\"\")}" for i in m.get("recoveryIssues",[]) if i.get("severity")!="INFO"))' "$PKG/MANIFEST.json" 2>/dev/null || true)"
INTEGRITY_FAIL=$FAIL
[ "$FAIL" -eq 0 ] && log "✓ integrity: every component and file matches its checksum"
if [ "$RECOV" != "COMPLETE" ]; then
  [ -n "$ISSUES" ] || ISSUES="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("missingCount","?"), "DB-referenced file(s) not captured")' "$PKG/uploads.refcheck.json" 2>/dev/null || echo 'see MANIFEST.json')"
  if [ "${DR_ALLOW_INCOMPLETE:-0}" = "1" ]; then
    warn "~ recoverability $RECOV: $ISSUES — accepted ONLY because DR_ALLOW_INCOMPLETE=1 (partial recovery; the listed items will be missing)"
  else
    err "✗ recoverability $RECOV — not a complete recovery point: $ISSUES"
    FAIL=1
  fi
else
  log "✓ recoverability COMPLETE: all DB-referenced files and database prerequisites captured"
fi

if [ "$FAIL" -eq 0 ]; then
  log "VERIFY OK — integrity confirmed, recoverability $RECOV: $PKG"
elif [ "$INTEGRITY_FAIL" -eq 0 ]; then
  err "VERIFY: integrity OK, but recoverability $RECOV — a PARTIAL backup, not a complete recovery point: $PKG"
  exit 6
else
  die "VERIFY FAILED — package integrity is broken; not safe to rely on: $PKG"
fi
