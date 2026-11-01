# TempWorks — Disaster Recovery Runbook

**Scope:** Recover the entire TempWorks application on a *clean replacement
server* after the loss of the original server — not merely restore selected
database tables. Covers the database, uploaded files, permission model,
configuration, secrets and the deployable application release.

**Audience:** System Admin / operations.
**Toolkit:** `backend/scripts/dr/` (standalone, needs neither the app nor the
backup-catalog DB) and the in-app **Settings → Database Backup** page.

---

## 0. TL;DR — recover on a clean server

```bash
# On the clean replacement host (empty PostgreSQL 18 instance, empty storage):
sudo deploy/provision-postgres-client-18.sh            # version-correct client
export TARGET_DATABASE_URL='postgresql://USER:PASS@NEWHOST:5432/tempworks?sslmode=require'

backend/scripts/dr/restore.sh  /path/to/tempworks-dr_<ts>.tar.gz \
    --target-url "$TARGET_DATABASE_URL" --create-db --roles \
    --uploads-dest /var/lib/tempworks/uploads          # or UPLOAD_STORAGE_DRIVER=spaces

# then provide secrets (below), start the app with side-effects disabled, smoke test.
```

The package is self-verifying: `restore.sh` refuses to proceed if checksums
don't match, and it fails loudly (never reports success on a partial restore).

---

## 1. Root-cause fixes shipped with this runbook

| # | Symptom (from production) | Root cause | Fix |
|---|---|---|---|
| 1 | `POST /api/v1/backup` → 500; `pg_dump: server version mismatch — server 18.6, pg_dump 17.7` | `pg_dump` refuses to dump a server **newer** than the client; the resolver picked `/usr/bin/pg_dump` (17.7) before any v18 path, and there was **no preflight** | Version-aware toolchain resolution (`backend/scripts/dr/lib/common.sh`, `backend/src/backup/pg-tools.ts`) chooses the newest client whose major ≥ server; **preflight** fails fast with an actionable message; `deploy/provision-postgres-client-18.sh` installs the pinned v18 client reproducibly |
| 2 | A backup marked **COMPLETED** also shows **“File missing from disk”** | **Not yet proven.** Backups were written to a path relative to the process working directory (`process.cwd()/backups`) with **no off-server copy**, and the catalog was never reconciled. Candidate causes: ephemeral container disk, a deploy replacing the working tree, a *different* working directory after restart, multiple instances, or manual deletion — see `docs/DR_PRODUCTION_DEPLOYMENT.md` §1 for the commands that distinguish them | Durable `BACKUP_DIR` + **off-site** copy that is independently re-downloaded and checksum-verified + **reconcile** endpoint/button that flags missing artifacts (`fileMissing`) so a stale COMPLETED row never implies recoverability |
| 5 | (found in the drill) Recovered DB owned by the restoring superuser; app role lost `CREATE` on `public` → its boot schema-heal and all future migrations fail | A plain `pg_dump` carries no database-level properties | Backup captures DB properties via `pg_dump --create` (owner, encoding, locale, DB grants, settings); restore recreates the DB with them and **fails** if ownership is wrong |
| 6 | (found in the drill) Restored records still pointed at the **old** storage URL | `fileUrl`/`photoUrl` store absolute public URLs | Restore remaps the stored base URL to the recovery storage and asserts no reference to the old storage remains |
| 7 | (found in the drill) Backups could capture a DB row whose file was purged moments later (photo replacement) | DB snapshot and file capture are not atomic | References are extracted from the dump itself and checked against the captured files; capture retried; still-missing → package **INCOMPLETE**, never verified/restorable |
| 8 | (found in the drill) A fresh install's admin could not sign in through the UI | Seed never created an owner tenant for tenant-aware login | Seed creates the owner tenant + PlatformAdmin(SUPER) |
| 3 | Backups never contained uploads, roles, ACLs | `pg_dump --no-owner --no-acl`, no `pg_dumpall`, DB-only | Full-fidelity dump (owners/ACLs/RLS/large objects) **+** `pg_dumpall --globals-only` **+** uploaded files, assembled into a verifiable DR package |
| 4 | Long backups could time out the HTTP request | Dump ran synchronously inside the request | Backup now runs **in the background**; the request returns a `RUNNING` row immediately |

