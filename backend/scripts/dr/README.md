# TempWorks Disaster-Recovery toolkit

Standalone backup/restore tooling. It depends only on a POSIX shell,
coreutils, `python3`, and the PostgreSQL client tools — **not** on the NestJS
app or the backup-catalog database — so it keeps working on a clean replacement
server where all you have is the DR package and an empty PostgreSQL instance.

| Script | Purpose |
|---|---|
| `preflight.sh` | Go/no-go checks: toolchain version compatibility, connectivity, dump permission, destination writability, storage capacity. |
| `backup.sh` | Produce a portable DR package: `pg_dumpall` globals + `pg_dump -Fc` (owners/ACLs/RLS/large objects) + uploaded files + manifest + SHA-256 checksums. Atomic (temp → publish). `--kind database\|full`, `--offsite`. |
| `restore.sh` | Restore a package onto a **clean** server (roles, database, data, uploads). Verifies integrity first; fails loudly (`--exit-on-error`); never reports success on a partial restore. |
| `verify.sh` | Integrity-verify a package without restoring (checksums + `pg_restore --list` + per-file upload hashes). |
| `spaces-sync.mjs` | Object-storage side: mirror the app bucket into a package / push it back / upload a package off-site. Uses `@aws-sdk/client-s3`. |
| `snapshot.sh` + `snapshot-engine.mjs` | **Streaming engine** for small-disk / multi-instance hosts (App Platform): pg_dump streamed to a separate backup bucket, content-addressed incremental file blobs, MANIFEST committed last, remote verify, `export` (tar), `materialize` (package dir for `restore.sh`), retention + GC. Bounded memory/disk (measured: see `docs/APP_PLATFORM_DEPLOYMENT.md` §11). |
| `perf/` | `measure.sh` (peak disk/RSS), `perf-env.sh` (production-shaped dataset), `stream-race-test.mjs` (8 race/failure cases), `container-test.sh` (image under 1 GiB / 1 vCPU). |
| `drill/two-instance.sh` | Full drill in the production shape: two app instances, stream engine, schedule dedupe, SIGTERM/SIGKILL, recovery after both instances' disks are gone. |
| `dr-selftest.sh` | Hermetic end-to-end proof: spins two throwaway PG18 clusters, backs up one, restores onto the clean other, and asserts full recovery + negative cases. |

## Full application drill (`drill/`)

`drill/drill.sh all` rebuilds the **whole application** twice on one machine and
proves recovery end to end: a SOURCE stack (PostgreSQL 18, backend, web front,
object storage) is set up with the real setup process, multi-tenant data and
files are created through the API, a full-system backup is triggered from the
**admin UI**, concurrency and scheduling are tested, then the source is stopped
and its server state + storage destroyed. A separate RECOVERY stack is built
from the off-site copies (backup package + release artifact) and a secret store
only, and verified through its UI, API, database and storage.

Object storage in the drill is a **local S3-compatible simulation (s3rver)**: it
exercises the real AWS-SDK code paths but is **not** DigitalOcean Spaces.
Requirements: PostgreSQL 18 (server+client), Node 22, Playwright/Chromium, npm
registry access. Phases can be run individually (`drill.sh <phase>`).

## The version-mismatch fix
`pg_dump` refuses to dump a server whose **major version is newer** than the
client (production: server 18.6 vs pg_dump 17.7). The toolkit auto-selects the
newest installed client whose major ≥ the server (honours `PG_BIN_PATH`), and
`preflight.sh` fails fast with an actionable message if none is adequate.
Install a version-correct client with
[`deploy/provision-postgres-client-18.sh`](../../../deploy/provision-postgres-client-18.sh).

## Quick start
```bash
export DATABASE_URL='postgresql://user:pass@host:5432/tempworks?sslmode=require'
export BACKUP_DIR=/var/lib/tempworks/backups
./preflight.sh --backup-dir "$BACKUP_DIR"
./backup.sh --kind full --label nightly --offsite
./verify.sh "$BACKUP_DIR"/tempworks-dr_*
./restore.sh "$BACKUP_DIR"/tempworks-dr_*.tar.gz --target-url "$TARGET_DATABASE_URL" --create-db --roles --uploads-dest /var/lib/tempworks/uploads
```

Full procedure: [`docs/DISASTER_RECOVERY_RUNBOOK.md`](../../../docs/DISASTER_RECOVERY_RUNBOOK.md).
