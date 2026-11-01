# Phase 2.51 — cross-module audit-log tenant backfill

Generated: 2026-05-10T17:37:53.114Z
Mode: **apply**
Classification: SAFE_CLONE

## Totals

| Field | Value |
|---|---:|
| candidateRows | 0 |
| updatedRows | 0 |
| skippedAlreadyTenantStamped | 95 |
| skippedMissingTarget | 82 |
| skippedTargetWithoutTenant | 9 |
| skippedWrongEntity | 0 |
| skippedAmbiguous | 0 |

## By entity

| Entity | candidate | updated | already-stamped | missing-target | target-no-tenant | before-NULL | after-NULL |
|---|---:|---:|---:|---:|---:|---:|---:|
| Document | 0 | 0 | 39 | 1 | 7 | 8 | 8 |
| FinancialRecord | 0 | 0 | 48 | 1 | 0 | 1 | 1 |
| WorkPermit | 0 | 0 | 2 | 39 | 0 | 39 | 39 |
| Visa | 0 | 0 | 2 | 39 | 0 | 39 | 39 |
| ComplianceAlert | 0 | 0 | 2 | 1 | 1 | 2 | 2 |
| Notification | 0 | 0 | 2 | 1 | 1 | 2 | 2 |
