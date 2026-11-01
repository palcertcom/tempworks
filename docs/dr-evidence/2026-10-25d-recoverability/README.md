# Evidence: recoverability, database prerequisites, final image (2026-10-25)

**Tested commit:** `f8dd090c29aaa6863acdb6781f718de0d255d9e1` on
`claude/review-dr-app-platform`. The commit that adds this folder adds
evidence files only.

**Tested image:** `sha256:b250ad6e568cc0cab4a4c32e274e9ae3f3a59f767a030f4f3432fccf55b2067b`
(label `org.opencontainers.image.revision=f8dd090…`), user `node`. It was
built from `backend/Dockerfile` at that commit with **one** difference from
production: `--build-arg NODE_IMAGE=local/node-ca:22`. That is the same
digest-pinned `node:22-bookworm-slim` plus this sandbox's egress CA and https
apt sources; see *Limitations*. Every container test below used this image.

Everything is LOCAL: PostgreSQL 18 clusters (fresh `initdb` per target), the
s3rver S3 **simulator** (not DigitalOcean Spaces), Docker on this host.
Nothing was deployed and no production resource was touched.

## Root causes and fixes

| Finding | Root cause | Fix |
|---|---|---|
| A checksum-valid partial backup could look complete | `dangling` references (files absent from storage) did not affect `complete`. Integrity and completeness were one flag. | Two separate verdicts everywhere. **Integrity** (`verifyResult`, verify exit 3) and **recoverability** COMPLETE / DEGRADED (exit 6) / INCOMPLETE (exit 4) appear in the manifest, `verify`, API, UI, reconcile/import, retention, scheduled alerts and staleness. Partial backups stay downloadable. DEGRADED needs explicit acceptance to restore. Retention keeps partials separately and never lets one displace the last COMPLETE backup. |
| A file was called missing after one listing on one instance | The stream engine looked only at this instance's disk and the live listing | Before declaring a file missing, the engine checks a direct HEAD, **other instances' legacy inventories** (new `legacy-inventory` command and `POST /backup/legacy-inventory`) and **every earlier snapshot**. Found files are included with `recoveredFrom`. Unresolved ones are listed with per-file evidence. |
| Staging engine reported a file deleted during the backup as pre-existing | Each retry compared against that attempt's own listing only | Keys seen across all attempts are unioned; such a file is a race → INCOMPLETE |
| Missing `pg_dumpall` output could still give "complete" | When `pg_dumpall` was refused, `globals.sql` was left empty with a warning | `lib/prereqs.sql` captures the **required** roles (owners, grantees incl. column / default privileges, RLS roles, the connecting role, membership closure) with attributes, memberships and settings, plus extensions and tablespaces, from catalogs any role can read. Capture failure → INCOMPLETE (`PREREQ_CAPTURE_FAILED`). `restore.sh --roles` recreates them, also as a non-superuser `CREATEROLE` admin (`createrole_self_grant`). It aborts before touching the target if anything is missing, and maps provider roles (`--role-map`). |
| `scripts/ops/tls-check.mjs` was not in the image | The Dockerfile copied only `scripts/dr` | It now copies `scripts/ops`. The entrypoint runs an explicit command, e.g. `node scripts/ops/tls-check.mjs`, instead of the server. |
| Restored DB without migration history is refused at start | The drill source was built with `prisma db push` (no `_prisma_migrations`). The image's `migrate deploy` returned P3005, which is correct behaviour. | The drill source is now baselined like production (where every deploy runs `migrate deploy`). The P3005 refusal is kept as an explicit test. |
| Unsafe masking command in the docs | `sed` masking of `DATABASE_URL` could leak parts of it | Replaced by URL parsing that prints only host, port, database and sslmode |

## Commands executed and results (all on the tested commit / image)

