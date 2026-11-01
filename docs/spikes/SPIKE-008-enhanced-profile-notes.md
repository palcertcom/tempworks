# SPIKE 008 — Enhanced Profile Notes (Phase 3 #17)

**Status:** Investigation-only. **DO NOT IMPLEMENT YET.** No schema
migration, no service rewrite, no UI change in this spike. The deliverable
is this report.

**Scope:** Spec out enriched notes (category / priority / status /
createdBy / updatedBy / attachments / expandable preview) on
**Employee**, **Applicant**, and **Candidate** profiles.

---

## TL;DR

- Today notes are a **single `notes: String?` column** on each parent
  entity (Employee, Applicant). There is one dedicated `CandidateStageNote`
  model for workflow stages, but it's not surfaced on the candidate
  profile UI.
- There are **no `notes:*` permissions** — write access is implicitly
  granted by `employees:update` / `applicants:update`.
- The frontend has **three duplicated inline textareas** (one per profile
  page). No modal, no list, no metadata.
- Recommended path: **introduce a single polymorphic `ProfileNote` model**
  (entityType + entityId), reuse the existing Documents subsystem for
  attachments via a new `NoteAttachment` link table, and add a small set
  of `notes:*` permissions distinct from parent-entity permissions so
  legal/medical categories can be access-controlled later.
- Implementation is sized as four small phases (A schema/service, B
  shared UI, C attachments, D filters/export/audit). The existing
  `notes` String columns stay in place during A–B and are deprecated
  after C/D — no destructive migration ever proposed.

---

## 1. Current model (what exists today)

### 1.1 Schema (backend/prisma/schema.prisma)
- **`Employee.notes: String?`** (line 441) — single free-text blob, no
  history, no category, no author attribution beyond `updatedById` on
  the Employee row itself.
- **`Applicant.notes: String?`** (line 597) — same pattern; covers
  Leads and Candidates because they share the model.
- **`CandidateStageNote`** (lines 1503–1518) — the closest thing to a
  proper note model today:
  ```
  id, progressId (FK CandidateStageProgress),
  content (Text),
  isPrivate (Boolean default false),
  authorId (FK User, nullable),
  createdAt, updatedAt, deletedAt
  ```
  Scoped to a workflow stage, not the profile.
- Same flat `notes: String?` pattern appears on many adjacent entities
  (Document, AttendanceRecord, ComplianceAlert, Vehicle, …) — these are
  out of scope here but the new model should leave room to absorb them
  later if desired.
- **No attachments model for notes.**

### 1.2 Tenant / agency scoping
- `Employee.notes` and `Applicant.notes` live on a tenant-scoped row,
  so they inherit the parent's tenant — but there is no `tenantId`
  on the note itself because there is no note row.
- `CandidateStageNote` has no `tenantId`; scope flows through
  `CandidateStageProgress` → `CandidateWorkflowAssignment` → Workflow.

### 1.3 Audit log
- Edits to `Employee.notes` / `Applicant.notes` ride in the general
  `EMPLOYEE_UPDATED` / `APPLICANT_UPDATED` audit row written by the
  parent service. The `changes` JSON includes the full DTO, so a notes
  diff is recoverable.
- `CandidateStageNote` mutations are **not audit-logged today**.

### 1.4 Attachments
- None on notes. Documents attach to the parent entity (Employee /
  Applicant) via `Document.entityType + entityId`. The enum (`EntityType`,
  schema.prisma:132–143) has no `NOTE` value.

## 2. Current API

| Mutation | Endpoint | Permission | Tenant gate |
|----------|----------|-----------|-------------|
| Edit employee notes | `PATCH /employees/:id` body `{ notes }` | `employees:update` | `findOne(id, actor)` scoped |
| Edit applicant/candidate notes | `PATCH /applicants/:id` body `{ notes }` | `applicants:update` | `findOne(id, actor)` scoped |
| Add stage note | `POST /workflows/progress/:progressId/notes` | `workflow:create` | parent progress scoped |
| Delete stage note | `DELETE /workflows/notes/:noteId` | `workflow:delete` | parent scoped |

