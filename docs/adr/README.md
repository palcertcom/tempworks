# Architecture Decision Records

This directory contains the authoritative architectural decisions governing the SaaS migration.

**Convention:** ADRs are immutable once `Accepted`. Material changes ship as a new ADR that supersedes the prior one.

---

## Index

| # | Title | Status | Supersedes | Related |
|---|---|---|---|---|
| [ADR-001](./ADR-001-shared-db-shared-schema-tenancy.md) | Shared Database, Shared Schema, `tenant_id` Isolation | Accepted | — | ADR-004, ADR-007 |
| [ADR-002](./ADR-002-global-identity-tenant-membership.md) | Global Identity with Multi-Tenant Membership | Accepted | — | ADR-003, ADR-005 |
| [ADR-003](./ADR-003-agency-to-tenant-split.md) | Splitting `Agency` into `Tenant` + (sub-)`Agency` | Accepted | — | ADR-002 |
| [ADR-004](./ADR-004-tenant-context-and-prisma-enforcement.md) | Tenant Context Propagation & Prisma Enforcement | Accepted | — | ADR-001, ADR-005 |
| [ADR-005](./ADR-005-platform-admin-access-model.md) | Platform Admin Access Model | Accepted | — | ADR-002 |
| [ADR-006](./ADR-006-private-file-storage-and-signed-urls.md) | Private File Storage with Signed URL Access | Accepted | — | — |
| [ADR-007](./ADR-007-reports-query-isolation.md) | Reports Query Isolation | Accepted | — | ADR-001, ADR-004 |

---

## Status meanings

- **Proposed** — under discussion, not yet binding.
- **Accepted** — binding; engineers must follow.
- **Superseded by ADR-NNN** — historical; consult the successor.
- **Deprecated** — no longer applies; replacement noted.

---

## How to read an ADR

Each ADR follows this template:

1. **Status** — current state.
2. **Context** — the problem and its constraints.
3. **Decision** — what we chose.
4. **Consequences** — positive and negative outcomes.
5. **Alternatives Considered** — what we rejected and why.
6. **Implementation Notes** — concrete guidance for engineers.
7. **Risks** — known dangers.
8. **Rollback Considerations** — what reversal would require.

When implementing a feature governed by an ADR, the **Implementation Notes** and **Risks** sections are the most actionable.

---

## How to propose a new ADR

1. Copy `ADR-001-…` as `ADR-008-<short-slug>.md`.
2. Set `Status: Proposed`.
3. Open a PR; request review from at least two SaaS code-owners.
4. After approval, update the index in this README to `Accepted`.

---

## How to amend an ADR

ADRs are immutable once `Accepted`. To change a decision:

1. Write a new ADR explaining the change.
2. Mark the new ADR `Supersedes ADR-XXX`.
3. Update the old ADR's status header to `Superseded by ADR-NNN`.
4. Update the index.

The exception: post-spike updates to `Implementation Notes` may be edits-in-place if they refine guidance without changing the decision. These edits must reference the relevant `SPIKE-NNN` report.

---

## Spike → ADR cross-reference

| Spike | Spike Report | Related ADR(s) |
|---|---|---|
| 1 | [Prisma + RLS validation](../spikes/SPIKE-001-prisma-rls-validation.md) | ADR-001, ADR-004 |
| 2 | [ALS context](../spikes/SPIKE-002-als-context-validation.md) | ADR-004 |
| 3 | [Agency → Tenant dry run](../spikes/SPIKE-003-agency-tenant-dry-run.md) | ADR-003 |
| 4 | [Reports isolation](../spikes/SPIKE-004-reports-isolation.md) | ADR-007 |
| 5 | [Storage signed URLs](../spikes/SPIKE-005-storage-security-validation.md) | ADR-006 |
| 6 | [Background jobs](../spikes/SPIKE-006-job-isolation.md) | ADR-001, ADR-004 |