| Command | Result |
|---|---|
| `bash backend/scripts/ci/image-checks.sh tempworks-backend:candidate …` | **17/17** — `image-checks.out.txt`, `image-checks/` |
| `node backend/scripts/dr/perf/stream-race-test.mjs …` (perf env, S3 sim) | all checks passed, incl. new cases D (DEGRADED + evidence + verify exit 6), D2 (recovered from an earlier snapshot), D4/D3 (legacy file on another instance: DEGRADED until that instance's inventory exists, then COMPLETE), R (retention keeps the last COMPLETE plus a newer DEGRADED) — `stream-race.out.txt`, `race/` |
| `bash backend/scripts/dr/tests/prereq-restore-test.sh …` | **28/28** — fresh clusters, pg_dumpall refused, restore as non-superuser `dbadmin`, `doadmin` role map, negative cases — `prereq.out.txt`, `prereq/` |
| `bash backend/scripts/dr/dr-selftest.sh` (staging engine) | **67/67** (63 earlier + 4 DEGRADED checks) — `selftest.out.txt` |
| `IMG=… bash backend/scripts/ops/tls-local-test.sh …` | **16/16** — `tls.out.txt` |
| `npx ts-node … storage-integrity-harness.ts` | 10/10 (local driver) |
| `bash backend/scripts/migrations/verify-maintenance-migration.sh` | 19/19 |
| `DRILL_RECOVER_IMAGE=tempworks-backend:candidate bash backend/scripts/dr/drill/two-instance.sh all` | **RECOVERY DRILL PASSED — 57/57** — `drill/` |

The full drill ran in the production shape:

* two app instances and a managed-provider source: CONNECT revoked, so the app
  role's `pg_dumpall` was **refused**, and the migration history was baselined;
* concurrency, schedule de-duplication, SIGTERM and SIGKILL, then disaster:
  the source DB, the live bucket and both instances' disks were destroyed.

Recovery used **only the image**:

* the snapshot was deep-verified and materialized from the backup bucket;
* the target was a **fresh** PostgreSQL 18 cluster with 0 source roles;
* `restore.sh` ran from the image as **non-superuser `dbadmin`** into an
  **empty** bucket (0 objects before);
* the app role's password was set from the secret store;
* the backend ran from the image (`migrate deploy` → "No pending migrations"
  → server), as non-root.

The recovered app was then verified on:

* database objects and data;
* schema parity with the source (identical);
* required roles and permissions, ownership, grants, FK/unique constraints,
  sequences;
* all 8 files, by count and SHA-256;
* authentication (original passwords, wrong password and cross-tenant login
  rejected, read-only user denied);
* tenant isolation, attachment downloads (byte-identical, cross-tenant denied,
  ZIP filtering);
* new writes and uploads, and the UI flows.

The backup it recovered from was **COMPLETE** even though `pg_dumpall` was
refused: its roles came from the catalog.

## Limitations (exact)

* **Exact image, local:** every TLS connection from a container on this host
  is re-signed by the sandbox gateway (`issuer: O=Anthropic, CN=Egress
  Gateway SDS Issuing CA (production)`, `SELF_SIGNED_CERT_IN_CHAIN`). The
  unmodified build therefore stops at the PGDG key download in the runtime
  stage (`curl` exit 60) — `exact-build-attempt.log`. `apt`
  over HTTP and npm succeed.
* **Exact image, CI:** `.github/workflows/backend-image.yml` (build of the
  unmodified Dockerfile + `image-checks.sh` with real public endpoints + the
  full drill from that image) was triggered three times (runs 40201541345,
  40201646973, 40204031823). Each job was created but **never assigned a
  runner**: runner_id 0, about 2 s, 0 billable ms, no log, empty check output.
  The production image has therefore **not** been built or verified in CI.
  Check the repository's Actions availability (Settings → Billing → Actions
  spending limit / payment; Settings → Actions → General), then re-run the
  workflow. No change is needed.
* **Real Spaces / App Platform / production DB:** not exercised (see
  `docs/APP_PLATFORM_DEPLOYMENT.md` §12–§15 for the production-only checks).
