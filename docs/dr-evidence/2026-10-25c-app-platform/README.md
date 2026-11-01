# Evidence — App Platform preparation (2026-10-25)

All runs are LOCAL: PostgreSQL 18 + the s3rver S3 SIMULATOR (not DigitalOcean
Spaces), Docker on this sandbox (not App Platform). Nothing was deployed.

Tested code: commit `db6bbe6` on `claude/review-dr-app-platform` (the commit
that adds this README only adds evidence files).

| Dir | What | Result |
|---|---|---|
| `perf/` | peak temp disk + RSS: staging engine vs stream engine (324 MB DB + 600 MiB files) | staging 1885 MiB disk / 1987 MiB RSS; stream 0–120 MiB disk / 233–269 MiB RSS |
| `container/` | production image, 1 GiB / 1 vCPU: migrate semantics, NODE_ENV, backup inside the running app | stream 261 MiB whole-container RSS, no OOM; staging OOM-killed (137) |
| `race/` | stream engine races: overwrite, delete, transient delete, dangling ref, SIGTERM, busy, retention+GC | all checks passed |
| `two-instance/` | full drill, two app instances: A/B create-list-verify-download, wiped disks, purge locks, import, schedule dedupe, SIGTERM/SIGKILL, disaster → recovery | recovery 51/51, schema identical |
| `tls/` | private-CA TLS: app pool, Prisma migration engine, entrypoint strict mode, libpq DR tools | 16/16 |

Also on this commit: `dr-selftest.sh` 63/63, `verify-maintenance-migration.sh`
19/19, storage integrity harness 10/10 (local path).
