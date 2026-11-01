# SaaS Phase 3.0 — Per-tenant uniqueness duplicate report

Generated: 2026-05-11T08:41:23.297Z

Read-only: **true**

**Blocking duplicate groups: 4**

## 1. Employee.email duplicates within same tenant

Total groups: **1**

| key | tenantId | count | first ids |
| --- | --- | --- | --- |
| dup@e.com | 11111111-1111-1111-1111-111111111111 | 2 | 00000000-0000-0000-0000-0000000300e2, 00000000-0000-0000-0000-0000000300e1 |

## 2. Employee.email duplicates where tenantId IS NULL

Total groups: **1**

| key | tenantId | count | first ids |
| --- | --- | --- | --- |
| dup-null@e.com | ∅ | 2 | 00000000-0000-0000-0000-0000000300z1, 00000000-0000-0000-0000-0000000300z2 |

## 3. Applicant.email duplicates within same tenant

Total groups: **1**

| key | tenantId | count | first ids |
| --- | --- | --- | --- |
| dup@a.com | 11111111-1111-1111-1111-111111111111 | 2 | 00000000-0000-0000-0000-0000000300a1, 00000000-0000-0000-0000-0000000300a2 |

## 4. Applicant.email duplicates where tenantId IS NULL

Total groups: **0**

_No duplicates detected._

## 5. Employee.employeeNumber duplicates within same tenant

Total groups: **1**

| key | tenantId | count | first ids |
| --- | --- | --- | --- |
| emp-300 | 11111111-1111-1111-1111-111111111111 | 2 | 00000000-0000-0000-0000-0000000300n1, 00000000-0000-0000-0000-0000000300n2 |

## 6. Employee.employeeNumber duplicates where tenantId IS NULL

Total groups: **0**

_No duplicates detected._

## 7. Cross-tenant same-email observations (informational; NOT blocking per-tenant uniqueness)

Total groups: **1**

> Same email appearing under multiple tenants is allowed under per-tenant uniqueness if the User/login model is global. No action required unless product decides otherwise.

| key | tenantId | count | first ids |
| --- | --- | --- | --- |
| [employees] xt@e.com | ∅ | 2 | 11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222 |

## 8. Suggested cleanup actions

- Resolve same-tenant Employee.email collisions before adding @@unique([tenantId, email]).
- Backfill tenantId on NULL-tenant Employee rows (Phase 2 backfill pipeline) before enforcing uniqueness.
- Triage Applicant.email duplicates within tenant (likely re-applications); decide merge vs. keep both before constraint.
- Resolve Employee.employeeNumber collisions (likely sequence reuse) before adding @@unique([tenantId, employeeNumber]).
- Cross-tenant duplicates are informational; allowed if User.email remains global-unique.
