# SaaS Phase 3.1 — Production-shaped duplicate scan

Generated: 2026-05-11T08:41:18.658Z
Classification: **SAFE_CLONE**
Target: local (localhost)
Read-only: **true**

**Blocking duplicate groups: 0**
Cross-tenant observation groups: 0 (informational only — NOT blocking under per-tenant uniqueness)

Emails are **masked** in this MD report (e.g. `j***@example.com`). The companion JSON keeps full values for cleanup tooling.

## 1. Employee.email duplicates within same tenant

Total groups: **0**

_No duplicates detected._

## 2. Employee.email duplicates where tenantId IS NULL

Total groups: **0**

_No duplicates detected._

## 3. Applicant.email duplicates within same tenant

Total groups: **0**

_No duplicates detected._

## 4. Applicant.email duplicates where tenantId IS NULL

Total groups: **0**

_No duplicates detected._

## 5. Employee.employeeNumber duplicates within same tenant

Total groups: **0**

_No duplicates detected._

## 6. Employee.employeeNumber duplicates where tenantId IS NULL

Total groups: **0**

_No duplicates detected._

## 7. Cross-tenant same-email observations (NOT blocking)

Total groups: **0**

_No duplicates detected._

## 8. Blocking duplicate count

**0** blocking duplicate groups (sections 1-6).

## 9. Cleanup buckets

- **exact**: 0
- **conflicting_active**: 0
- **null_tenant_assignment_required**: 0
- **manual_review**: 0

No automatic changes. Phase 3.2 will plan per-bucket remediation.
