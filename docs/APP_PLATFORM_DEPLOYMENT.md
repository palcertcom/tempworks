# TempWorks backend on App Platform — deployment package (DR + security)

Prepared 2026-10-25 for app `tempworksbackend`, component
`tempworksemployeerecruitmentcomp` (region fra, `source_dir: /backend`,
`instance_count: 2`, `apps-s-1vcpu-1gb`, deploy-on-push from `main`).

**Nothing in this document has been deployed, and no production setting has
been changed.** Every test described here ran in this repository's sandbox
against local PostgreSQL 18 and the **s3rver S3 simulator, not DigitalOcean
Spaces**. Results from the real Spaces and App Platform are still outstanding
(§12 step 6 onward).

---

## 1. What is in the candidate

| Area | Change |
|---|---|
| Build | `backend/Dockerfile` (multi-stage, base image pinned by digest), `backend/docker-entrypoint.sh` (same order as today: `prisma migrate deploy`, then `node dist/src/main.js`), `backend/.dockerignore` |
| Backups on App Platform | New **streaming engine** `backend/scripts/dr/snapshot.sh` + `snapshot-engine.mjs`. pg_dump streams straight into a separate private bucket. Files are stored once, content-addressed, and unchanged ones are not re-sent. `MANIFEST.json` is written last. The stored copy is verified, and nothing is staged locally. |
| Two instances | Bucket is authoritative for list / verify / download / reconcile. Scheduled occurrences are claimed once. Purge and backup coordinate through shared/exclusive advisory locks. SIGTERM interrupts cleanly; a SIGKILLed instance is reconciled by the survivor. |
| Runtime config | `enableShutdownHooks()`. Database CA trust (`DATABASE_CA_CERT`) for the app pool, DR tools and (opt-in) Prisma migrations. `scripts/ops/tls-check.mjs`. |
| Security | Tenant check on attachment bytes and bulk ZIP (`isSameTenantAsCaller`, already on the dev branch). |
| Recovery completeness | Every backup has two separate verdicts. **Integrity** (`verifyResult`) asks whether the stored bytes match their checksums. **Recoverability** (`status`) asks whether the backup contains everything a recovery needs: COMPLETED, DEGRADED or INCOMPLETE (§10a). A checksum-valid partial backup is never shown, verified, retained or alerted on as complete. |
| Database prerequisites | Required roles, memberships, role settings, extensions and tablespaces are captured from the catalog even when `pg_dumpall` is refused, and recreated by `restore.sh --roles`. The restore is provider-compatible (non-superuser `CREATEROLE` admin) and aborts **before touching the target** if a prerequisite is missing (§10b). |
| Unchanged | The staging engine (`backup.sh`) stays for hosts whose disk is larger than the dataset (recovery host, VM). |

Branch for review: **`claude/review-dr-app-platform`** = current `main`
(5bffa16) + the development branch (merged with no conflicts) + this work. The
exact tested commit is stated in the pull request.

## 2. Exact additional infrastructure (nothing has been provisioned)

