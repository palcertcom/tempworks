# SPIKE 007 — Business IDs in Frontend URLs (Phase 3 #15)

**Status:** Investigation-only. **DO NOT IMPLEMENT YET.** No route changes,
no URL changes, no removal of UUID support in this spike. The deliverable
is this report.

**Scope:** Evaluate replacing UUIDs in frontend URLs with assigned business
IDs (e.g. `/dashboard/employees/b6000b1f-…` → `/dashboard/employees/E20260500024`)
across every entity the dashboard exposes.

---

## TL;DR

- **Four entities are safe candidates today** — Employees (`employeeNumber`),
  Applicants/Leads/Candidates (`leadNumber`/`candidateNumber`), Users
  (`userNumber`), Documents (`docId`). All are system-generated and `@unique`.
- **Six entities are not safe** without a new system-generated business ID
  (Job Ads, Agencies, Vehicles registration is user-editable, Finance,
  Workflows, Workshops) — they have either no ID column or only freeform
  user-entered fields like `slug`, `name`, `registrationNumber`.
- **Recommended path:** Phase A (backend find-by-id-or-business-id helper +
  shared resolver, UUID URLs untouched), Phase B (frontend route generation
  prefers business ID where safe, UUID URLs keep working), Phase C (audit
  scripts + selective backfill + composite uniqueness review). Estimated
  size below.

---

## Per-entity findings

### 1. Employees
1. **Current URL:** `/dashboard/employees/:id` — `:id` is UUID.
2. **Backend lookup:** `EmployeesService.findOne(id)` → `prisma.employee.findFirst({ where: { id, …scope.tenantWhere() } })`. No business-ID fallback today.
3. **Assigned ID field:** `employeeNumber: String? @unique` (schema.prisma:412). Format `E{YYYY}{MM}{SSSSS}` via `IdentifierSequence`.
4. **Properties:** Globally unique (`@unique`); nullable until first save; not indexed beyond the `@unique`; **not user-editable**; **stable after conversion** (assigned once at lead→candidate→employee).
5. **Safe in URLs:** **Yes.**
6. **Backend changes (later):** add `resolveEmployeeIdOrNumber(idOrNumber, scope)` helper; teach `findOne` to accept either form; preserve `tenantWhere`.
7. **Frontend changes (later):** prefer `employee.employeeNumber ?? employee.id` in `Link` generation; route param accepts both.
8. **Backward compat:** UUID URLs stay valid forever (route regex unchanged; resolver tries `id` first).
9. **Tenant security:** Lookup must remain inside `scope.tenantWhere()` — `employeeNumber` is **globally unique** (`@unique`), so a wrong-tenant guess would 404 because the tenant predicate excludes it, but we must never drop that predicate "because the number is unique."
10. **Risk:** **Low.**

