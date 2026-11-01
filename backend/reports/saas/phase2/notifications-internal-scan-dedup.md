# Phase 2.46 — internal check* notification scan dedup

**13/13 PASS**

- PASS — 1. flag off: scan create produces duplicate (legacy) — r1={"created":1,"deduped":0} r2={"created":1,"deduped":0} cnt=2
- PASS — 2. checkExpiringCompliance condition deduped — r1={"created":1,"deduped":0} r2={"created":0,"deduped":1} cnt=1
- PASS — 3. checkServiceDue condition deduped — r1={"created":1,"deduped":0} r2={"created":0,"deduped":1} cnt=1
- PASS — 4. checkOverdue condition deduped — r1={"created":1,"deduped":0} r2={"created":0,"deduped":1} cnt=1
- PASS — 5. checkScheduledMaintenance condition deduped — r1={"created":1,"deduped":0} r2={"created":0,"deduped":1} cnt=1
- PASS — 6. different user (same tenant) NOT deduped — cnt=2
- PASS — 7. same user different tenant NOT deduped — a=1 b=1
- PASS — 8. different condition types for same vehicle NOT deduped — total=2
- PASS — 9. window respected: old row outside window does not suppress — total=2
- PASS — 10. NULL-tenant legacy row does NOT suppress tenant-scoped row — a=1
- PASS — 11. dedup with tid=null falls through (no probe; legacy create) — cnt=2
- PASS — 12. concurrent tenant-aware scans remain ALS-isolated — a=1 b=1
- PASS — 13. all four check* methods route through createInAppWithDedup — checkExpiringCompliance=OK checkServiceDue=OK checkOverdue=OK checkScheduledMaintenance=OK
