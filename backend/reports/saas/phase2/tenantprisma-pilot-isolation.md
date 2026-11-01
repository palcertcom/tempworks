# Phase 2.6 — TenantPrisma Pilot Isolation (Roles)

Generated: 2026-05-10T02:08:15.296Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))

- Cases passed: **9** / 9
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | model classifier: Role is GLOBAL | PASS | classify=GLOBAL, inGlobal=true |
| 2 | model classifier: Permission is GLOBAL | PASS | classify=GLOBAL, inGlobal=true |
| 3 | model classifier: RolePermission is not TENANT-scoped | PASS | classify=UNKNOWN (UNKNOWN ⇒ pass-through, by design) |
| 4 | pilot OFF → legacy reads succeed | PASS | roles=5, pilotActive=false |
| 5 | pilot OFF reason recorded as flag-off | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 6 | pilot ON (safe env) → pilotActive=true | PASS | pilotActive=true reason=pilot ON, env=SAFE_CLONE |
| 7 | pilot ON + NODE_ENV=production → pilot refuses to engage | PASS | active=false reason=env=UNSAFE_PRODUCTION is not SAFE_CLONE/SAFE_STAGING |
| 8 | concurrent tenants see identical global rows (Role is GLOBAL) | PASS | seen=[{"t":"22222222-2222-2222-2222-222222222222","n":5},{"t":"11111111-1111-1111-1111-111111111111","n":5}] |
| 9 | rollback: pilot flag off ⇒ tenantPrismaPilotEnabled() false | PASS | flag=false |