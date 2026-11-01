# SaaS Phase 3.1 — Tenant backfill completeness report

Generated: 2026-05-11T08:41:17.239Z
Classification: **SAFE_CLONE**
Target: local (localhost)
Read-only: **true**

## Employee

- total rows: **12**
- tenantId IS NULL: **2**
- tenantId NOT NULL: **10**
- blocks Phase 3.3 unique constraints: **true**

| status | total | null-tenant |
| --- | --- | --- |
| PENDING | 10 | 2 |
| ACTIVE | 2 | 0 |

Sample NULL-tenant ids (no PII): 03146b8f-4dd9-4073-847b-f9c1e5ed4a6f, 43f2c6d6-cc66-4bb7-a8d3-d2e31a3fd488

## Applicant

- total rows: **4**
- tenantId IS NULL: **0**
- tenantId NOT NULL: **4**
- blocks Phase 3.3 unique constraints: **false**

| status | total | null-tenant |
| --- | --- | --- |
| NEW | 2 | 0 |
| ACCEPTED | 2 | 0 |

## Summary

- blocks Phase 3.2 cleanup: **true**
- blocks Phase 3.3 unique constraints: **true**
