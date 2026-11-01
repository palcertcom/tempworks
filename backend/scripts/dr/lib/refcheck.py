#!/usr/bin/env python3
"""
refcheck.py — DB↔file consistency check for a DR package.

Extracts every storage reference from the DATABASE DUMP ITSELF (so the
reference set comes from exactly the same MVCC snapshot as the captured
database), then compares it against the files actually captured in the
package. This is what makes a full-system backup trustworthy under
concurrent uploads / replacements / deletions: a row that references an
object which was deleted (or replaced-and-purged) after the snapshot is
detected here instead of silently producing a package whose database
points at a missing file.

Two reference namespaces are resolved:
  * object storage  — "<publicBaseUrl>/<key>"  -> uploads/<key>
  * legacy local    — "/uploads/<key>"          -> uploads-legacy-local/<key>
                      (or uploads/<key> when the package driver is local)

Overwrite detection: when a pre-snapshot token file is given (object ETags /
local "<size>:<mtime_ns>" taken BEFORE pg_dump), a referenced object whose
captured token differs was overwritten after the snapshot — its captured
bytes may not be the version the database snapshot refers to — and is
reported as inconsistent (reason "overwritten") so the capture is retried.

Usage:
  refcheck.py <pg_restore> <database.dump> <package_dir> <driver> [publicBaseUrl] [preTokens.json] [seenTokens.json]
Prints JSON: {referenced, missing:[...], missingCount, capturedObjects,
              unreferencedObjects, complete}
Exit 0 always (the caller decides policy from "complete").
"""
import json, os, re, subprocess, sys
from urllib.parse import unquote

pg_restore, dump, pkg, driver = sys.argv[1:5]
base = (sys.argv[5] if len(sys.argv) > 5 else "").rstrip("/")
pre_path = sys.argv[6] if len(sys.argv) > 6 else ""
seen_path = sys.argv[7] if len(sys.argv) > 7 else ""
pre = {"object": {}, "local": {}}
if pre_path:
    try: pre = json.load(open(pre_path))
    except (OSError, ValueError): pass
seen = pre
if seen_path:
    try: seen = json.load(open(seen_path))
    except (OSError, ValueError): pass

# Stream the data section of the dump as COPY text (no DB connection needed).
proc = subprocess.Popen([pg_restore, "--data-only", "-f", "-", dump],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
data = proc.stdout.read().decode("utf-8", errors="replace")
proc.wait()
if proc.returncode != 0:
    print(json.dumps({"error": proc.stderr.read().decode()[-500:], "complete": False}))
    sys.exit(0)

stop = r"[^\s\t\"'\\,)\]}]+"
refs = {}   # (namespace, key) -> original reference
if base:
    for m in re.finditer(re.escape(base) + "/(" + stop + ")", data):
        refs[("object", unquote(m.group(1)))] = base + "/" + m.group(1)
for m in re.finditer(r"(?<![A-Za-z0-9:/])/uploads/(" + stop + ")", data):
    refs[("local", unquote(m.group(1)))] = "/uploads/" + m.group(1)

def walk(root):
    out = set()
    if os.path.isdir(root):
        for dp, _, fns in os.walk(root):
            for fn in fns:
                out.add(os.path.relpath(os.path.join(dp, fn), root).replace(os.sep, "/"))
    return out

objects = walk(os.path.join(pkg, "uploads"))
legacy = walk(os.path.join(pkg, "uploads-legacy-local"))
# With the local driver, "/uploads/<key>" files live in uploads/ itself.
local_pool = objects if driver == "local" else legacy

def tokens(manifest_name, field):
    try:
        m = json.load(open(os.path.join(pkg, manifest_name)))
        return {f["key"]: f.get(field) for f in m.get("files", [])}
    except (OSError, ValueError):
        return {}
obj_tok = tokens("uploads.manifest.json", "etag" if driver == "spaces" else "token")
loc_tok = tokens("uploads.manifest.json", "token") if driver == "local" else tokens("uploads-legacy-local.manifest.json", "token")
# Pre-snapshot tokens per namespace (local driver: its files are "local").
pre_obj = pre.get("object", {}) if driver == "spaces" else pre.get("local", {})
pre_loc = pre.get("local", {})

missing, overwritten, dangling = [], [], []
for (ns, key), ref in sorted(refs.items()):
    pool = objects if ns == "object" else local_pool
    if key not in pool:
        # Absent from the capture. If it was also absent BEFORE the snapshot it
        # is a pre-existing gap (not a race): reported as dangling, not retried.
        # "seen" = union of the pre-snapshot listings of EVERY attempt so far.
        seen_ns = (seen.get("object", {}) if driver == "spaces" else seen.get("local", {})) if ns == "object" else seen.get("local", {})
        if pre_path and key not in seen_ns:
            dangling.append(ref)
        else:
            missing.append(ref)
        continue
    before = (pre_obj if ns == "object" else pre_loc).get(key)
    after = (obj_tok if ns == "object" else loc_tok).get(key)
    if before and after and before != after:
        overwritten.append(ref)

referenced_objects = {k for (ns, k) in refs if ns == "object"}
inconsistent = missing + overwritten
print(json.dumps({
    "referenced": len(refs),
    "raceCount": len(inconsistent),
    "missingCount": len(inconsistent) + len(dangling),
    "missing": (inconsistent + dangling)[:200],
    "danglingCount": len(dangling),
    "dangling": dangling[:200],
    "unresolvedCount": len(dangling),
    "absentCount": len(missing),
    "overwrittenCount": len(overwritten),
    "overwritten": overwritten[:200],
    "overwriteCheck": bool(pre_path),
    "capturedObjects": len(objects),
    "capturedLegacyLocal": len(legacy),
    "unreferencedObjects": len(objects - referenced_objects) if driver != "local" else None,
    "complete": len(inconsistent) == 0 and len(dangling) == 0,
}))