---

## 2. Coverage inventory (what is backed up & how it is recovered)

Legend — **Kind**: `DATABASE` = database-only package; `FULL_SYSTEM` = database + files + config.

| Component | Where it lives | Backed up by | In kind | Restore method | Verify method |
|---|---|---|---|---|---|
| All tables, partitions, rows | PostgreSQL `public` | `pg_dump -Fc` | both | `pg_restore` | row-count parity + `COUNT(*)` on key tables |
| Sequences / identity values | PostgreSQL | `pg_dump -Fc` | both | `pg_restore` | `pg_sequences` present + `nextval()` works + new INSERT |
| PKs, FKs, indexes, defaults, constraints | PostgreSQL | `pg_dump -Fc` | both | `pg_restore` | table-def count in `pg_restore --list`; FK/constraint presence |
| Views, materialized views | PostgreSQL | `pg_dump -Fc` | both | `pg_restore` | object presence |
| Functions, procedures, triggers, custom types, domains | PostgreSQL | `pg_dump -Fc` | both | `pg_restore` | object presence |
| Large objects / binary | PostgreSQL | `pg_dump -Fc` (LOs included by default) | both | `pg_restore` | included in dump TOC |
| Ownership, grants, default privileges, **RLS policies** | PostgreSQL | `pg_dump -Fc` (owners+ACLs retained) | both | `pg_restore` (+ roles from globals) | `pg_tables.tableowner`, `role_table_grants`, `pg_policies` parity |
| **Cluster globals** (roles, memberships, tablespaces) | PostgreSQL cluster | `pg_dumpall --globals-only --no-role-passwords` | both | `psql -f globals.sql` (`restore.sh --roles`) | roles present on target; app role can log in |
| Required extensions / encoding / collation | schema + `database.dump` header | captured in dump + `config/schema.prisma` | both | `pg_restore` recreates; runbook §7 installs ext packages | n/a (schema has no non-core extensions — see §8) |
| **Uploaded files** (documents, CVs, contracts, photos, attachments) | local `UPLOAD_DEST` **or** DO Spaces | tar into package (local) / `spaces-sync.mjs download` (spaces) | FULL_SYSTEM | copy to `--uploads-dest` / `spaces-sync.mjs upload` | per-file SHA-256 vs `uploads.manifest.json`; DB→file reference resolution |
| Application config templates | repo | `config/backend.env.example`, `config/frontend.env.example` | FULL_SYSTEM | manual fill from secret store (§6) | n/a |
| Deployable release id | git | `config/release.txt` (`appVersion`, `gitSha`) | FULL_SYSTEM | `git checkout <gitSha>` + build | version match |
| Manifest / checksums | package | `MANIFEST.json`, `CHECKSUMS.sha256` | both | — | `verify.sh` |
| **Backup catalog** (`system_backups`) | app DB | inside `database.dump` | both | restored with DB; package also usable **without** it | n/a |

### Excluded on purpose (reproducible / disposable — not backed up)

| Component | Why excluded | How it is rebuilt |
|---|---|---|
| `node_modules`, build artifacts (`dist/`, Vite `build/`) | Reproducible from lockfiles | `npm ci` + `npm run build` at the pinned `gitSha` |
| Prisma generated client | Reproducible | `npx prisma generate` |
| In-memory caches, schedulers, rate-limit counters | Transient | Rebuilt on app start |
| Role **passwords** in globals | Security (hashes kept out of backups) | Operator sets `ALTER ROLE … PASSWORD` from the secret store at restore (§6) |
| Secrets / API keys (JWT, Spaces, Resend, reCAPTCHA) | Must not live in a backup | Restored from the secret store (§6) |

> **Scope boundary:** this toolkit backs up the TempWorks database + its uploads
> only. On shared infrastructure it never touches unrelated databases or buckets.

---

## 3. Creating backups

