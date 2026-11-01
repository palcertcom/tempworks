# Backup & Disaster Recovery — Status Report

Date: 2026-10-25 · Branch `claude/design-multitenant-recruitment-8H42T` · Head `e9a27b3`

> **Bottom line.** A complete **local** application recovery has been demonstrated:
> an independently retained backup restored the working TempWorks application —
> database, uploaded files, users, permissions and tenant isolation — on a clean,
> separate stack, with the source stopped and its storage destroyed
> (**51/51 checks, schema identical**). **Production disaster recovery is NOT yet
> demonstrated**: nothing was deployed or run against production, DigitalOcean
> Spaces, or the managed database (no access from this environment).
> Object storage in the drill was a **local S3-compatible simulation (s3rver)**,
> not DigitalOcean Spaces.

> **Update 2026-10-25 (b) — tested release `0660aff`.** Resolved since `a51b657`:
> (1) `enhance_maintenance_records.sql` fixed (UUID→TEXT keys), `db:migrate:all`
> 28/28; (2) backups stay consistent under concurrent file changes, including
> overwrites of an existing key (write-once keys + deferred, backup-aware deletion
> + pre-snapshot change tokens) — under sustained load the backup now COMPLETES;
> (3) the tenant-isolation fix is packaged for standalone deployment onto `main`
> (`docs/security/TENANT_FILE_ISOLATION_FIX.md`); (4) production hosting
> identified as DigitalOcean App Platform (frontend static site + separate
> backend app) — see `docs/DR_PRODUCTION_DEPLOYMENT.md` §0. Evidence:
> `docs/dr-evidence/2026-10-25b-consistency/`. Items marked below as resolved.

This report supersedes the earlier version, which overstated two things:
it called the `cwd/backups` loss "ephemeral storage wiped on redeploy" (not
proven), and it described a PostgreSQL role connecting after restore as if the
application had been recovered (it had not been started).

---

## 1. Commits, files, documents

| Commit | Content |
|---|---|
| `22c1808` | Version-aware toolchain, preflight, DR toolkit, background jobs, admin UI |
| `47baa1b` | Restore version matching, exit-status-preserving traps, cross-instance lock, consistency check, URL remap, role mapping |
| `2e53b46` | Database-level properties, storage-target guard, seed fixes, scheduling, application drill |
| `330de5a` | Tolerate objects deleted mid-capture (found under load); production deployment guide |
| `c04c98a` | **Security fix**: tenant isolation on document file bytes + bulk ZIP |
| `e9a27b3` | Accurate reconstructed catalog row; re-verify from the recovered system |

38 files changed (see `git diff --stat 8c99763..e9a27b3`). Key documents:

- Runbook + coverage matrix: [`docs/DISASTER_RECOVERY_RUNBOOK.md`](docs/DISASTER_RECOVERY_RUNBOOK.md)
- Production deploy / validation / rollback: [`docs/DR_PRODUCTION_DEPLOYMENT.md`](docs/DR_PRODUCTION_DEPLOYMENT.md)
- Toolkit + drill: [`backend/scripts/dr/README.md`](backend/scripts/dr/README.md)
- Drill evidence (logs, JSON, screenshots): [`docs/dr-evidence/2026-10-25-local-drill/`](docs/dr-evidence/2026-10-25-local-drill/)

---

## 2. What has actually been verified

| Level | Items |
|---|---|
| **Verified against live production** | Nothing in this work. The only production facts are from your screenshots (HTTP 500, server 18.6 vs pg_dump 17.7, a COMPLETED row whose file is missing). |
| **Verified locally — full application drill** (real backend, real frontend, PostgreSQL 18.6, S3 *simulation*) | Setup via the real process; multi-tenant data through the API; backup triggered from the admin UI; integrity + off-site verification; consistency under concurrent writes; overlap prevention; scheduled backups; recovery from off-site copies onto a separate stack; UI/API/DB/storage checks — §4 |
| **Verified locally — toolkit self-test** (`dr-selftest.sh`, 58/58) | Ownership, ACLs, RLS, DB owner/encoding, sequences, constraints, version matching, exit-status preservation for every stage, corruption/missing/incomplete detection, role mapping, provider-role filtering |
| **Inferred from repository configuration** | Hosting: `.htaccess` → Apache + Node on one host, **or** DigitalOcean App Platform (`vite.config.ts` allowed hosts). Managed DB via `sslmode`. Spaces via `DO_SPACES_*`. Outbound side effects limited to email (no SMS provider, no webhooks — checked in code). |
| **Implemented, not deployed / not tested against real infrastructure** | Real DigitalOcean Spaces (off-site + uploads), managed-DB `pg_dumpall` permissions, provider role names, App Platform image (Dockerfile in the deploy guide — not built), production schedule, production RTO at real data size |
| **Not proven** | Why the April backup file is missing. Candidate causes and the commands that distinguish them: `docs/DR_PRODUCTION_DEPLOYMENT.md` §1 |