There is **no `notes:*` permission** in the seed (`backend/prisma/seed.ts`).
Notes are read/written under the parent entity's `update` permission.

## 3. Current frontend

- `src/app/pages/employees/EmployeeProfile.tsx` — `noteDraft` state,
  inline `<Textarea>` in the Overview tab, "Save" button. Save calls
  `employeesApi.update(id, { notes: noteDraft })`. No edit history shown.
- `src/app/pages/applicants/CandidateProfile.tsx` and
  `src/app/pages/applicants/ApplicantProfile.tsx` — identical pattern,
  three copies of the same code.
- **`CandidateStageNote` is not surfaced on the candidate profile UI** —
  it's a hidden workflow-stage feature only.
- No category / priority / status / attachments / preview-expand exist
  anywhere in the notes UI.

### Limitations users see today
- One-shot textarea; old text is overwritten on every save with no diff.
- Cannot distinguish HR / Legal / Medical notes; everything lands in one
  blob and is visible to anyone with `*:update` on the parent.
- No attachments.
- No filters, no sorting, no per-note metadata.

## 4. Proposed data model

Recommendation: **new polymorphic `ProfileNote` model** rather than
extending the parent's `notes` column. Reasons:

- The existing column can't carry per-note metadata (category, priority,
  status, author, attachments) without becoming a JSON blob that loses
  query ability.
- Polymorphism via `entityType + entityId` matches the existing Documents
  pattern, so future entities (Job Ads, Workshops, …) absorb cheaply.
- We keep `Employee.notes` / `Applicant.notes` in place during the
  transition; reads can union over both until UI is fully migrated.

### 4.1 `ProfileNote` (proposed — DO NOT ADD YET)

```
model ProfileNote {
  id              String    @id @default(uuid())
  entityType      ProfileNoteEntityType    // EMPLOYEE | APPLICANT (covers Lead + Candidate)
  entityId        String                    // FK target (not modeled as a Prisma relation
                                            //   because entityType varies; resolver enforces it)
  text            String                    // Long text; Postgres TEXT
  category        ProfileNoteCategory       @default(GENERAL)
  priority        ProfileNotePriority       @default(MEDIUM)
  status          ProfileNoteStatus         @default(OPEN)
  occurredAt      DateTime?                 // user-supplied date + time of the event,
                                            //   distinct from createdAt (system clock)

  createdById     String                    // FK User
  updatedById     String?                   // FK User; set when edited
  createdAt       DateTime                  @default(now())
  updatedAt       DateTime                  @updatedAt
  deletedAt       DateTime?                 // soft delete, mirrors existing pattern

  tenantId        String                    // inherited from parent at create-time;
                                            //   NOT NULL — new column, no legacy rows
  agencyId        String?                   // optional, inherited from parent;
                                            //   read-only on the note (parent moves
                                            //   are reflected by a future job, not
                                            //   the note itself)

  attachments     NoteAttachment[]

  @@index([entityType, entityId])
  @@index([tenantId, entityType, entityId, status])
  @@index([category])
  @@index([priority])
  @@map("profile_notes")
}

enum ProfileNoteEntityType { EMPLOYEE  APPLICANT }
enum ProfileNoteCategory   { HR  PERFORMANCE  WARNING  ATTENDANCE  PAYROLL  VEHICLE  GENERAL  RECRUITMENT  MEDICAL  LEGAL }
enum ProfileNotePriority   { LOW  MEDIUM  HIGH  CRITICAL }
enum ProfileNoteStatus     { OPEN  IN_PROGRESS  RESOLVED  CLOSED }
```

Notes on the shape:
- **`entityType` covers Applicant in both Lead and Candidate tiers** —
  the dashboard distinction is a `tier` value on the Applicant row, not
  a different model. Frontend filters by tier.