### From the UI (System Admin → Settings → Database Backup)
- **Backup type**: *Database only* or *Full system (database + uploaded files)*.
- The page shows a **preflight** banner (toolchain/connectivity/permissions/
  capacity/destination). If it is red, backups will fail — fix the named check
  first (usually: install the v18 client via `provision-postgres-client-18.sh`).
- Backups run in the background; the row shows `RUNNING` → `COMPLETED`.
- **Verify** (per row) checks checksums + dump readability. **Reconcile** (top
  bar) flags any catalog rows whose files are missing on disk.

### From the CLI (authoritative DR path)
```bash
cd /path/to/app
export DATABASE_URL='postgresql://USER:PASS@HOST:5432/tempworks?sslmode=require'
export BACKUP_DIR=/var/lib/tempworks/backups
# optional off-site:
export UPLOAD_STORAGE_DRIVER=spaces   # if uploads live in Spaces
export BACKUP_SPACES_BUCKET=tempworks-dr   # private bucket for off-site copies

backend/scripts/dr/preflight.sh --backup-dir "$BACKUP_DIR"          # go/no-go
backend/scripts/dr/backup.sh --kind full --label "nightly" --offsite
backend/scripts/dr/verify.sh "$BACKUP_DIR/tempworks-dr_<ts>_<id>"   # integrity
```

---

### Bucket-native snapshots (streaming engine — App Platform)

When `BACKUP_SPACES_BUCKET` is configured the app uses `scripts/dr/snapshot.sh`:
snapshots live **only** in the separate backup bucket (`<prefix>snapshots/<package>/`
+ content-addressed `<prefix>blobs/sha256/`), nothing is kept on the instance.

```bash
bash backend/scripts/dr/snapshot.sh list                         # what exists (MANIFEST committed)
bash backend/scripts/dr/snapshot.sh verify <package> --deep      # re-hash dump + every file, parse archive
bash backend/scripts/dr/snapshot.sh materialize <package> /srv/restore   # rebuild the package directory
bash backend/scripts/dr/restore.sh /srv/restore/<package> --target-url … # unchanged restore path (§5)
bash backend/scripts/dr/snapshot.sh export <package> > pkg.tar   # same package as one tar (UI download)
bash backend/scripts/dr/snapshot.sh backup --kind full           # external runner (takes the same lock)
bash backend/scripts/dr/snapshot.sh retention --keep 14          # + blob GC (24 h grace)
```

`materialize` produces exactly the directory `backup.sh` would have produced, so
`verify.sh` and `restore.sh` work on it unchanged. References that were already
dangling before a backup started (e.g. legacy `/uploads/…` files lost from an
ephemeral disk) are reported as `danglingReferences` instead of failing every
backup; anything that existed during the backup and vanished or changed is
retried and, if it persists, the snapshot is marked INCOMPLETE (exit 4).

## 4. Consistency & recovery objectives

- **Coordination mechanism (implemented, online, no write pause) — prevention + detection:**
  1. *Write-once object keys.* `StorageService.uploadFile` never overwrites an
     existing key (local `O_EXCL`; S3 existence check) — every upload gets a new
     `<prefix>/<uuid>.<ext>` key, so a key's bytes never change after a snapshot
     references them.
  2. *Deferred, backup-aware deletion.* Application deletes (photo replacement,
     record deletion, draft cleanup) are queued in `storage_purge_queue`;
     `StoragePurgeService` removes them only after `STORAGE_PURGE_GRACE_HOURS`
     (default 24), never while a backup holds the advisory lock, and never while a
     URL column still references the object. Objects a snapshot references
     therefore cannot disappear during the capture.
  3. *Detection for anything outside the app.* Before each snapshot the capture
     records a change token per object (S3 ETag / local size+mtime); after
     capture, `lib/refcheck.py` checks every reference extracted from the dump
     is present **and unchanged**. A missing or overwritten object → the whole
     capture is retried (`BACKUP_CONSISTENCY_RETRIES`, default 2); still
     inconsistent → **INCOMPLETE** (exit 4), rejected by verify/restore, never
     sent off-site.
  - Tested: app writes inside the window (upload, photo replacement, renewal,
    soft-delete) → consistent on the **first** attempt; out-of-band overwrite of
    a referenced key → detected, consistent on attempt 2; sustained write load
    (uploads + photo replacements + deletes) → **COMPLETED**; purge skipped while a
    backup runs and never deletes a referenced object
    (`docs/dr-evidence/2026-10-25b-consistency/`).
  - Residual blind spot: an object created in the instant between the token
    listing and the snapshot, then overwritten out-of-band before its capture.
    The application cannot do this (write-once keys); only external tools can.