---

## 3. Implementation risks reviewed and fixed

| Risk | Fix | Test |
|---|---|---|
| Toolchain selection | Backup: newest client ≥ server. **Restore: exact target-major required**; skew only with `PG_ALLOW_VERSION_SKEW=1`; refuses a client older than the archive | self-test: exact 18 chosen; skew refused; pg_restore 16 refuses a pg_dump 18 archive |
| Traps masking failures | Cleanup captures and re-exits with the original status | self-test: injected failures in dump / copy / archive / restore-db / restore-files all exit 97, no partial package |
| Restarts and overlapping jobs | PostgreSQL **advisory lock** on a dedicated connection (all instances; auto-released on crash); orphaned `RUNNING` rows reconciled on boot | drill: second request → **HTTP 503**; scheduled tick while locked → `SKIPPED_BUSY` + audited |
| Objects outside Prisma | `pg_dump` dumps the live database; 27/28 hand-written SQL migrations + 117 boot-time heal statements present | drill: recovered `--schema-only` dump **identical** to the source |
| Database-level properties | Owner, encoding, locale, DB grants and settings captured (`pg_dump --create`) and recreated; restore **fails** if ownership is wrong | self-test + drill: owner `tempworks_app`, recovered boot heal **117/117** (was 64/117 before the fix) |
| Managed-DB roles | Provider roles (`doadmin`, `_dodb`, `rds*`, …) filtered **explicitly** and logged; real globals errors reported; `--role-map OLD:NEW` keeps ownership + grants | self-test: role-mapped restore, all tables + DB owned by mapped role, grants intact |
| DB/file consistency | References extracted from the dump (same snapshot) and checked against captured files; retry; still missing → **INCOMPLETE** (exit 4), rejected by verify/restore, never sent off-site | drill A: purge inside the window detected, consistent on attempt 2; drill B: under sustained load → INCOMPLETE (correct, see §6) |
| Objects vanishing mid-capture | Listed-then-deleted objects/files recorded as vanished, left to the reference check | found by drill B (whole backup failed with `NoSuchKey`); fixed |
| External object storage | Mirror, restore and off-site via the AWS SDK path the app uses | drill (S3 **simulation**) |
| Storage URLs after recovery | `fileUrl`/`photoUrl` remapped to the recovery storage; restore fails if any document still points at the old storage | drill: 6/6 remapped, 0 to the source |
| Ambiguous storage target | Restore refuses before touching anything if object-storage files have no declared target | drill negative check |
| Partial / incomplete packages | Atomic publish; manifest `complete`; off-site copy re-downloaded and SHA-256 checked (`VERIFIED` vs `UPLOADED`/`FAILED`) | self-test + drill |
| Blocking the API | Scripts run asynchronously (verify of a large package no longer blocks the event loop) | build + drill |

---

## 4. Local application recovery drill (`backend/scripts/dr/drill/drill.sh all`)

**Topology** — two independent stacks on one machine; recovery has its own PostgreSQL, ports, bucket, config and an app directory unpacked from the release artifact.

| | Source | Recovery |
|---|---|---|
| PostgreSQL 18.6 | :57432 | :57433 (fresh, no roles) |
| Backend / web | :3101 / :8101 | :3201 / :8201 |
| Upload bucket | `src-uploads` | `rec-uploads` (empty at start) |
| Off-site | `dr-offsite`: backup packages + release artifact `tempworks-release-e9a27b3…` (`dirty:false`) | read only from here |

**Sequence and results (final run, 241 s wall)**

