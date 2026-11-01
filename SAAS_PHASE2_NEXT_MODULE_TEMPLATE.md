# Phase 2 — Next Module Template

> Reusable checklist for adopting the TenantPrisma pilot pattern in a
> new module. Derived from Phases 2.6–2.11 (six pilots).
>
> Every checkbox is a real step. Skipping any of them risks a leak,
> a regression, or both.

---

## 0. Before you start

- [ ] Confirm the target module is in the recommended-pilot list, not
      in the avoid list.
- [ ] Read `SAAS_PHASE2_TENANTPRISMA_PATTERN_AUDIT.md` and
      `SAAS_PHASE2_TENANTPRISMA_REFACTOR_PATTERN.md`.
- [ ] If the module has cron / background paths: read
      `SAAS_PHASE2_JOB_CONTEXT_ARCHITECTURE.md`. The Phase 2.13 job-
      context framework is the prerequisite for moving cron-driven
      paths out of the `phase2X-excluded-background` bucket. Without
      it, scheduler paths must remain excluded with the existing
      annotation tags.
- [ ] Confirm `git status` is clean and the branch is the SaaS branch.
- [ ] Confirm fixture: `DATABASE_URL` points at SAFE_CLONE / SAFE_STAGING.

## 1. Audit checklist

Create `SAAS_PHASE2_<MODULE>_AUDIT.md` with:

- [ ] Files in module + line counts.
- [ ] Services + controllers + module summary.
- [ ] Per-method `prisma.<op>` call site count.
- [ ] Models touched and which have `tenantId`.
- [ ] Tenant ownership path per model.
- [ ] Read paths (in scope).
- [ ] Mutation paths (in scope or excluded).
- [ ] Aggregation/count paths.
- [ ] Background / cron / fanout paths (likely OUT of scope).
- [ ] Permissions matrix.
- [ ] Current cross-tenant risks pre-pilot.
- [ ] Refactor plan (numbered steps).
- [ ] Explicit "what is excluded" section.

## 2. Schema check

- [ ] Confirm every in-scope model has a nullable `tenantId` column.
- [ ] If any does NOT: write an additive migration in
      `prisma/migrations/saas_phaseXX_<module>_tenantid/`.
- [ ] Reverse migration provided.
- [ ] No `@unique` constraints removed; no columns dropped.

## 3. Refactor checklist (service)

- [ ] Inject `PilotPrismaAccessor`.
- [ ] Rename `prisma` → `legacyPrisma` (kept for audit log + anything
      that must remain global).
- [ ] Add `private get prisma()` returning `pilot.client()`.
- [ ] Add `private scope() = getPilotScope(this.pilot, '<module>')`.
- [ ] For multi-entity services: add a `tenant-scope-map.ts` listing
      tenant-scoped vs. global entity types.
- [ ] Spread `scope.tenantWhere()` into every read / count / update
      pre-check `where`.
- [ ] Spread `scope.tenantData()` into every create payload.
- [ ] Pre-check + mutate-by-id for update / delete.
- [ ] Background / cron paths → switch to `legacyPrisma` and annotate
      `phase2X-excluded-background`.
- [ ] Platform-admin / global-wipe paths → annotate
      `phase2X-excluded-platform`.
- [ ] Per-user global tables → annotate `phase2X-global`.
- [ ] Every retained `this.prisma.*` line carries one of the
      policy-allowed annotations.

## 4. Refactor checklist (module)

- [ ] `imports: [FeatureFlagsModule]`.
- [ ] `providers: [..., TenantPrismaService, PilotPrismaAccessor]`.
- [ ] No global wiring change in `AppModule`.

## 5. Equivalence harness checklist

Create `backend/scripts/saas/phase2/<module>-equivalence.ts` using
`./lib/harness`:

- [ ] `getDatabaseUrl()` + `abortUnlessStaging('<module>-equivalence')`.
- [ ] `discoverPilotTenants` / `discoverUserForTenant` if needed.
- [ ] Snapshot helper that runs the service under a flag set, captures
      counts / ids / response shape.
- [ ] Compare legacy vs. pilot snapshots back-to-back.
- [ ] At minimum: list, detail, error path, response shape, create +
      update + delete (when present).
- [ ] `writeReport({ title, name, out, environment })` at the end.

## 6. Isolation harness checklist

Create `backend/scripts/saas/phase2/<module>-isolation.ts`:

