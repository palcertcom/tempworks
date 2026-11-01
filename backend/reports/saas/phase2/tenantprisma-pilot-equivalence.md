# Phase 2.6 — TenantPrisma Pilot Read-Equivalence (Roles)

Generated: 2026-05-10T02:08:00.682Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))

- Cases passed: **13** / 13
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | baseline: pilot OFF reports pilotActive=false | PASS | pilotActive=false |
| 2 | pilot ON reports pilotActive=true (env safe) | PASS | pilotActive=true |
| 3 | findAll(System Admin) equivalent (id sets) | PASS | legacy=5 pilot=5 |
| 4 | findAll(Agency Manager) equivalent (id sets) | PASS | legacy=0 pilot=0 |
| 5 | findAll(Agency User) equivalent (id sets) | PASS | legacy=4 pilot=4 |
| 6 | findAll preserves ordering (alphabetical by name) | PASS | legacy[0..2]=Compliance Officer,HR Manager,Read Only |
| 7 | findOne(id) returns same role | PASS | legacy=00000000-0000-0000-0000-000000000004 pilot=00000000-0000-0000-0000-000000000004 |
| 8 | getPermissions count equal | PASS | legacy=5 pilot=5 |
| 9 | getPermissions first 10 ids equal | PASS | legacy[0]=4e704553-3504-4866-82f8-233503658a98 pilot[0]=4e704553-3504-4866-82f8-233503658a98 |
| 10 | getPermissionsMatrix role count equal | PASS | legacy=5 pilot=5 |
| 11 | getPermissionsMatrix grant count equal | PASS | legacy=0 pilot=0 |
| 12 | error on missing id: same error class | PASS | legacy=NotFoundException:Role not found pilot=NotFoundException:Role not found |
| 13 | response shape preserved (Array, top-level keys) | PASS | findAll arrays + matrix object match |