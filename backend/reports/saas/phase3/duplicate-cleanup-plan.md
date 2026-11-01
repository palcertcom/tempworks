# SaaS Phase 3.2 — Duplicate cleanup plan (dry-run)

Generated: 2026-05-11T08:41:06.725Z
Classification: **SAFE_CLONE**
Target: local (localhost)
Read-only: **true**

Emails are **masked** in this MD report. The companion JSON keeps full values for the apply step.

## Buckets

- **exact**: 3
- **conflicting_active**: 1
- **null_tenant_assignment_required**: 1
- **cross_tenant_observation**: 1

Planned soft-deletes: **3**

## Groups

| table | column | key (masked) | tenantId | bucket | keep | soft-delete |
| --- | --- | --- | --- | --- | --- | --- |
| employees | email | c***@e.com | 11111111-1111-1111-1111-111111111111 | conflicting_active | 00000000 | — |
| employees | email | e***@e.com | 11111111-1111-1111-1111-111111111111 | exact | 00000000 | 00000000 |
| employees | employeeNumber | emp-320 | 11111111-1111-1111-1111-111111111111 | exact | 00000000 | 00000000 |
| applicants | email | e***@a.com | 11111111-1111-1111-1111-111111111111 | exact | 00000000 | 00000000 |
| employees | email | n***@e.com | ∅ | null_tenant_assignment_required | — | — |
| employees | email | x***@e.com | ∅ | cross_tenant_observation | — | — |

## Snapshot SQL

Run BEFORE apply to capture rows touched. Pipe to a file.

```sql
-- Snapshot employees affected by phase320-duplicate-cleanup
SELECT * FROM "employees" WHERE id IN ('00000000-0000-0000-0000-0000000032E2', '00000000-0000-0000-0000-0000000032E1', '00000000-0000-0000-0000-0000000032N2', '00000000-0000-0000-0000-0000000032N1');
-- Snapshot applicants affected by phase320-duplicate-cleanup
SELECT * FROM "applicants" WHERE id IN ('00000000-0000-0000-0000-0000000032A2', '00000000-0000-0000-0000-0000000032A1');
```

## Apply gates

- `PHASE3_DUPLICATE_CLEANUP_ENABLED=true`
- `PHASE3_DUPLICATE_CLEANUP_APPLY=true`
- Runtime classification must be `SAFE_CLONE` or `SAFE_STAGING`

Apply is soft-delete only. Hard-delete is not implemented. Conflicting/active groups are never mutated.