1. **Setup via the real process**: `prisma db push` → `db:migrate:all` (27/28 SQL migrations; `enhance_maintenance_records.sql` fails — pre-existing FK/type conflict, recorded) → fixed `seed.ts` → backend boot heal 117/117.
2. **Data through the API**: 2 tenants, 3 users (HR ×2, Read Only), 3 employees, 6 documents, 2 photos. Source checks pass, including tenant isolation and cross-tenant file denial.
3. **Backup from the admin UI** (Playwright): preflight READY → *Full system* → COMPLETED, integrity **VERIFIED**, off-site **VERIFIED** (8 files). Screenshots `01`–`03`.
4. **Concurrency**: (A) API upload, photo replacement, renewal and soft-delete inside the snapshot→capture window → purge detected, consistent on attempt 2, package verifies. (B) Second backup request → 503. Backup under sustained load (66 uploads, 66 photo replacements, 33 deletes) → **INCOMPLETE**, off-site skipped.
5. **Scheduling**: active (cron `* * * * *`, Europe/Bratislava — drill only); tick during a held lock → `SKIPPED_BUSY` + audit entry; next tick → COMPLETED, VERIFIED, off-site VERIFIED; not stale.
6. **Disaster**: source backend, web and database stopped; source host directory and source bucket removed; all confirmed unreachable.
7. **Recovery** using only the off-site copies, the secret store and prerequisites (PostgreSQL 18, Node 22, npm registry): checksums OK → release unpacked + `npm ci` → fresh cluster → restore with the **artifact's own toolkit** → app role password from the secret store → services started with email disabled.
8. **Verification — 51/51** (`recovery-verification.json`, screenshots `10`–`14`):
   - independence: no source DB/API/bucket in config; source down; backend running from the unpacked artifact;
   - recovered boot heal **117/117** (schema can still evolve); outbound email disabled;
   - **application login** with original passwords (admin + tenant users, through API and UI); wrong password rejected; cross-tenant login rejected; Read Only user gets 403 on create;
   - **tenant isolation** for lists, direct record access (403), single-file download (404) and bulk ZIP (other tenant's file excluded);
   - all 6 original attachments + 2 photos byte-identical (SHA-256); URLs point to the recovery bucket;
   - **recovery point**: records written after the backup are absent; a document soft-deleted after it is active;
   - create employee (number `…003 → …004`, no collision), update persists, new upload via API **and via UI** stored in the recovery bucket and served byte-identical;
   - tables owned by the app role; 83 read-only grants; FK and unique constraints enforced; sequences advance;
   - catalog reconstructed: package = COMPLETED + VERIFIED + restore-tested + off-site VERIFIED, 8 files; the recovered system re-verifies it;
   - file inventory: 8/8 objects present with identical SHA-256;
   - **schema parity**: recovered `pg_dump --schema-only` identical to the source.

**Measured durations (this dataset: 84 tables, 8 files, ~96 KB package)**

| Step | Seconds |
|---|---|
| Backup job (UI request → COMPLETED) | 4.2 |
| UI backup end-to-end incl. login + UI verify | 10.2 |
| Fetch backup + release from off-site | 1.1 |
| Unpack release + `npm ci` + `prisma generate` | 15.9 |
| Fresh PostgreSQL | 1.0 |
| Restore DB + roles + files + URL remap + catalog | 2.4 |
| Start backend + web | 4.1 |
| **Total recovery (RTO, local)** | **25.1** |

**Demonstrated recovery point**: the database snapshot of the UI-triggered backup (job started `2026-10-25T08:56:54Z`). Everything written afterwards (concurrency load, scheduled-backup period) was absent after recovery, as expected. This is a **point-in-time logical backup**: RPO = time since the last successful backup, **not** zero data loss. Production RTO at real data volume is not measured.

---

## 5. Defects found by the drill and fixed

1. Recovered database owned by the restoring superuser → app role lost `CREATE` on `public` → boot heal 64/117 and future migrations would fail. **Fixed** (DB-level properties).
2. Restore silently put object-storage files on local disk when `UPLOAD_STORAGE_DRIVER` was unset. **Fixed** (refuses up front).
3. Recovered records pointed at the **old** bucket URL (the app fetches `fileUrl` directly). **Fixed** (remap + assertion).
4. A backup could capture a row whose file the app purged moments later. **Fixed** (snapshot-consistent reference check, retry, INCOMPLETE).
5. An object deleted between listing and download failed the **whole** backup. **Fixed**.
6. Fresh installs could not sign in through the UI (no owner tenant; seed used the dropped `Agency.isSystem`). **Fixed** in `seed.ts`.
7. **Security (pre-existing, also in production code):** `GET /documents/:id/file` and `POST /documents/bulk-download` served other tenants' files by ID in the default (legacy) mode. Shown not to be caused by restore: `tenantId` was intact in both the backup and the recovered DB. **Fixed** (`c04c98a`) — recommend deploying promptly. The repo's DB-backed `documents-download-isolation` harnesses need a dedicated database and were **not run**.
8. The reconstructed catalog showed "0 files / No off-site copy" for the package it was restored from. **Fixed**.

---

## 6. Open issues

- ~~Backups under sustained replace-and-purge load can end INCOMPLETE.~~ **Resolved
  (`0660aff`)**: deletions are deferred and backup-aware, keys are write-once;
  the drill's sustained-load backup now COMPLETES on attempt 1. Out-of-band
  overwrites are detected via pre-snapshot change tokens and retried.
- ~~`enhance_maintenance_records.sql` fails.~~ **Resolved (`0660aff`)**. Note: the
  backend still *discards* the driver/drop-off/pick-up/approval/work-description
  fields that the vehicle maintenance form collects (pre-existing; enabling them
  is a separate feature change now unblocked by the migration).
- `--maintenance` is only a label; the toolkit does not pause the application.
- Scheduling is **not configured** for production (`BACKUP_SCHEDULE_CRON` unset ⇒ disabled).
- Production runs on App Platform (no persistent disk): the off-site copy is
  mandatory and the PostgreSQL 18 client must be built into the backend image.

## 7. Requirement-by-requirement status

| Requirement | Implemented | Deployed | Tested | Evidence | Remaining blocker |
|---|---|---|---|---|---|
| Fix pg_dump/server version mismatch | Yes | No | Local (18.6 ↔ 18.6; mismatch refusal) | self-test; drill preflight READY | Install PG 18 client on the prod backup host |
| Preflight checks | Yes | No | Local | screenshot 01; `/backup/preflight` | Deploy |
| Missing-file root cause | Strongly supported: backend on App Platform (ephemeral disk) | — | Public headers | deploy guide §0–1 | Deploy history log would prove it |
| Durable `BACKUP_DIR` | Config + docs | No | — | deploy guide §2–4 | Persistent volume (Droplet) or off-site-only (App Platform) |
| Full DB coverage incl. non-Prisma objects, ACLs, RLS, DB properties | Yes | No | Local | schema parity; self-test | Confirm managed-DB `pg_dumpall` permissions |
| Uploaded files (object + legacy local) | Yes | No | Local, **S3 simulation** | drill file parity 8/8 | Test against real Spaces |
| DB/file consistency under concurrency (incl. key overwrite) | Yes (prevention + detection) | No | Local (deterministic, out-of-band overwrite, sustained load) | `2026-10-25b-consistency/concurrency.json` | Deploy |
| Off-site copy, independently verified | Yes | No | Local, **S3 simulation** | `ui-backup.json`, recovery from downloaded copy | Create private Spaces bucket + scoped key |
| Distinct statuses (created / integrity / off-site / restore-tested / incomplete) | Yes | No | Local | catalog checks; screenshots 03, 14 | Deploy |
| Background jobs, cross-instance lock, restart reconciliation | Yes | No | Local (503, SKIPPED_BUSY) | `concurrency.json`, `schedule.json` | Deploy |
| Retention protecting last verified backup | Yes | No | Code path only (not exercised to the limit in the drill) | `enforceRetention` | Test with > `BACKUP_RETENTION_COUNT` backups |
| Scheduled backups + staleness/failure alerts | Yes (disabled by default) | No | Local | `schedule.json` | Choose and set cron/TZ in production |
| Restore without original catalog/DB | Yes | — | Local | drill | — |
| Clean-environment **application** recovery | Yes | — | **Local, 51/51** | `recovery-verification.json`, screenshots 10–14 | Repeat once against real Spaces + managed DB |
| Secrets recoverable independently | Procedure + secret store pattern | — | Local (secret store outside backups) | runbook §6 | Set up a real secret manager + break-glass copy |
| Side effects disabled during drills | Yes (email key absent; no SMS/webhooks exist) | — | Local | `recovered-backend-boot.log` | — |
| Admin UI (Database vs Full System, statuses, schedule) | Yes | No | Local (Playwright) | screenshots | Deploy |
| Tenant isolation of document files | Fixed | **No** | Local | drill checks | **Deploy promptly** |
| PITR/WAL | Assessment only | — | — | runbook §8 | Business decision on RPO |

---

## 8. Reproduce

```bash
backend/scripts/dr/dr-selftest.sh                 # toolkit self-test (58 assertions)
backend/scripts/dr/drill/drill.sh all             # full local application drill (~4 min)
backend/scripts/dr/drill/drill.sh down            # stop drill services
```

Prerequisites: PostgreSQL 18 server+client (`deploy/provision-postgres-client-18.sh`
for the client), Node 22, Playwright + Chromium, npm registry access, `fuser`/`setsid`.

## 9. Readiness

- **Local complete-application recovery: demonstrated.**
- **Production disaster recovery: not demonstrated.** It becomes demonstrable after
  `docs/DR_PRODUCTION_DEPLOYMENT.md` §7: deploy, configure the off-site bucket, take
  the first production full-system backup, and restore it into a protected
  environment against real Spaces and a managed PostgreSQL instance.