- **`--maintenance`** is only a *label* in the manifest; the toolkit does not pause the
  application. The validate-and-retry mechanism above makes a write pause unnecessary for
  consistency; use a maintenance window only if a business process requires it.
- **RPO (recovery point):** the last successful backup. Scheduled nightly →
  **up to 24 h of data loss**. This is **not** zero-data-loss. For near-zero RPO
  you must add PITR/WAL archiving (§8) — a logical dump does **not** provide it.
- **RTO (recovery time):** dominated by dump/restore + file copy. On the
  validated dataset (82 tables, 6 files) end-to-end backup and restore each
  completed in **< 2 s**; realistic production RTO scales with DB + upload size
  (plan tens of minutes to a few hours for large datasets, plus app build/start).

---

## 5. Clean-server recovery procedure (step by step)

**Prerequisites on the replacement host:** Ubuntu/Debian, Node (same major as
prod), Apache (or reverse proxy), an **empty** PostgreSQL 18 instance, empty
storage, and the DR package (from off-site storage) + the secret store.

1. **Runtime + version-correct PG client**
   ```bash
   sudo deploy/provision-postgres-client-18.sh      # installs postgresql-client-18
   ```
2. **Get the matching application release**
   ```bash
   git clone <repo> && cd app && git checkout "$(grep gitSha <pkg>/config/release.txt | cut -d= -f2)"
   npm ci && (cd backend && npm ci && npx prisma generate)
   npm run build && (cd backend && npm run build)
   ```
3. **Restore database + roles + uploads** (fails loudly on any substantive error)
   ```bash
   export TARGET_DATABASE_URL='postgresql://tempworks_app:PASS@localhost:5432/tempworks?sslmode=disable'
   backend/scripts/dr/restore.sh <pkg-or-tarball> \
       --target-url "$TARGET_DATABASE_URL" --create-db --roles \
       --uploads-dest /var/lib/tempworks/uploads
   # Managed provider where you cannot create the original roles:
   #   add --no-owner  (ownership/ACLs re-applied by the app's role sync)
   # Uploads in Spaces instead of local disk:
   #   UPLOAD_STORAGE_DRIVER=spaces + DO_SPACES_* creds (files pushed to the bucket)
   ```
4. **Recover secrets** (§6) and set the app DB role password:
   ```bash
   psql "$TARGET_DATABASE_URL" -c "ALTER ROLE tempworks_app WITH LOGIN PASSWORD 'FROM_SECRET_STORE'"
   ```
5. **Reconfigure the environment** — `backend/.env` from `config/backend.env.example`
   filled with the new `DATABASE_URL`, `FRONTEND_URL`, storage endpoint/bucket,
   TLS certs, and the secrets from §6.