| # | Resource | Requirement | Why |
|---|---|---|---|
| 1 | **Backup bucket** | One new **private** Spaces bucket, e.g. `tempworks-dr-backups`, **in a different region** from the live data (e.g. `ams3`; live is `fra1`). No CDN. File listing **not** public. Add a lifecycle rule "abort incomplete multipart uploads after 1 day". | Backups must survive loss or corruption of `tempworks-uploads`, its region, or a bug or leaked key that touches it. The engine refuses to use the live bucket. |
| 2 | **Backup access key** | A Spaces access key limited to bucket #1 (Read/Write/Delete on that bucket only) if your account offers per-bucket keys; otherwise a key used only for backups. Stored as two **SECRET** env vars. | A leaked app upload key must not be able to delete the backups. |
| 3 | **Recovery host** (only during drills or incidents) | A temporary Droplet, Ubuntu 24.04, ≥ 2 vCPU / 4 GB RAM, disk ≥ 2.5 × (dump + files) + 10 GB (80 GB disk for today's size). It runs PostgreSQL 18 locally as the isolated restore target. Create it for the test and destroy it afterwards (billed hourly). | Recovery must not depend on a personal computer. App Platform's 4 GiB disk cannot hold a full restore of a growing dataset. |
| — | Optional, recommended later | A second copy at another provider (any S3-compatible bucket). | Protects against loss of the DigitalOcean account itself. Not required for the first rollout. |

Cost note: an existing Spaces subscription normally covers additional buckets.
Storage beyond the included allowance is billed per GiB. Please confirm with
your plan before creating anything.

## 3. Build: Dockerfile (exact build tested in CI, see §3a)

* App Spec: `source_dir: /backend` is the Docker build context;
  `dockerfile_path: backend/Dockerfile` is relative to the repo root.
* Stages: `prod-deps` (`npm ci --omit=dev`, which keeps the Prisma CLI because
  the lockfile marks it devOptional, then `prisma generate`), `build`
  (`npm ci --include=dev`, so the nest CLI and TypeScript are present whatever
  `NODE_ENV` is, then `npm run build`), and `runtime`.
* Runtime image contents: Node 22.23.4 (digest-pinned `node:22-bookworm-slim`),
  **PostgreSQL client 18.6 from PGDG** (`pg_dump`/`pg_restore`/`psql`/`pg_dumpall`;
  the build fails if the major is not 18), python3 + bash for the DR scripts,
  `tini` as PID 1, the compiled app, production `node_modules` with the Prisma
  CLI, `prisma/`, `scripts/dr` and **`scripts/ops`** (`tls-check.mjs`; its
  only dependencies are `pg` in node_modules and `prisma/pg-ssl.js`). Runs as
  user `node`.
* Entry point: with **no command** (the App Platform service, `run_command`
  removed) it runs `prisma migrate deploy`, then the server. With an
  **explicit command** (`docker run <image> node scripts/ops/tls-check.mjs`,
  or a one-off job) it runs exactly that command instead.
* No secrets: the build reads no environment. A fixed placeholder URL
  satisfies `prisma.config.ts` during `generate`. `.dockerignore` excludes
  `.env*` (except `.env.example`). Verified: there is no `.env` in the image
  and no secret-like environment variables.
* Size: 1.13 GB uncompressed (node_modules 525 MB).
* **Local build limitation (exact):** this sandbox reaches the internet only
  through a TLS-intercepting proxy that refuses plain HTTP. Inside a
  `docker build`, `apt-get` (http://deb.debian.org) and `curl https://…` cannot
  succeed without trusting that proxy's CA. The exact Dockerfile with its
  default base therefore cannot be built here. Local builds used `--build-arg
  NODE_IMAGE=local/node-ca:22` (the same digest-pinned node image plus the proxy
  CA and https apt sources). **The exact production build is done in CI** (§3a).
* Server version: before deploying, confirm the production server major is
  18 (§12 step 1). If it is ever upgraded to 19, rebuild with
  `--build-arg PG_MAJOR=19` (or change the default).

## 3a. Production image verification (exact Dockerfile, CI)

`.github/workflows/backend-image.yml` runs on every PR change under `backend/`.
It builds `docker build -f backend/Dockerfile backend` (App Platform's context,
the pinned base, no build args, no secrets) and records the image id. It then
runs `backend/scripts/ci/image-checks.sh` against the **final non-root
image**, and afterwards the full two-instance recovery drill with recovery
performed **from that image**. Results for the tested commit are recorded in
the PR and in `docs/dr-evidence/2026-10-25d-recoverability/`.

**Status at commit `f8dd090`:**
* **CI:** the workflow was created but GitHub never assigned a runner (3
  runs, 0 billable ms, no logs). The exact build has **not** run yet; see
  §15.
* **Local, image `sha256:b250ad6e…` (same Dockerfile, CA-trusting base, see
  §3):** `image-checks.sh` 17/17, and the full drill recovering from the image
  57/57 (`docs/dr-evidence/2026-10-25d-recoverability/`).

`image-checks.sh` covers:
non-root user; `pg_dump`/`pg_restore`/`psql`/`pg_dumpall` all major 18; Prisma
CLI available offline. Start path: a non-empty DB without migration history
gives P3005 and the server never starts; a baselined DB gives strict-TLS
`migrate deploy` with the DB CA, then "No pending migrations", then listening
on `$PORT`. Graceful SIGTERM. The **documented TLS command** `node
scripts/ops/tls-check.mjs` from the image (right CA passes, wrong CA fails, no
credentials in output; in CI also the real public endpoints
`fra1`/`ams3.digitaloceanspaces.com` incl. bucket host names, `api.resend.com`,
`www.google.com`). Finally a streaming backup → deep verify → materialize →
restore cycle from the image into a fresh cluster as a non-superuser admin.

## 4. Minimal App Spec patch (three phases)

Apply with `deploy/app-platform/apply-spec-patch.py`. It changes only the
listed fields of this one component and copies everything else unchanged:
other components, ingress, domains, alerts, every other env var, and every
encrypted `EV[...]` secret. It refuses input containing a plaintext secret,
refuses a backup bucket equal to the live bucket, and fails if the backup
secrets have not been added yet. Tested on a synthetic copy of the spec
(`deploy/app-platform/testdata/synthetic-current-spec.yaml`): secrets were
byte-identical, top-level keys were unchanged, and only the fields below
changed.

```bash
# from a trusted shell with doctl authenticated (never paste the spec into chats or tickets)
doctl apps spec get <app-id> > current.yaml
grep -n 'type: SECRET' -A1 current.yaml | grep -v 'EV\[' | grep value && echo "STOP: plaintext secret" || true
python3 deploy/app-platform/apply-spec-patch.py --phase 1 --schedule-cron "47 1 * * *" \
   --backup-endpoint https://ams3.digitaloceanspaces.com --backup-region ams3 \
   --backup-bucket tempworks-dr-backups current.yaml > phase1.yaml      # prints the diff
doctl apps update <app-id> --spec phase1.yaml
```

Phase 1, on the component only:

```diff
-  environment_slug: node-js
-  build_command: npm ci && npx prisma generate && npm run build && … find dist …
-  run_command: npx prisma migrate deploy && MAIN_FILE=$(find dist -name main.js | head -n 1) && … node "$MAIN_FILE"
+  dockerfile_path: backend/Dockerfile
   envs:
-  - key: PORT            # value 3000 (see §6)
+  - {key: BACKUP_ENGINE, value: stream}
+  - {key: BACKUP_SPACES_ENDPOINT, value: https://ams3.digitaloceanspaces.com}
+  - {key: BACKUP_SPACES_REGION, value: ams3}
+  - {key: BACKUP_SPACES_BUCKET, value: tempworks-dr-backups}
+  - {key: BACKUP_SPACES_PREFIX, value: dr/}
+  - {key: BACKUP_RETENTION_COUNT, value: "14"}
+  - {key: BACKUP_SCHEDULE_KIND, value: FULL_SYSTEM}
+  - {key: BACKUP_STALE_HOURS, value: "26"}
+  - {key: BACKUP_SCHEDULE_CRON, value: "47 1 * * *"}        # only if --schedule-cron given
+  - {key: BACKUP_SCHEDULE_TZ, value: Europe/Bratislava}
```

Phase 2: `NODE_ENV: development → production` (§7).
Phase 3: `+DATABASE_CA_CERT` (public CA PEM), `+DATABASE_TLS_STRICT_MIGRATIONS=1`,
`-NODE_TLS_REJECT_UNAUTHORIZED` (§8).

## 5. Environment variable changes (backend component)

| Variable | Now | Change | Type / scope | Phase |
|---|---|---|---|---|
| `BACKUP_SPACES_ACCESS_KEY` | — | **add in the console first**: `<backup-key-id>` | SECRET, RUN_TIME | 1 (before patch) |
| `BACKUP_SPACES_SECRET_KEY` | — | **add in the console first**: `<backup-key-secret>` | SECRET, RUN_TIME | 1 (before patch) |
| `BACKUP_ENGINE` | — | `stream` | GENERAL, RUN_TIME | 1 |
| `BACKUP_SPACES_ENDPOINT` / `_REGION` / `_BUCKET` / `_PREFIX` | — | `https://<region>.digitaloceanspaces.com` / `<region>` / `<backup-bucket>` / `dr/` | GENERAL | 1 |
| `BACKUP_RETENTION_COUNT` | (default 10) | `14` (newest full + newest verified are always kept as well) | GENERAL | 1 |
| `BACKUP_SCHEDULE_CRON` / `_TZ` / `_KIND` / `BACKUP_STALE_HOURS` | — | your choice, e.g. `47 1 * * *` / `Europe/Bratislava` / `FULL_SYSTEM` / `26` | GENERAL | 1, or after the first manual backup |
| `PORT` | `3000` | **delete** (App Platform then injects `PORT=8080` = `http_port`), see §6 | — | 1 |
| `NODE_ENV` | `development` | `production` | GENERAL | 2 |
| `DATABASE_CA_CERT` | — | PEM of the cluster CA (Databases → cluster → *Download CA certificate*; public) | GENERAL, RUN_TIME | 3 |
| `DATABASE_TLS_STRICT_MIGRATIONS` | — | `1` only if tls-check shows `[chain+hostname] ✓` | GENERAL | 3 |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` | **delete** after tls-check passes | — | 3 |
| `UPLOAD_DEST`, `DO_SPACES_*`, `DATABASE_URL`, JWT, mail | unchanged | — | — | — |

Optional tuning (defaults are what was measured): `DR_CONCURRENCY=4`,
`DR_MEM_OBJECT_MB=8`, `DR_PART_MB=8`, `DR_PART_INFLIGHT=2`,
`DR_GC_GRACE_HOURS=24`, `STORAGE_PURGE_GRACE_HOURS=24`.

## 6. PORT vs `http_port`

The spec sets `PORT=3000` while `http_port` is 8080. App Platform routes
traffic and health checks to `http_port`. The app listens on `$PORT`
(`main.ts`, default 3000). **Read-only check:** in the current runtime logs,
find `🚀 TempWorks API running on: http://localhost:<port>/api/v1`.

* `<port>` = **8080** → the env value is not taking effect. Deleting `PORT`
  (phase 1 default, `--port-mode delete-env`) changes nothing at runtime and
  removes the ambiguity.
* `<port>` = **3000** → traffic currently reaches 3000 through some other
  setting. Do **not** delete `PORT`. Run phase 1 with `--port-mode keep` and
  set `http_port: 3000` in the console instead.

The image was tested with `PORT=8080` injected: it listened on 8080 and the
start log showed `running on: http://localhost:8080`.

## 7. `NODE_ENV=production`

* The application reads `NODE_ENV` in exactly one place,
  `saas/tenancy/env-safety.ts`. That gate enables staging-only features only
  for localhost or staging hosts.
* Tested in the image with a managed-style DB host name and both values:
  `development → UNKNOWN`, `production → UNSAFE_PRODUCTION`, and
  `stagingFeatures=false` in both cases. The startup log showed **0 line
  differences**.
* Build dependencies do not depend on `NODE_ENV`: the build stage uses
  `--include=dev`. App Platform does not pass env vars into a Docker build
  unless the Dockerfile declares them as `ARG`.
* It is a separate phase, so it can be reverted alone.

## 8. TLS: replace `NODE_TLS_REJECT_UNAUTHORIZED=0` with real trust

Findings:

1. The app's own database connections already accept the managed DB without
   the global bypass: `sslmode=require` means encrypted but **unverified**. The
   global `NODE_TLS_REJECT_UNAUTHORIZED=0` therefore only weakens every other
   HTTPS call (Spaces, Resend, reCAPTCHA, document fetches).
2. New: with `DATABASE_CA_CERT`, the pool (`prisma/pg-ssl.ts`, now shared by
   `main.ts` and `PrismaService`) and the DR tools (libpq `PGSSLROOTCERT`)
   **verify** the chain. Tested: a wrong CA is refused.
3. **Prisma's migration engine ignores the Node adapter and the CA.** Tested: it
   connected through a wrong CA with `sslmode=require`. With
   `DATABASE_TLS_STRICT_MIGRATIONS=1` the entrypoint passes
   `sslcert=<CA>&sslaccept=strict` to `prisma migrate deploy` only. Tested:
   wrong CA → P1011 and the server does not start; correct CA → migrations run;
   host-name mismatch → P1011.

Local evidence: `docs/dr-evidence/2026-10-25c-app-platform/tls/` (16/16, private
test CA on PostgreSQL 18 with TLS).

**Production procedure (read-only first):** after phase 1 is live, open the
component **Console** and run

```bash
DATABASE_CA_CERT="$(cat <<'PEM'
<paste the cluster CA certificate>
PEM
)" node scripts/ops/tls-check.mjs
```

It checks the database (`app policy`, `chain`, `chain+hostname`), both Spaces
endpoints and bucket host names, `api.resend.com` and `www.google.com` with
verification forced on. It prints host names and verdicts only. Proceed to
phase 3 only if every line is ✓. If only `[chain+hostname]` fails, set
`DATABASE_TLS_STRICT_MIGRATIONS=0` and keep the URL at `sslmode=require` (the
chain is still verified).

## 9. Migration plan

* **Prisma migrations:** this candidate adds **no** new directory under
  `prisma/migrations` (13, unchanged). Run read-only first:
  `SELECT migration_name, finished_at IS NOT NULL AS applied, rolled_back_at FROM _prisma_migrations ORDER BY started_at;`
  You should see 13 applied rows. The image's `migrate deploy` then reports
  "No pending migrations" (tested on a baselined copy). On a non-empty
  database **without** migration history it fails with P3005 and the server
  does not start, which is the same as today (tested).
* **Outside Prisma, applied automatically at boot** (`PrismaService` drift-heal,
  idempotent, additive only; both instances may run them):
  ```sql
  ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "kind" TEXT;            -- + checksum, verifyResult,
  -- verifiedAt, restoreTestedAt, offsiteStatus, offsiteLocation (TEXT/TIMESTAMP(3)),
  ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "fileMissing" BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS "system_backups_kind_idx" ON "system_backups"("kind");
  CREATE TABLE IF NOT EXISTS "storage_purge_queue" ("id" TEXT PRIMARY KEY, "objectKey" TEXT NOT NULL, "originalRef" TEXT,
     "driver" TEXT NOT NULL, "legacyLocal" BOOLEAN NOT NULL DEFAULT false,
     "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT);
  CREATE INDEX IF NOT EXISTS "storage_purge_queue_requestedAt_idx" ON "storage_purge_queue"("requestedAt");
  CREATE TABLE IF NOT EXISTS "backup_schedule_claims" ("occurrence" TEXT PRIMARY KEY, "instance" TEXT NOT NULL,
     "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
  ```
  Each statement is caught and logged on failure and retried on the next boot.
  To avoid two instances racing on first boot, you may run them once yourself
  beforehand (optional).
* **`prisma/migrations/enhance_maintenance_records.sql`** (hand-written, not
  run automatically, fixed UUID→TEXT) is only needed if that feature's tables
  are missing in production. Check with
  `SELECT to_regclass('public.maintenance_records');` before considering it.
* **Rollback of schema:** none is needed. The additions are unused by the
  previous release.

## 10. Two instances — design and evidence

| Concern | How it is handled | Evidence (local, two backend processes on one DB + S3 simulator) |
|---|---|---|
| Duplicate scheduled runs | `backup_schedule_claims` INSERT … ON CONFLICT per occurrence (rounded to the minute); the loser logs and stands down. The hourly staleness alert is claimed the same way. | 3 occurrences → 3 claims, 3 backups, 3 stand-down log lines (`two-instance-schedule.json`) |
| Concurrent backup/restore | Exclusive advisory lock held for the whole job | 2nd request on the other instance → 503 |
| Purge vs backup, purge vs purge | Purge holds a purge lock plus the backup lock **shared**. A backup waits for a running purge (≤ 30 s), and a purge skips while a backup runs. | three T4 checks |
| Created on A, used on B | Bucket is authoritative: list/presence, deep verify, tar download and reconcile all work from either instance | T1–T3 (`two-instance-core.json`) |
| No false "missing" from local cache | Presence = `MANIFEST.json` in the bucket. If the bucket is unreachable, the state is "unknown", never "missing". | Both instances' local dirs wiped → still present on A and B, reconcile missing=0, download identical |
| Snapshots made outside the app | `reconcile` imports them | T5 |
| Redeploy (SIGTERM) | `enableShutdownHooks()`. The child engine is stopped, uncommitted files are deleted and the multipart upload aborted, the row is set FAILED over the lock connection, and the lock is released. | row FAILED in 0 s; nothing committed; next backup OK |
| Container kill (SIGKILL) | The engine aborts if its lock-holding parent disappears. PostgreSQL drops the dead session (keepalive 20 s + 3 × 10 s). The survivor's 2-minute reconcile sets the row FAILED. Retention GC removes the orphaned files after the grace period. | FAILED after 97–170 s; orphan GC check passed; next backup OK |
| Recovery after both instances' disks are gone | Restore from the bucket only | Full drill: source DB + live bucket + both instances' dirs destroyed → materialize → `restore.sh` → recovered app **51/51** checks, schema parity identical |

The advisory locks need a **session-level** connection. If `DATABASE_URL`
points at a PgBouncer pool in *transaction* mode (DigitalOcean pool port
25061), point the app at the direct port (25060) instead. Check which port the
URL uses (§12 step 1).

## 10a. Recoverability vs integrity, and missing files

| Status | Meaning | Engine exit | verify exit | Download | In-place restore | Retention |
|---|---|---|---|---|---|---|
| COMPLETED | every referenced file + every database prerequisite is in the backup | 0 | 0 | yes | yes | counts towards N; newest full + newest verified always kept |
| DEGRADED | consistent, but files referenced by the DB exist in **no checked source** | 6 | 6 (integrity OK) | yes | only with explicit `acceptDegraded` | kept as a partial only while newer than the last COMPLETE one; never displaces it |
| INCOMPLETE | a file changed/vanished during the backup (after retries), or prerequisites could not be captured | 4 | 6 (integrity OK) | yes | no | as DEGRADED |
| (integrity) | `verifyResult` FAILED = stored bytes do not match their checksums | 3 | 3 | — | no | — |

`restore.sh`/`verify.sh` refuse a non-COMPLETE package unless
`DR_ALLOW_INCOMPLETE=1` is set deliberately. Staleness alerts count only
COMPLETE backups, and they mention a newer partial one. A scheduled DEGRADED
backup raises an alert.

**A file is not declared missing on one listing.** Before a reference is
reported, the streaming engine checks:

1. every listing of the live bucket during the backup, plus a direct `HEAD`;
2. for legacy `/uploads/…` files, this instance's disk **and the inventories
   of every other instance**;
3. every earlier snapshot.

**An intact copy is not automatically the right version.** A copy found in
(2) or (3) proves its blob is intact, not that it is the version the captured
database references.

* **Proven** — and the file counts as recovered (`LIVE_STORAGE_MISSING_RECOVERED`,
  INFO) — only if it carries **version evidence**. The app's `StorageService`
  writes each object once, never overwrites it, uses a generated unique key,
  and records `x-amz-meta-tw-sha256` plus write-once and unique-key markers.
  The backup records these as `versionEvidence` when the recorded hash
  matches the content.
* **Candidates** are every other copy: all legacy `/uploads` files (local
  disks can be rewritten), every other-instance inventory, and objects written
  before this change or out of band. They are **kept** in the backup with
  `versionVerified: false` and their source, and are disclosed as
  `FILES_VERSION_UNVERIFIED`. The backup stays **DEGRADED**.

Files found nowhere are listed with the evidence of what was checked (instance
names, paths, times, number of snapshots searched) → DEGRADED.

Limitation: the guarantee is application-level. An out-of-band overwrite that
also forges the metadata hash is not detectable without a hash stored with
the database reference; there is no such column today.

## 10b. Database prerequisites (roles, ownership, grants, extensions)

What a restored database needs that `pg_dump` does not contain is the
**roles** it refers to: the database and object owners, every ACL grantee
(table, column, schema, function, type, default privileges), RLS policy roles,
the role the app connects as, and the membership closure of those. It also
needs their attributes, memberships and cluster-wide role settings, and it
needs the extensions and tablespaces it uses. `lib/prereqs.sql` reads these
from catalogs every role can read, so it works where managed providers refuse
`pg_dumpall --globals-only`. The output goes to `database/prerequisites.json`
and `database/roles.sql` (never passwords). If it cannot be captured, the
backup is **INCOMPLETE** (`PREREQ_CAPTURE_FAILED`, with the reason).

`restore.sh --roles` recreates them. It works as a superuser, and also as a
**non-superuser `CREATEROLE` admin** like DigitalOcean's `doadmin`: on PG ≥ 16
it sets `createrole_self_grant='set, inherit'` so ownership can be restored.
Attributes only a superuser can grant are reported as warnings. Before
anything is created on the target it checks:

* every required role exists or was just created;
* provider-managed roles (`doadmin`, `postgres`, …) exist or are mapped with
  `--role-map doadmin:<role>`;
* the target offers every required extension.

Otherwise it aborts with the exact missing item and what to do. LOGIN roles
get their passwords from the secret store afterwards.

Proven on fresh `initdb` clusters (`scripts/dr/tests/prereq-restore-test.sh`,
28/28). The source was managed-shaped: CONNECT on postgres/template1 revoked,
so `pg_dumpall` was refused. It had an owner group role, a login app role with
a role setting, a read-only role with grants, a column grant, default
privileges, an RLS policy, `pgcrypto`, and an unrelated role that must **not**
be recreated. Results:

* Restore as non-superuser `dbadmin` → roles, attributes, memberships,
  settings, ownership, grants, default privileges, policy and extension all
  intact. The app role logs in with the secret-store password, writes data and
  alters schema.
* A `doadmin`-owned source → refused without a mapping, restored correctly
  with `--role-map doadmin:tw_recovered`.
* Missing roles without `--roles` → aborted before the target was touched.

## 11. Resource limits — measured

Dataset: 324 MB database (incompressible filler, worst case for the dump) +
300 × 2 MiB files (600 MiB), plus 3 × 40 MiB files in the incremental run.

| Run | Peak temp disk | Peak memory | Result |
|---|---|---|---|
| Old staging engine, unconstrained host | **1885 MiB** | **1987 MiB** RSS | OK, 174 s |
| Old staging engine, **1 GiB container** | 1064 MiB before kill | limit hit | **OOM-killed (exit 137)** |
| Stream engine, first full (host) | 0 | 233 MiB | OK, 53 s |
| Stream engine, incremental with 3 × 40 MiB new files | 120 MiB (spill = 3 workers × 40 MiB) | 269 MiB | OK, 47 s; 120 MB sent, 600 MB reused |
| Stream engine **inside the running app container (1 GiB, 1 vCPU)** | 1.3 MiB | **267 MiB for the whole container** (app + engine + pg_dump + pg_restore) | OK; app kept serving |
| Deep verify / tar export | 0 / 0 | 130 / 124 MiB | OK |

Bounds that hold regardless of dataset size:
* memory ≈ app + engine (~120 MB) + `DR_PART_MB × (DR_PART_INFLIGHT+2)` +
  `DR_CONCURRENCY × DR_MEM_OBJECT_MB` + ~200 bytes per stored object (listing maps)
* temp disk ≤ `DR_CONCURRENCY ×` the largest single upload above
  `DR_MEM_OBJECT_MB` (app uploads are ≤ 20 MiB, so ≤ 80 MiB)
* Duration grows with the size of the database plus *changed* files only.
  Watch it in the first production runs.

## 11a. Production validation

The single ordered checklist (read-only checks, per-instance legacy
inventory, off-site storage, the real-Spaces test, the first backup, the
isolated restore and the post-restore check) is
**[PRODUCTION_VALIDATION_CHECKLIST.md](PRODUCTION_VALIDATION_CHECKLIST.md)**.

## 12. Deployment steps (each step has a stop point)

1. **Read-only checks** in the current component's Console (the buildpack image
   has `psql`):
   `psql "$DATABASE_URL" -Atc "SHOW server_version"` (expect 18.x);
   the `_prisma_migrations` query (§9); the **cross-tenant grant gate query**
   from `docs/security/TENANT_FILE_ISOLATION_FIX.md` (0 → deploy as is;
   > 0 → decide first). Show only the connection fields that are safe to
   print, by parsing the URL (no user name, password or query secrets):
   ```bash
   node -e 'const u=new URL(process.env.DATABASE_URL);console.log(JSON.stringify({host:u.hostname,port:u.port||"5432",database:u.pathname.slice(1),sslmode:u.searchParams.get("sslmode")}))'
   ```
   (the port must be 25060, direct, see §10). Also check the PORT log line
   (§6), the roles the database needs (`psql "$DATABASE_URL" -Atf
   backend/scripts/dr/lib/prereqs.sql` prints them; it lists **no
   passwords**), and `SELECT count(*) FROM documents WHERE "fileUrl" LIKE
   '/uploads/%';` (legacy local files, see §10a: they make backups **DEGRADED**
   unless some instance still has them).
2. Create the backup bucket and key (§2). **Stop** if you prefer a different
   region or provider.
3. Review and merge the PR into `main`. With deploy-on-push this redeploys
   **with the buildpack**, because the spec is not changed yet. Watch the
   deploy: the app must start as before. The new code works under the
   buildpack, but backups stay disabled for this step (no `BACKUP_SPACES_*` yet).
4. Add the two SECRET env vars in the console (`BACKUP_SPACES_ACCESS_KEY`,
   `BACKUP_SPACES_SECRET_KEY`). Then phase 1 (§4): `doctl apps update` → App
   Platform builds `backend/Dockerfile`. Watch: build log, the
   `[entrypoint] … pg_dump (PostgreSQL) 18.x` line, `No pending migrations`,
   `running on … :8080`, health green on both instances.
5. Settings → Database Backup: the preflight banner must be green (checks
   bucket write/read/delete, listing, live-bucket access, separate credentials,
   temp disk).
6. **First production backup** (§13).
7. tls-check (§8) → phase 3. Phase 2 (`NODE_ENV`) can go before or after; each
   is a single env change.
8. Enable the schedule (if it was not set in phase 1) and watch the first two
   scheduled runs and the staleness status.

## 13. First production backup and isolated restore

1. If step 1 found legacy `/uploads/…` references: call `POST
   /api/v1/backup/legacy-inventory` (System Admin token) **repeatedly until
   every running instance has answered**. Each response names the instance
   that served it. This records whatever each instance still has on its disk.
2. UI → Create Backup → **Full system**. Two separate verdicts:
   * **Integrity** "Integrity verified": the engine re-read the stored dump,
     parsed it with `pg_restore` and checked every blob.
   * **Status**:
     * **COMPLETED** — the backup is a complete recovery point.
     * **DEGRADED** — consistent, but the listed files exist in no source. The
       UI shows each issue with its count and action, and
       `uploads.refcheck.json` has the evidence per file. Work through the
       runbook's *Missing files* section; this is not a complete backup.
     * **INCOMPLETE** — back up again.
3. From the **other** instance (reload until the other instance serves you,
   or simply later): click **Verify integrity**. That is a deep re-hash of
   every blob.
4. **Isolated restore** on the recovery host (§2 #3), never on production:
   ```bash
   # on the temporary droplet: PostgreSQL 18 server + client, node 22, git
   git clone <repo> && cd repo/backend && git checkout <tested commit> && npm ci
   export BACKUP_SPACES_ENDPOINT=… BACKUP_SPACES_REGION=… BACKUP_SPACES_BUCKET=… BACKUP_SPACES_PREFIX=dr/
   export BACKUP_SPACES_ACCESS_KEY=… BACKUP_SPACES_SECRET_KEY=…    # read-only key is enough here
   bash scripts/dr/snapshot.sh list
   bash scripts/dr/snapshot.sh verify <package> --deep
   bash scripts/dr/snapshot.sh materialize <package> /srv/restore
   # restore as a NON-superuser admin, as on a managed target (no source roles exist yet):
   sudo -u postgres psql -c "CREATE ROLE dbadmin LOGIN CREATEROLE CREATEDB PASSWORD '<from your secret store>'"
   UPLOAD_STORAGE_DRIVER=local bash scripts/dr/restore.sh /srv/restore/<package> \
     --target-url postgresql://dbadmin:<pw>@127.0.0.1:5432/tempworks_restore --create-db --roles \
     --uploads-dest /srv/restore-uploads --yes
   # restore.sh recreates the required roles WITHOUT passwords and prints the
   # ALTER ROLE … PASSWORD statements to run with values from the secret store.
   # If it stops because the source owner is a provider-managed role (DigitalOcean
   # "doadmin"), re-run with  --role-map doadmin:<local role>  (keeps ownership and
   # grants under the new name) — runbook §7. --no-owner is the last resort.
   ```
   `restore.sh` verifies before touching the target, then checks tables, row
   counts, ownership, sequences and files. Then start the app on the droplet
   against `tempworks_restore` with mail disabled, bound to localhost, and
   smoke-test it over an SSH tunnel. Destroy the droplet afterwards. Record the
   result. Only then is the backup **restore-tested**.

## 14. Rollback

* After step 3 (code only): revert the merge on `main`. Deploy-on-push
  redeploys the previous code. The schema additions are harmless to it.
* After phase 1: in the console, set the component back to buildpack: restore
  `environment_slug: node-js`, the original `build_command` and `run_command`,
  and `PORT=3000` (all recorded in `current.yaml`), or
  `doctl apps update <app-id> --spec current.yaml`. The secrets in it are the
  same EV values.
* Phase 2/3: change the single env var back (`NODE_ENV=development`, or re-add
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, or set `DATABASE_TLS_STRICT_MIGRATIONS=0`).
* App Platform also keeps the previous deployment. *Rollback to this
  deployment* restores code + spec in one action.
* Backups already in the backup bucket remain valid and restorable with
  `snapshot.sh` on any host.

## 15. Not verified here / residual risks

* **Real DigitalOcean Spaces** (multipart uploads, listing, `DeleteObjects`,
  checksum headers) and **real App Platform** (build, SIGTERM timing, health
  checks) were not tested. The S3 client sends checksums only when required,
  for compatibility. Step 6 is the first real test.
* **The exact production image has not been built yet** (§3 and §3a):
  * Here, every outbound TLS connection from a build container is re-signed
    by the sandbox egress gateway ("Egress Gateway SDS Issuing CA"). Without
    an override, the PGDG key download in the Dockerfile fails with curl
    exit 60.
  * In GitHub Actions, all three runs were refused before start. Each job's
    check-run annotation reads: *"The job was not started because recent
    account payments have failed or your spending limit needs to be
    increased. Please check the 'Billing & plans' section in your settings"*
    (0 billable ms, empty log archive). **Owner action:** the account owner
    must, at *Settings → Billing and plans*, fix the payment method or raise
    the Actions spending limit, then start *Actions → backend-image → Run
    workflow* once. The workflow is manual-only, so pushes create no more
    doomed runs. Alternatively, run the same script on any Docker host:
    `bash backend/scripts/ci/verify-production-image.sh --install-prereqs`.
  * Everything else ran on the image built from the same Dockerfile with
    only the base swapped for a CA-trusting copy of the same digest.
* **Production data:** how many references will be unresolved (legacy
  `/uploads/…` files lost on earlier deployments' disks) is unknown until the
  first production backup and the per-instance legacy inventory (§13). If
  any are unresolved, the first production backups will be **DEGRADED, not
  complete**.
* **Public objects:** uploads are stored `public-read`, and anyone with a file
  URL can fetch it. This is unchanged and tracked in issue #66.
* **Attachment tenant fix:** run the gate query first (step 1).
* No PITR: the recovery point is the newest snapshot (schedule interval).
  DigitalOcean's own managed-DB backups remain an additional layer.