### 2. Applicants / Leads / Candidates (single model, three tiers)
1. **Current URLs:** `/dashboard/applicants/:id`, `/dashboard/candidates/:id`.
2. **Backend lookup:** `ApplicantsService.findOne(id, actor)` — UUID only, tenant + agency scoped.
3. **Assigned ID fields:** `leadNumber: String?` (schema.prisma:603, prefix `A`), `candidateNumber: String?` (line 604, prefix `C`). Both via `IdentifierSequence` with same `[Prefix][YYYY][MM][SSSSS]` format.
4. **Properties:** **Not `@unique` at the model level** — uniqueness is enforced semantically by the generator's atomic `ON CONFLICT … DO UPDATE` on `IdentifierSequence`. Nullable until first transition. **Not user-editable.** A row can carry both numbers simultaneously after lead→candidate promotion; the higher tier wins for URLs.
5. **Safe in URLs:** **Yes**, with a caveat — uniqueness is operational, not declarative. Production scan via the proposed audit script must confirm no collisions before flipping URLs.
6. **Backend (later):** `resolveApplicantIdOrNumber` matches by `id` OR `candidateNumber` OR `leadNumber`, gated by tier (refuse a leadNumber lookup on `/candidates/:id`).
7. **Frontend (later):** prefer `candidateNumber ?? leadNumber ?? id`.
8. **Backward compat:** UUIDs keep working.
9. **Tenant security:** Same warning as Employees — backend must continue to spread `scope.tenantWhere()` and the actor's agency gate, even when the lookup field is "unique." Cross-tier guessing is blocked by tier check.
10. **Risk:** **Low-Medium** — adds the duty to assert the candidate/lead number actually is unique in production (we believe it is, but the schema doesn't prove it).

### 3. Documents
1. **Current URL:** `/dashboard/documents/:id`.
2. **Backend lookup:** UUID only. Lists support search by `docId` substring.
3. **Assigned ID field:** `docId: String? @unique` (schema.prisma:730). Format `DOC{PersonNumber}{TypeCode}{Seq}{Timestamp}` — e.g. `DOCC20260400001PASS001`.
4. **Properties:** Globally `@unique`. Nullable on legacy rows. Generated inside the document-create transaction. **Not user-editable.**
5. **Safe in URLs:** **Yes** — but the string is long and not very URL-friendly. Worth deciding whether to use it for canonical URLs or to keep UUID for documents.
6. **Backend (later):** `findOne(idOrDocId)` accepts both.
7. **Frontend (later):** would need agreement on URL aesthetics; documents may be the one entity to leave on UUID.
8. **Backward compat:** UUIDs keep working.
9. **Tenant security:** `docId` is globally unique but stored on a tenant-scoped Document. The resolver MUST continue to spread `scope.tenantWhere()`. A bare globally-unique lookup is the foot-gun the spec calls out: "Business IDs must not become an authorization mechanism."
10. **Risk:** **Medium** — easy to mis-implement as "if doc with this docId exists, return it." Resolver must be one helper, audited.

### 4. Job Ads
1. **Current URL:** `/dashboard/job-ads/:id/edit` (UUID). Public `/jobs/:slug` already uses `slug`.
2. **Backend lookup:** UUID for internal admin, slug for public.
3. **Assigned ID:** **None.** Only `slug` exists, and slug is user-editable on the JobAd form.
4. **Properties:** `slug` is user-set, mutable, and uniqueness will be `(tenantId, slug)` not global (per Phase 3 plan in schema).
5. **Safe in URLs:** **No** for canonical admin URLs (mutable). Already used for public-facing.
6. **Backend changes:** would need a new `jobAdNumber` column + sequence to do this safely.
7. **Frontend changes:** none unless (6) is built first.
8. **Backward compat:** N/A.
9. **Tenant security:** N/A (UUID stays).
10. **Risk:** **High** to migrate — defer.

### 5. Agencies
1. **Current URL:** `/dashboard/agencies/:id`.
2. **Backend:** UUID only.
3. **Assigned ID:** **None.** Only freeform `name`/`email`.
4. **Properties:** N/A.
5. **Safe in URLs:** **No.**
6–10. Same conclusion as Job Ads — would need a new `agencyNumber` column. **Risk: High** to migrate, defer.

### 6. Users
1. **Current URL:** `/dashboard/users/:id/edit`.
2. **Backend:** UUID only; list supports `userNumber` search.
3. **Assigned ID:** `userNumber: String? @unique` (schema.prisma:197). Format `U{padded sequence}` via `UserNumberSequence`. Not monthly — monotonic.
4. **Properties:** Globally `@unique`, nullable until assigned, **not user-editable**.
5. **Safe in URLs:** **Yes.**
6–8. Same shape as Employees.
9. **Tenant security:** User has no flat `tenantId` column. Scope flows through `agencyId` + `TenantMembership`. Resolver must use the existing user-scope guards, not a bare `findUnique({ userNumber })`.
10. **Risk:** **Low** (with the caveat in #9).

### 7. Vehicles
1. **Current URL:** `/dashboard/vehicles/:id`.
2. **Backend:** UUID only.
3. **Assigned ID:** `registrationNumber: String @unique` (schema.prisma:1840) — but this is a **license plate**, user-entered, jurisdiction-dependent, frequently re-used after a plate transfer.
4. **Properties:** `@unique`, non-nullable — but user-editable and semantically reusable.
5. **Safe in URLs:** **No.**
6. **Backend:** would need a new `vehicleNumber` system ID.
7–10. **Risk: Medium-High** to migrate, defer.

### 8. Finance records (`FinancialRecord`)
1. **Current URL:** Embedded under `/dashboard/finance` (no direct `:id` route).
2. **Backend:** UUID only.
3. **Assigned ID:** **None.**
4. **Properties:** N/A.
5. **Safe in URLs:** N/A (no direct route).
6–10. **No change required** for this entity. Treat as out-of-scope for #15.

### 9. Workflows + assignments
1. **Current URLs:** `/dashboard/workflows/:id`, `/dashboard/workflows/stage/:stageId`.
2. **Backend:** UUID only.
3. **Assigned ID:** **None.** `name` is freeform and not unique.
4. **Properties:** N/A.
5. **Safe in URLs:** **No.**
6–10. **Risk: High** to add a synthetic number, **defer**. Workflows are infrequently URL-shared.

### 10. Workshops / Maintenance
1. **Current URLs:** `/dashboard/vehicles/workshops` (list only — no detail route in router today).
2. **Backend:** UUID only.
3. **Assigned ID:** **None** — `businessRegistrationNumber` / `vatNumber` are user-entered and not unique system IDs.
4–10. **Out of scope** for #15 (no exposed UUID URL today).

---

## Entity summary table

| Entity        | Business ID candidate         | `@unique` | Nullable | User-editable | Stable | URL-safe? | Risk to migrate |
|---------------|-------------------------------|:--------:|:--------:|:-------------:|:------:|:---------:|-----------------|
| Employee      | `employeeNumber`              | ✓        | ✓        | ✗             | ✓      | **Yes**   | **Low**         |
| Applicant     | `candidateNumber`/`leadNumber`| ✗ (semantic) | ✓    | ✗             | ✓      | **Yes**   | **Low-Medium**  |
| Document      | `docId`                       | ✓ (global) | ✓      | ✗             | ✓      | **Yes** (aesthetic concern) | **Medium** |
| User          | `userNumber`                  | ✓        | ✓        | ✗             | ✓      | **Yes**   | **Low**         |
| Job Ad        | `slug` (no system ID)         | per-tenant | ✗      | ✓             | ✗      | **No**    | **High**        |
| Agency        | — (none)                      | —        | —        | —             | —      | **No**    | **High**        |
| Vehicle       | `registrationNumber`          | ✓        | ✗        | ✓             | ✗      | **No**    | **Medium-High** |
| Finance       | — (none)                      | —        | —        | —             | —      | N/A       | —               |
| Workflow      | — (none)                      | —        | —        | —             | —      | **No**    | **High**        |
| Workshop      | — (none)                      | —        | —        | —             | —      | **No**    | **High**        |

---

## `IdentifierSequence` & generators — operational notes

- Model `IdentifierSequence(prefix, year, month, current)` is the single
  source for `A`/`C`/`E` numbers (schema.prisma:1047–1056). The `@@unique([prefix, year, month])`
  index + `ON CONFLICT … DO UPDATE SET current = GREATEST(current, …)` is the
  concurrency story.
- `UserNumberSequence` (schema.prisma:2162–2167) is a separate, monotonic
  counter for `userNumber` (no monthly reset).
- `docId` is generated inside the document-create transaction by
  `DocumentIdService` (backend/src/documents/document-id.service.ts). It
  composes a person number + 4-char type code + per-(entity,type) sequence
  + millisecond timestamp.
- **All generators are global, not per-tenant.** That's fine for URL use
  but it MUST stay paired with a server-side tenant predicate, since the
  business IDs alone are not an authorization signal.

---

## Security rules (apply to every later phase)

The four rules from the spec, restated for the implementation tracker:

1. Business ID lookup **must** spread `scope.tenantWhere()` (and any actor/agency gate the entity already uses). No exceptions.
2. UUID URLs **must** remain supported in perpetuity — old links in emails, exports, audit logs, and bookmarks must not 404.
3. A wrong-tenant business ID guess must 404, not 403 — same shape as wrong-tenant UUID today.
4. Lookup helper is the single chokepoint; no caller should bypass it.

A bare `prisma.employee.findUnique({ where: { employeeNumber } })` anywhere
in code is a regression and the audit script (Phase C) should grep for it.

---

## Recommended phased plan

### Phase A — Backend resolver, UUID URLs unchanged (small)
- Add `resolveByIdOrBusinessId(idOrKey, scope, opts)` per entity service for the four safe ones: Employee, Applicant/Lead/Candidate, User, Document.
- Existing `findOne(id)` becomes a thin wrapper that calls the new resolver. Behaviour for a UUID input is byte-identical.
- Detect form: UUIDv4 regex → `id`; otherwise → business ID field. Both branches spread the same tenant/agency predicate.
- Add jest-style unit tests + a static check `business-id-resolver-check.mjs` asserting every resolver call site routes through the helper.

### Phase B — Frontend opt-in (small per entity)
- `routeFor(entity)` helper that returns `entity.businessId ?? entity.id`.
- Migrate `<Link to=…>` and `navigate(…)` sites entity-by-entity.
- Optional `<Navigate>` redirect from UUID URL to business-ID URL after successful resolve, so shared links land on the canonical form. **Keep the UUID route definition.**
- No backend changes in this phase.

### Phase C — Indexes, audits, backfill (medium)
- `business-id-audit.ts` (new): for each entity reports null business IDs, duplicates (per global unique field), and cross-tenant overlaps if any.
- Backfill missing `employeeNumber` / `userNumber` / `candidateNumber` only when safely inferable; never delete; gated by the existing `_REMEDIATE`/`_APPLY`/`_FORCE` pattern.
- Re-evaluate whether `Applicant.{lead,candidate}Number` should be promoted to `@unique` at the schema level once the audit confirms zero duplicates.
- Decide whether `docId` is worth using in URLs (aesthetics).

### Out of scope for #15 — would need a new column first
- Job Ads (slug is mutable), Agencies, Vehicles (registrationNumber is mutable/reusable), Workflows, Workshops, Finance records.

---

## Files likely to change later

**Backend (when Phase A starts):**
- `backend/src/employees/employees.service.ts`
- `backend/src/applicants/applicants.service.ts`
- `backend/src/users/users.service.ts`
- `backend/src/documents/documents.service.ts`
- Possibly new: `backend/src/common/business-id-resolver.ts`

**Frontend (when Phase B starts):**
- `src/app/App.tsx` (routes) — keep both forms in the same param.
- `src/app/services/api.ts` (any client-side route builders).
- `src/app/pages/employees/EmployeesList.tsx`, `EmployeeProfile.tsx`,
  `EditEmployee.tsx`.
- `src/app/pages/applicants/{ApplicantsList,CandidatesList,ApplicantProfile,CandidateProfile,EditApplicant,EditCandidate}.tsx`.
- `src/app/pages/users/{UsersList,EditUser}.tsx`.
- `src/app/pages/documents/EmployeeDocumentExplorer.tsx` and any other doc list.

**Tests (when Phase A starts):**
- Resolver-routing static check (`scripts/business-id-resolver-check.mjs`).
- Per-entity unit cases for "UUID resolves", "business ID resolves", "wrong-tenant UUID 404s", "wrong-tenant business ID 404s", "non-existent business ID 404s".
- Manual QA: shared links, bookmarks, notification deep-links, exports.

**Audit (when Phase C starts):**
- `backend/scripts/saas/business-id-audit.ts` (read-only; staging-gated remediation mirroring `applicant-jobad-tenant-audit.ts`).

---

## Risk analysis

| Risk                                              | Likelihood | Impact | Mitigation                                                                 |
|---------------------------------------------------|:----------:|:------:|----------------------------------------------------------------------------|
| Resolver skips tenant predicate                   | Low        | High   | Single helper + static check that bans bare `findUnique({ businessId })`. |
| Business ID collision (Applicant `*.Number`)      | Low        | Medium | Phase C audit before promoting to schema `@unique`.                       |
| UUID URL breakage in old emails/audit logs        | Low        | High   | Keep UUID route forever; resolver is union.                               |
| Information disclosure via sequential numbers     | Low        | Low    | Monthly reset + tenant gate already mask volume; nothing private leaks.   |
| Vehicle/`registrationNumber` confusion            | Medium     | Medium | Explicitly OUT of scope; document the no-go.                              |
| `docId` lookup bypassing tenant ("globally unique") | Medium     | High | Resolver enforces `tenantWhere`; static check + code review.              |
| Frontend caches stale URLs after a backfill       | Low        | Low    | Backfill writes new column without touching UUIDs; frontend re-fetches.    |

---

## Confirmation

**No code changed in this spike.** No routes added or removed, no UUID
support removed, no schema migrated. The only artifact is this document.
The recommended next step (Phase A) is a small backend-only change that
keeps every existing URL working.