- [ ] Two tenants discovered.
- [ ] Same-shape rows seeded (or already present from a fixture
      extension).
- [ ] Pilot ON tenant A: list returns ONLY tenant A rows.
- [ ] Pilot ON tenant A: detail / update / delete on tenant B id raises
      `NotFoundException`.
- [ ] Pilot ON tenant A: create persists `tenantId = A`.
- [ ] Concurrent ALS frames isolated.
- [ ] Pilot OFF: legacy returns the union.
- [ ] If applicable: allow-list opt-out behaviour
      (`TENANT_PRISMA_PILOT_MODULES=nothing`).
- [ ] If applicable: meta-assertion that excluded-background paths
      remain on `legacyPrisma`.

## 7. Fixture extension checklist (if needed)

- [ ] `backend/scripts/saas/phase2/__fixture__/phase2X-<module>-extension.sql`.
- [ ] Idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
- [ ] Adds the columns Prisma's model expects on the staging fixture's
      narrow tables.
- [ ] Seeds same-shape rows in two tenants.
- [ ] Seeds a NULL-tenant legacy row for exclusion testing.

## 8. Scanner update checklist

- [ ] Add new annotation tags (if any) to `KNOWN_REASONS` in
      `backend/scripts/scan-annotations.ts`.
- [ ] Update `SAAS_PHASE2_SCANNER_ANNOTATION_POLICY.md`.
- [ ] `npm run saas:scan:annotations` returns 0 findings.
- [ ] `npm run saas:scan` total drops by exactly the number of
      annotated sites in this module.
- [ ] `npm run saas:scan:raw-sql` baseline unchanged.

## 9. Documentation checklist

- [ ] `SAAS_PHASE2_<MODULE>_AUDIT.md` (created in step 1).
- [ ] `SAAS_PHASE2_<MODULE>_PILOT_RESULTS.md` with headline,
      lessons learned, blockers.
- [ ] `SAAS_PHASE2_<MODULE>_<EXTRA>.md` if module has unusual semantics
      (slug safety, scope split, scope map).
- [ ] `SAAS_PHASE2_PRISMA_REFACTOR_STRATEGY.md` — append a Phase 2.X
      section.
- [ ] `SAAS_PHASE2_RUNTIME_REFACTOR_INVENTORY.md` — append a row.

## 10. Validation checklist

- [ ] `npm run build`
- [ ] `npx prisma validate`
- [ ] `npm run saas:validate`
- [ ] `npm run saas:schema-lint`
- [ ] `npm run saas:phase2-<module>-equivalence`
- [ ] `npm run saas:phase2-<module>-isolation`
- [ ] `npm run saas:phase2-pilot-regression` — every prior pilot still
      green.
- [ ] `npm run saas:scan` — total dropped by exactly the new annotation
      count.
- [ ] `npm run saas:scan:annotations` — 0 findings.
- [ ] `npm run saas:scan:raw-sql` — baseline unchanged.
- [ ] Confirm `FLAG_DEFAULTS` in `flags.ts` are all `false`.
- [ ] Confirm `<module>` legacy behaviour is byte-identical when flag
      is OFF.

## 11. Final report format

Use this exact section list for the PR description / handover note:

- module audited
- files created
- files modified
- (for schema-touching pilots) schema status / migration summary
- (for slug-bearing modules) slug safety summary
- refactor approach (1-paragraph)
- equivalence results (`N/N cases PASS`)
- isolation results (`N/N cases PASS`)
- pilot-regression results (`12/12 PASS` or whatever the new total is)
- scanner delta (`saas:scan` from X → Y by Δ; annotations 0)
- validation results (table)
- production behaviour change status (`Unchanged.`)
- next recommended module
- unresolved blockers
- commit hash
- branch name

## 12. Anti-patterns to avoid

- ❌ Hand-rolled `withFlags` / `getDatabaseUrl` in a new harness — use
   `lib/harness`.
- ❌ A new annotation tag without a policy doc update.
- ❌ Tenant-scoping a model with no `tenantId` column.
- ❌ Removing `@unique` constraints without a backfill plan.
- ❌ Touching a scheduler / cron path without job-context wiring.
- ❌ Adding a flag default of `true` (every flag stays default-`false`).
- ❌ Skipping the meta-assertion when the module has excluded paths.
- ❌ Refactoring a module on the avoid list without explicit approval.
