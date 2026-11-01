# Phase 2.10 — Notifications Equivalence

Generated: 2026-05-10T21:33:51.448Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111` · user: `00000000-0000-0000-0000-00000000us01`

- Cases passed: **11** / 11
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | legacy: pilot OFF reports pilotActive=false | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 2 | pilot: ON + module allow-list ⇒ pilotActive=true | PASS | pilot ON, env=SAFE_CLONE |
| 3 | getUserNotifications: pilot total <= legacy total (filtered) | PASS | legacy=6 pilot=5 |
| 4 | getUserNotifications: pilot excludes NULL-tenant legacy row | PASS | pilotIds=5 ids |
| 5 | getUserNotifications: legacy includes NULL-tenant legacy row | PASS | legacyIds.includes legacy=true |
| 6 | getUnreadCount: pilot <= legacy | PASS | legacy=4 pilot=3 |
| 7 | wasHighBalanceAlertRecentlySent: legacy true (any tenant), pilot true (tenant A row exists) | PASS | legacy=true pilot=true |
| 8 | markAsRead(missing-id): pilot raises NotFoundException; legacy raises Prisma error | PASS | legacy=PrismaClientKnownRequestError pilot=NotFoundException |
| 9 | getOrCreatePreferences: returns identical preferences id (per-user global record) | PASS | legacy=f5fcc90c-874f-49dd-8e23-df3f4feb4114 pilot=f5fcc90c-874f-49dd-8e23-df3f4feb4114 |
| 10 | markAllAsRead pilot ON: tenant A unread → 0; tenant B unread unchanged | PASS | A: 3→0; B: 3→3 |
| 11 | response shape preserved ({ data: [...], total: number }) | PASS | arrays + numeric total in both modes |