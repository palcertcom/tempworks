# Phase 2.47 — attendance isolation

**12/12 PASS**

- PASS — 1. tenant A list returns only tenant A employees — total=6 hasB=false
- PASS — 2. tenant A getEmployeeAttendance for tenant B raises NotFound — NotFound
- PASS — 3. NULL-tenant legacy row excluded under pilot — records=0
- PASS — 4. summary counts only tenant A records — records=3
- PASS — 5. tenant A date-range list excludes tenant B — total=6
- PASS — 6. employee filter rejects tenant B employee under pilot A — NotFound
- PASS — 7. tenant A update on tenant B record raises NotFound — NotFound
- PASS — 8. tenant B row unchanged after rejected mutation — status=PRESENT
- PASS — 9. create under tenant A returns id+employee — id=87a23f17
- PASS — 10. tenant A bulk-apply for tenant B employee raises NotFound — NotFound
- PASS — 11. concurrent ALS frames remain isolated — A.total=6 B.total=2
- PASS — 12. allow-list nothing ⇒ NULL-tenant row visible (legacy) — records=1
