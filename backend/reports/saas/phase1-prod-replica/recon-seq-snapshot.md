# Phase 1 — Identifier Sequence Snapshot

- **Mode:** `dry-run`
- **Status:** **OK**
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **Started:** 2026-05-09T14:53:18.173Z
- **Duration:** 34 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `identifier_sequences.global-rows` | 2 |  |
| `snapshot.projected-rows` | 0 |  |
| `snapshot.cross-source-conflicts` | 0 |  |

## Actions

| Kind | Applied | Proposed | Subject |
|------|---------|----------|---------|
| `seq.proposed-phase2-sql` | no | apply via Phase 2 migration after `tenantId` column lands on identifier_sequences | {"sample":"","totalRows":0} |

## Notes
- This script does NOT mutate identifier_sequences itself. The Phase 2 cutover migration consumes saas_phase1_seq_snapshot to seed per-tenant counters.
- If projected-rows == 0 but global-rows > 0, the source tables may not yet have tenantId populated — run the dry-run-tenant-backfill --apply on staging first.
