# Phase 2.48 — attendance mutation isolation

**17/17 PASS**

- PASS — 1. pilot off legacy create succeeds (tenantId NULL) — id=0ca0f6d6 tenantId=null
- PASS — 2. pilot A create stamps tenantId = A — tenantId=11111111
- PASS — 3. pilot A create for tenant B employee raises NotFound — NotFound
- PASS — 4. rejected create produces no row — count=0
- PASS — 5. tenant A update on tenant A row succeeds — status=ABSENT
- PASS — 6. tenant A update on tenant B row rejected — NotFound
- PASS — 7. tenant B row unchanged after rejected update — status=PRESENT
- PASS — 8. tenant A delete on tenant A row succeeds — Attendance record deleted
- PASS — 9. tenant A delete on tenant B row rejected — NotFound
- PASS — 10. tenant B row unchanged after rejected delete — count=1
- PASS — 11. bulkApply tenant A creates rows tagged tenant A — created=0 tagged=2
- PASS — 12. bulkApply tenant B emp rejected; no rows — threw=true count=0
- PASS — 13. NULL-tenant legacy row not mutated under pilot — threw=true status=PRESENT tenantId=null
- PASS — 14. concurrent ALS frames stamp correct tenantId — A=11111111 B=22222222
- PASS — 15. audit row tenant A mutation carries tenantId=A (audit pilot ON) — tenantId=11111111
- PASS — 16. rejected tenant B mutation does not emit audit row — before=0 after=0
- PASS — 17. exportExcel under tenant A refuses tenant B employee — BadRequest
