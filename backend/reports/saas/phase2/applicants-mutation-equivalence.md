# Phase 2.29 — Applicants Mutation Equivalence

Generated: 2026-05-10T12:21:15.962Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **10** / 10
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | create response shape preserved | PASS | legacy.id=bfb92a01-e56f-4ed1-a544-465089b7d0e4 pilot.id=e0401a19-391b-4172-8e72-859aa54fccef |
| 2 | create legacy: tenantId NULL | PASS | tid=null |
| 3 | create pilot: tenantId=A | PASS | tid=11111111-1111-1111-1111-111111111111 |
| 4 | update (legacy) mutates phone | PASS | phone=+legacy |
| 5 | update (pilot) mutates phone | PASS | phone=+pilot |
| 6 | updateStatus (pilot) mutates status | PASS | status=SCREENING |
| 7 | pilot remove: deletedAt set | PASS | deletedAt=set |
| 8 | validation: NotFoundException for missing applicant id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 9 | bulk filter (pilot): tenant B id silently dropped; tenant A id processed | PASS | results=1 bIncluded=false |
| 10 | requestDelete (pilot) creates request for tenant A applicant | PASS | id=6947c599-5ddd-497a-ba39-134d8ba9cd78 |