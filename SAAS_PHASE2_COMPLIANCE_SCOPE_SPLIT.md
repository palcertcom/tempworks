# Phase 2.37 — Compliance Scope Split

> What ships in Phase 2.37 vs. what waits for Phase 2.38+.

---

## 1. Scope summary

| Area | Phase | This PR? |
|------|------|----------|
| `getDashboard` | **2.8 → 2.37 reaffirmed** | YES (already piloted) |
| `getAlerts` | **2.8 → 2.37 reaffirmed** | YES (already piloted) |
| `getEmployeeCompliance` | **2.8 → 2.37 reaffirmed** | YES (already piloted) |
| `getExpiringDocuments` | **2.8 → 2.37 reaffirmed** | YES (already piloted) |
| `updateAlert` (mutation pre-check) | **2.8 → 2.37 reaffirmed** | YES (already gated) |
| `generateAlerts` (read + create cycle) | **2.8 → 2.37 reaffirmed** | YES (already piloted) |
| Audit emission for `updateAlert` (route through `TenantAuditLogService`) | 2.38+ | NO |
| Scheduled background-scan ALS frame management | 2.38+ | NO |
| Notification fan-out | out of scope | NO |
| Bulk remediation flows | future | NO |
| Document verification side effects | handled in `documents` module pilot | NO change |

## 2. Phase 2.37 — Reads-first audit + harness reaffirmation (this PR)

What lands:
- Audit + scope-split + pilot-results docs added/updated.
- Fixture seed (`phase28-compliance-extension.sql`) patched so the
  `updatedAt` NOT NULL constraint introduced by a later schema
  migration is satisfied; the harness can re-seed compliance_alerts
  on a fresh fixture.
- Equivalence harness (12 cases) and isolation harness (7 cases)
  pass on real Postgres 16.

What does NOT land:
- No service code change.
- No new feature flag.
- No schema change.
- No mutation-flow change.
- No audit-routing change.
- No background-job schedule change.

## 3. Phase 2.38+ — Mutation refactor + audit routing (FUTURE)

The mutation pilot extension will:
- Route `updateAlert` audit emission through `TenantAuditLogService`.
- Wrap `generateAlerts()` invocation in scheduled jobs with explicit
  per-tenant ALS frame attach.
- Add a parent-gate helper analogous to the applicants /
  employees pattern if/when new mutation surface appears.

## 4. Phase 3 — Notification + remediation (FUTURE)

- Compliance-driven notification fan-out belongs to the
  `notifications` module pilot.
- Bulk remediation flows are out of scope until product defines
  them.

## 5. Guard-rails enforced by this PR

- The Phase 2.8 `phase28-pilot-scope` annotation set is preserved.
- The Phase 2.8 `phase28-audit-log` annotation on the audit-write
  site is preserved (will move to `phase230-audit-log-pilot` in
  Phase 2.38+).
- The fixture seeds two tenants × multiple alerts + one NULL-tenant
  legacy row so reads can be exercised with cross-tenant collision
  shapes plus the legacy-row exclusion proof.
