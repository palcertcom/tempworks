# Phase 2.14/2.14.1/2.15 — Notifications Scheduler Harness

Generated: 2026-05-10T02:07:12.812Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))

- Cases passed: **28** / 28
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | flags OFF: scheduler invokes legacy runAllChecks (not tenant-aware) | PASS | legacy=true tenantAware=false |
| 2 | flags ON in SAFE_CLONE: scheduler invokes runAllChecksTenantAware | PASS | legacy=false tenantAware=true |
| 3 | planner: 1 ACTIVE non-system selected; 1 system + 1 inactive skipped | PASS | selected=11111111-1111-1111-1111-111111111111 skipped={"system-tenant":1,"inactive":1} |
| 4 | runForTenant: ALS frame carries tenantId (smoke for fanout-tenant entry) | PASS | seen=[{"tenantFromAls":"11111111-1111-1111-1111-111111111111"}] |
| 5 | tenant-aware ON: notifyUploaderAndRoles without ALS tenant raises MissingTenantContextError | PASS | threw=true isMissing=true |
| 6 | tenant-aware ON: notifyUsersByRoles without ALS tenant raises MissingTenantContextError | PASS | threw=true isMissing=true |
| 7 | flags OFF: notifyUsersByRoles does NOT raise the new MissingTenantContextError | PASS | raisedMissing=false (other errors are unrelated to this case) |
| 8 | flags ON outside staging: scheduler stays on legacy path (env classifier refuses tenant-aware) | PASS | legacy=true tenantAware=false |
| 9 | cron timing constant unchanged (6-hour interval) | PASS | source contains 6 * 60 * 60 * 1000: true |
| 10 | checkExpiringCompliance: reads narrowingTenantId() at the top of its body | PASS | source matches: true |
| 11 | checkServiceDue: reads narrowingTenantId() at the top of its body | PASS | source matches: true |
| 12 | checkOverdue: reads narrowingTenantId() at the top of its body | PASS | source matches: true |
| 13 | checkScheduledMaintenance: reads narrowingTenantId() at the top of its body | PASS | source matches: true |
| 14 | each check* method narrows User scan by agency.tenantId when tid set | PASS | agency: { tenantId: tid } appears in source: true |
| 15 | notification creates spread tenantId when tid set (≥ 4 sites) | PASS | tenantId spread occurrences: 14 |
| 16 | notification dedupe queries scope by tenantId when tid set (≥ 4 sites) | PASS | dedupe-scope occurrences: 6 |
| 17 | legacy mode: narrowingTenantId() returns null (no narrowing) | PASS | tid=null |
| 18 | tenant-aware mode + ALS: narrowingTenantId() returns the active tenantId | PASS | tid=11111111-1111-1111-1111-111111111111 |
| 19 | tenant-aware mode without ALS frame: narrowingTenantId() returns null (legacy fallback) | PASS | tid=null |
| 20 | fanout: notifyUploaderAndRoles reads narrowingTenantId() | PASS | source matches: true |
| 21 | fanout: notifyUploaderAndRoles narrows User.findMany via agency.tenantId when tid set | PASS | agency narrow present: true |
| 22 | fanout: notifyUsersByRoles reads narrowingTenantId() | PASS | source matches: true |
| 23 | fanout: notifyUsersByRoles narrows User.findMany via agency.tenantId when tid set | PASS | agency narrow present: true |
| 24 | fanout: notification.create payloads spread tenantId when tid set (≥ 6 sites: 4 check* + 2 writers) | PASS | tenantId spread occurrences in create blocks: 6 |
| 25 | fanout: notifyUploaderAndRoles validates uploader belongs to tid via findFirst probe | PASS | uploader probe present: true |
| 26 | fanout: tenant A → notifyUsersByRoles(Recruiter) writes rows tagged tenantId=A | PASS | count=5; allTidA=true; sampleTids=11111111-1111-1111-1111-111111111111 |
| 27 | fanout: tenant A → notifyUsersByRoles(HR Manager) creates 0 rows (HR Managers are in tenant B only) | PASS | count=0 |
| 28 | fanout legacy: notifyUsersByRoles(HR Manager) reaches B-tenant users (cross-tenant fanout preserved) | PASS | created=5 |