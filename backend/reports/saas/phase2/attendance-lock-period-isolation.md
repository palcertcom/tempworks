# Phase 2.49 — attendance lock-period isolation

**13/13 PASS**

- PASS — 1. pilot off lockPeriod produces NULL-tenant row — tenantId=null
- PASS — 2. pilot A lockPeriod stamps tenantId = A — tenantId=11111111
- PASS — 3. pilot B lockPeriod for SAME (year, month) succeeds — idA=c8f804ec idB=592082a1
- PASS — 4. tenant A listLockedPeriods returns only A rows — count=1 hasA=true
- PASS — 5. tenant B listLockedPeriods returns only B rows — count=1 hasB=true
- PASS — 6. tenant A unlock on tenant B row rejected; B row intact — threw=true count=1
- PASS — 7. tenant B lock (Y,9) does NOT block tenant A mutation in (Y,9) — id=8dace50e
- PASS — 8. tenant A lock blocks tenant A mutation — BadRequest (locked)
- PASS — 9. tenant A lock (Y,M) does NOT block tenant B mutation in (Y,10) — id=0098a147
- PASS — 10. NULL-tenant global lock does NOT block tenant A pilot mutation — id=3f49fe54
- PASS — 11. concurrent ALS frames: lock checks isolated — A=true B=false
- PASS — 12. unique constraint permits SAME (year, month) across tenants — idA=c8f804ec idB=592082a1
- PASS — 13. duplicate (tenantId, year, month) on same tenant rejected — BadRequest already locked