6. **Bring up with external side-effects DISABLED for smoke testing** (so recovery
   doesn't email real people). Verified in the code: email (Resend) is the only
   outbound side effect — SMS has no provider and is force-disabled, and there are
   no webhook integrations. Start the backend with `RESEND_API_KEY` **unset** (it
   logs "Emails will NOT be sent") and `BACKUP_SCHEDULE_CRON` **unset** (scheduled
   backups disabled). In-app schedulers still run but cannot send email.
   ```bash
   cd <release>/backend && env -u RESEND_API_KEY -u BACKUP_SCHEDULE_CRON node dist/src/main.js
   ```
   Verify login, tenant isolation, open/download an existing attachment, create a
   new record + upload (the full checklist is `backend/scripts/dr/drill/verify-recovery.mjs`).
   Then set the real `RESEND_API_KEY` / schedule for live traffic.
7. **Rebuild disposable components** — none required beyond `npm ci` / `prisma
   generate`; schedulers and caches re-initialise on boot.
8. **Reconstruct the backup catalog** — restoring the DB brings `system_backups`
   back. The package is also usable with **no** catalog: `restore.sh` reads only
   `MANIFEST.json`.

---

## 6. Secrets & encryption keys (secure recovery)

Secrets are **never** stored in the backup package, logs, source control or
ordinary manifests. Recovery must **not** depend on retrieving a key from the
lost server or from inside the (unencrypted) backup.

Keep these in an independent secret manager (e.g. DO/Vault/1Password), with a
break-glass copy held off-site by a second custodian:

| Secret | Purpose | Without it |
|---|---|---|
| `DATABASE_URL` (app role password) | DB access | app cannot connect |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | session/token signing | all users forced to re-login (set fresh to invalidate old tokens) |
| `DO_SPACES_ACCESS_KEY` / `SECRET_KEY` | read/write uploaded files | existing attachments unreadable |
| `BACKUP_SPACES_*` | fetch off-site DR packages | cannot retrieve backups |
| `RESEND_API_KEY` / SMTP | outbound email | notifications fail (safe to leave empty during recovery) |
| `RECAPTCHA_SECRET_KEY` | public apply form | public form rejects submissions |

> There is **no application-level at-rest column encryption** in the current
> schema (no `ENCRYPTION_KEY`, no encrypted columns, no DB extensions — see §8),
> so decrypting restored data needs no additional key material beyond DB access.
> If column encryption is introduced later, its key **must** be added here.

---

## 7. Extensions, roles & provider-managed caveats

- **Extensions:** the Prisma schema declares **no** non-core PostgreSQL
  extensions and no `Unsupported`/DB-generated types (UUID defaults are produced
  in application code). Nothing extra needs installing before restore. If an
  extension is added later, `CREATE EXTENSION` lines appear in the dump and the
  package's host must have the extension's OS package installed first.
- **Roles (§Roles):** every backup records the roles the database needs in
  `database/prerequisites.json` and `database/roles.sql`. These are captured
  from the catalog, so they exist even when `pg_dumpall --globals-only` is
  refused (`components.globals.captured=false`, recorded as
  `GLOBALS_FROM_CATALOG`). The required roles are the owners, every grantee,
  RLS policy roles, the connecting role, and their memberships. If even this
  capture fails, the backup is **INCOMPLETE** (`PREREQ_CAPTURE_FAILED`).
  - Restore into a fresh cluster with `--roles`. It works as superuser, or as
    a non-superuser `CREATEROLE` admin such as DigitalOcean `doadmin`.
  - Provider-managed owners (`doadmin`) must exist on the target or be mapped:
    `--role-map doadmin:<role>`.
  - `restore.sh` aborts **before touching the target** when a required role or
    extension is missing, and says which one.
  - Set LOGIN role passwords from the secret store afterwards; restore.sh
    prints the statements. `--no-owner` remains a last resort.

### Missing files (DEGRADED / LIVE_STORAGE_MISSING_RECOVERED)

A full backup is **DEGRADED** when files referenced by the database exist in
**no** source that was checked. It is still consistent and useful, but it is
not a complete recovery point. Before reporting a file, the streaming engine
checks the live bucket (every listing plus a direct HEAD), this instance's
disk, the legacy inventories of **other instances**, and every earlier
snapshot. `uploads.refcheck.json` → `unresolved[]` lists, per reference, what
was checked and when.

1. **Legacy `/uploads/…` files.** App Platform keeps them on each instance's
   own ephemeral disk, and every deploy resets that disk.
   - Call `POST /api/v1/backup/legacy-inventory` as System Admin repeatedly,
     until every running instance has answered. The response names the
     instance; from a console the equivalent is
     `bash scripts/dr/snapshot.sh legacy-inventory`.
   - Check coverage with `GET /api/v1/backup/legacy-inventory` (or
     `snapshot.sh legacy-inventories`): every running instance's hostname must
     appear, each with a scan time later than the latest deploy.
   - Back up again. Files found on any instance are now **preserved** in the
     backup as candidates (`recoveredFrom: instance …`). Because legacy local
     keys carry no version evidence, they still count as unverified (item 3).
     The durable fix is to move them into object storage through the app,
     which records version evidence.
   - If no running instance has a file, it was lost with an earlier
     deployment's disk.
2. **Object-storage files.** Check other copies: the uploader; another
   bucket/region; Spaces versioning if it was enabled; DigitalOcean support for
   recently deleted objects. Earlier snapshots are already searched
   automatically.
3. **Candidate copies without version evidence** (`FILES_VERSION_UNVERIFIED`,
   DEGRADED). An intact copy from another instance or an earlier snapshot is
   *not* proof that it is the version the database references. Every legacy
   local file and every object written without the app's write-once metadata
   is such a candidate. The backup **includes** these candidates
   (`versionVerified: false`, `recoveredFrom`), and `uploads.refcheck.json` →
   `versionUnverified[]` lists the source, sha256 and reason for each.
   * Confirm the right version with the document owner or uploader, then
     re-upload it through the app. That writes a new object with version
     evidence and updates the reference.
   * Or record a decision to accept the candidate.
   * Until then the backup stays DEGRADED.
4. **Found in another source WITH version evidence** (`LIVE_STORAGE_MISSING_RECOVERED`, INFO). The
   backup contains the file, but live storage does not. Repair live storage:
   `snapshot.sh materialize <pkg> <dir>`, then copy the listed keys back into
   the live bucket (`spaces-sync.mjs upload` on a directory holding only those
   files).
5. **Truly lost.** Decide per record: re-upload the document, or remove/flag
   the database rows. Until then every full backup stays DEGRADED and the
   staleness alert reports that no complete backup exists. That is
   deliberate: such a backup cannot fully restore the application.

Restoring a DEGRADED package needs an explicit decision: `DR_ALLOW_INCOMPLETE=1`
for `verify.sh`/`restore.sh`, or `acceptDegraded=true` for the in-app restore.

---

## 8. PITR / WAL assessment (honest)

This toolkit provides **logical** backups (point-in-time = the backup instant).
It does **not** provide continuous recovery; it cannot replay to an arbitrary
second. If the business requires near-zero RPO:

- Enable **WAL archiving / PITR** on the PostgreSQL server (managed DO Postgres
  offers point-in-time recovery; or configure `archive_command` + base backups
  per <https://www.postgresql.org/docs/18/continuous-archiving.html>).
- Keep these logical DR packages **in addition** — they are portable across
  hosts/providers and include the uploaded files and config, which WAL does not.

Do not claim zero data loss from scheduled logical backups.

---

## 9. Storage, retention & monitoring

- **Durable local storage:** `BACKUP_DIR` must be a persistent volume.
- **Off-site:** `--offsite` / `BACKUP_SPACES_*` copies each package to a private
  bucket so losing the server does not lose the only copy. **DR readiness
  requires an off-site copy** — a backup that only exists on the original server
  is not disaster recovery.
- **Retention:** `BACKUP_RETENTION_COUNT` (default 10). The newest backup and the
  newest **verified** backup are always preserved — retention can never delete
  the last recoverable backup.
- **Monitoring:** failed/stale/missing backups surface through the existing
  notification/audit mechanisms (`BACKUP_FAILED`, `BACKUP_VERIFY_FAILED`,
  reconcile `fileMissing`). Backup creation, **integrity verification**, and
  **successful restore testing** are tracked as *distinct* states
  (`status`, `verifyResult`/`verifiedAt`, `restoreTestedAt`).

---

## 10. Validation evidence

See `BACKUP_DR_IMPLEMENTATION_REPORT.md` and `docs/dr-evidence/2026-10-25-local-drill/`.
Summary: a **local** complete-application drill (`backend/scripts/dr/drill/drill.sh all`)
recovered TempWorks onto a separate clean stack from an off-site copy — 51/51 checks
(login, permissions, tenant isolation, attachments, uploads, CRUD, ownership,
constraints, sequences, file checksums, schema parity), RTO 25 s for the test dataset.
Object storage was a local S3-compatible **simulation**; production (real Spaces +
managed PostgreSQL) has **not** been validated yet — see
`docs/DR_PRODUCTION_DEPLOYMENT.md` §7. Toolkit self-test: 58/58.