- **`occurredAt`** addresses the spec's separate `date` + `time` fields
  (the event time the user reports). `createdAt`/`updatedAt` remain the
  system clocks for audit.
- `tenantId` is `NOT NULL` because we're starting from a clean slate —
  no legacy rows. Inheriting from parent at create-time matches how
  Documents and FinancialRecords are written.
- `agencyId` is captured for filtering convenience; the authoritative
  agency-scope answer still comes from the parent profile (an employee
  re-assignment shouldn't silently break old notes).

### 4.2 Why not extend the existing `notes` column
- No place for category/priority/status without a JSON shim.
- Cannot query "all WARNING notes across the tenant".
- Cannot soft-delete one note while keeping another.
- Cannot attach a file to a specific note.

## 5. Attachments

Recommendation: **reuse the Documents subsystem via a thin
`NoteAttachment` join table**, rather than introducing a new uploader.

```
model NoteAttachment {
  noteId      String
  documentId  String
  attachedAt  DateTime  @default(now())
  attachedById String
  @@id([noteId, documentId])
  note     ProfileNote @relation(fields: [noteId], references: [id], onDelete: Cascade)
  document Document    @relation(fields: [documentId], references: [id])
}
```

Why:
- The Documents pipeline already does storage, tenant scoping, MIME
  validation, virus-scan hooks, expiry, and audit. We don't replicate
  any of that.
- A Note can point at a Document the parent profile already owns
  (e.g. attach the existing Driving Licence PDF to a Vehicle-category
  note) — the join model expresses that without duplicating bytes.
- For documents created **for** a note specifically, we still call the
  existing `POST /documents/upload` endpoint with `entityType: EMPLOYEE`
  / `APPLICANT` (the parent), then bind via `NoteAttachment`. We do NOT
  add an `entityType: NOTE` because Document ownership stays with the
  parent — a future profile delete cleans up everything.
- An alternative considered (adding `NOTE` to `EntityType`) was
  rejected because it complicates document permissions
  (`DocumentTypePermission` is per-role/per-type and would need a new
  axis) and because Note attachments are tighter than a general
  document slot.

## 6. Permissions

New permission keys recommended:

| Key                 | Purpose                                              |
|---------------------|------------------------------------------------------|
| `notes:read`        | View notes on a profile the actor can already see    |
| `notes:create`      | Create a note on a profile they can update           |
| `notes:update`      | Edit / change status of a note they can see          |
| `notes:delete`      | Soft-delete a note                                   |
| `notes:attach`      | Bind a Document to a note                            |
| `notes:read-restricted` | Required *in addition* to `notes:read` to see notes whose `category ∈ { MEDICAL, LEGAL }` |

The restricted-category gate is the reason we want a dedicated permission
namespace — under the current model (`employees:update`) every HR user
sees medical notes. The spec calls out Medical and Legal as their own
categories; we should be able to limit them.

Role mapping recommendation:

| Role            | Default grants                                                  |
|-----------------|-----------------------------------------------------------------|
| HR Manager      | read, create, update, delete, attach, read-restricted           |
| Recruiter       | read, create, update, attach                                    |
| Agency Manager  | read, create (same-agency profiles only — enforced by parent gate) |
| Agency User     | read (own-agency profiles only)                                 |
| Lawyer          | read, create, update, attach, read-restricted (LEGAL only — frontend hint, backend enforces by category list) |
| Finance         | read, create, update (PAYROLL category only — frontend filter, backend audit) |
| SUPER USER      | All, scoped by selected tenant unless an explicit All Tenants screen |

Backend remains the authority: any role can be sent any payload; the
service decides what the actor may persist.

## 7. UI / UX specification

### Layout
- Notes section as a tabbed panel on each profile (replaces the inline
  textarea). Default tab on the Overview page.
- List sorted by `updatedAt desc` (last modified first, per spec).
- Card per note:
  - Header: Category chip, Priority badge, Status pill, "by {createdBy.name} ({role})" — and "edited by …" footer when `updatedById` is set.
  - Body: preview (first ~3 lines / 240 chars) with **Expand / Collapse**.
  - Attachments: chip strip below body; click opens the Documents viewer modal.
  - Right-rail metadata: `occurredAt` formatted `dd.mm.yyyy HH:mm` (24h), per the site's existing convention.

### Filters
- Filter bar above list: Category multi-select, Priority multi-select, Status multi-select, Search.
- Persisted in URL query params so deep links share filtered views.

### Add / Edit modal
- Required: text, category. Defaults: priority MEDIUM, status OPEN, `occurredAt` = now.
- Validation summary at top (same pattern as the convert-to-employee dialog from #26).
- Attachments: "Pick from profile documents" + "Upload new" (uploads land on the parent via existing `/documents/upload`, then bound via `NoteAttachment`).

### RTL / i18n
- All labels via i18next. Status and Category enums render via the existing `enumLabel` helper, same pattern as other status badges.
- All visible dates use `dd.mm.yyyy`; times use 24-hour format (project conventions).

### Accessibility
- Expand control is a button, not a link. `aria-expanded` toggles.
- Soft-delete confirms via the existing `ConfirmDialog`.

## 8. Tenant + agency safety (binding rules)

1. `ProfileNote.tenantId` is inherited from the parent entity at create
   time. The service NEVER trusts a client-supplied `tenantId` (same
   spoof-guard pattern as Documents).
2. Read endpoints spread `scope.tenantWhere()` and the actor's
   agency gate. A cross-tenant note id 404s.
3. SUPER PlatformAdmin follows the selected tenant (`TenantSyncContext`
   in the frontend). No "All Tenants" notes view unless the operator
   explicitly opens one.
4. Agency users (non-system) can only read notes whose parent profile
   they can already read (existing `EmployeeAgencyAccess` /
   `ApplicantAgencyHistory` grants govern this — the note service
   reuses those checks via the parent service's `findOne(id, actor)`).
5. `notes:read-restricted` gates Medical/Legal categories — backend
   strips those rows from the list response when the actor lacks the
   permission, AND refuses an individual `GET /notes/:id` for them.

## 9. Migration / backfill

No destructive migration is proposed. Sequence:

1. **Phase A** adds the `ProfileNote` table and enums. The existing
   `Employee.notes` / `Applicant.notes` columns stay.
2. A **read-only audit script** (`profile-notes-audit.ts`) reports rows
   whose legacy `notes` blob is non-empty, with a proposed `ProfileNote`
   shape (category=`GENERAL`, priority=`MEDIUM`, status=`OPEN`,
   `createdById = updatedById`, `occurredAt = updatedAt`).
3. Gated remediation (`PROFILE_NOTES_REMEDIATE` / `_APPLY` / `_FORCE` +
   `classifyRuntimeEnv()` staging gate, same template as the
   applicant/agency tenant audits) writes one `ProfileNote` per
   non-empty legacy blob, writes a JSON backup first, never deletes
   the legacy column.
4. After Phase D, when the UI is fully on the new model, a separate
   spike can recommend whether to retire the legacy `notes` String
   column. We don't pre-commit.

## 10. Implementation plan

### Phase A — Backend (small-medium)
- Prisma migration: `ProfileNote`, `NoteAttachment`, three enums.
- `notes` permission keys + role mapping seeded.
- `NotesService` with: `create`, `update`, `softDelete`, `list({ entityType, entityId, filters })`, `findOne`, `attach`, `detach`. All paths spread tenant/agency scope through the parent service's existing guards.
- Controller `/notes` with `@RequirePermission` decorators. Restricted-category enforcement on list + findOne.
- `TenantAuditLog` actions: `NOTE_CREATE`, `NOTE_UPDATE`, `NOTE_DELETE`, `NOTE_ATTACH`, `NOTE_DETACH`.
- DTO whitelist (`whitelist: true`) so a forged `tenantId` is dropped.

### Phase B — Frontend shared component (small-medium)
- New `src/app/components/notes/ProfileNotesPanel.tsx` shared by
  `EmployeeProfile`, `ApplicantProfile`, `CandidateProfile`.
- Card list, filter bar, add/edit modal, expand/collapse, RTL/i18n.
- The legacy inline textarea in the three profile pages is removed
  on the same PR that mounts the panel, to avoid two write paths.

### Phase C — Attachments (small)
- Modal step: pick from parent profile's existing Documents or upload a
  new one. New uploads call the existing `/documents/upload` for the
  parent, then `POST /notes/:id/attach { documentId }`.
- Detach button on the chip. Cascade-delete is handled at the DB level
  via `onDelete: Cascade` on the join.

### Phase D — Filters / export / audit polish (small)
- Server-side filter params for category / priority / status / search.
- CSV / XLSX export under the existing reports framework.
- Audit script `profile-notes-audit.ts` for ongoing sanity checks
  (orphan attachments, restricted-category leakage if any).

## 11. Tests needed

Backend:
- `notes.create.spec`: create succeeds, persists `tenantId` from parent,
  rejects forged `tenantId`, 403 without `notes:create`.
- `notes.update.spec`: only same-tenant; sets `updatedById`,
  bumps `updatedAt`; preserves `createdById`.
- `notes.delete.spec`: soft-delete; subsequent list excludes; restricted
  to `notes:delete`.
- `notes.list.spec`: filter by category/priority/status; pagination;
  cross-tenant ids 404; `notes:read-restricted` gate hides MEDICAL/LEGAL.
- `notes.findOne.spec`: cross-tenant id 404 (not 403); restricted
  category returns 403 for actor without `notes:read-restricted`.
- `notes.attach.spec`: document must belong to the SAME parent profile;
  attaching another tenant's document 404s.
- Agency-scope: agency user can see notes on profiles they can read;
  cannot on profiles outside their grants.
- Static check: every controller route declares `@RequirePermission`
  and `@RequireTenant` (or equivalent); no bare `prisma.profileNote.findFirst`
  in callers.

Frontend:
- Component test: long text shows preview + Expand; Expand reveals full.
- Add modal: required fields (text, category) flagged via summary banner
  before submit.
- Filter changes update URL and refetch.
- Status pill / priority badge classes are stable (visual regression).
- RTL render: chip and metadata order mirrors in `ar`.

## Risk matrix

| Risk                                              | Likelihood | Impact | Mitigation                                                                |
|---------------------------------------------------|:----------:|:------:|--------------------------------------------------------------------------|
| Forged `tenantId` on create                        | Low        | High   | DTO whitelist + service ignores client `tenantId`; tenant pulled from parent. |
| Medical/Legal notes leak to general HR             | Medium     | High   | Restricted-category gate enforced on BOTH list and findOne; static check on the strip filter. |
| Two write paths during migration                   | Medium     | Medium | Phase B removes the inline textarea on the same PR that mounts the panel. |
| Attachment escapes parent tenant scope             | Low        | High   | `notes:attach` validates Document.parent matches Note.parent.            |
| `updatedById` bypassed on a third-party PATCH      | Low        | Low    | Service sets it from `actorId` only; DTO doesn't expose it.              |
| Soft-deleted notes still surface in exports        | Low        | Medium | List filter `deletedAt IS NULL` baked into service; export reuses list.  |
| Legacy `notes` String column drifts post-migration | Medium     | Low    | Phase A leaves it; explicit retirement is a later, gated decision.       |
| i18n missing for new enums                         | Medium     | Low    | enumLabel helper + i18n-check-keys CI catches gaps before merge.         |

## Confirmation

**No code changed in this spike.** No schema migration, no service or
controller change, no UI change, no i18n key added. The deliverable is
this document. Phase A is the next, separately-approved task.
