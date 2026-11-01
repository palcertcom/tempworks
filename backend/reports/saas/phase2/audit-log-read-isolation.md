# Phase 2.52 — audit-log read isolation

**10/10 PASS**

- PASS — 1. tenant A sees only audit rows with tenantId=A — count=3 allA=true
- PASS — 2. tenant A does not see tenant B audit rows — actions=ISO_A1,ISO_A2,ISO_A3
- PASS — 3. tenant A does not see NULL-tenant audit rows in pilot mode — NULL excluded
- PASS — 4. tenant B sees only tenant B rows — count=2 allB=true
- PASS — 5. entity filter under tenant A does not leak tenant B rows — count=3
- PASS — 6. entityId filter for tenant B entity under tenant A returns empty — count=0
- PASS — 7. count under tenant A includes only tenant A rows — total=3
- PASS — 8. pagination under tenant A cannot page into tenant B rows — p1=2 p2=1
- PASS — 9. concurrent ALS frames remain isolated — A=3 B=2
- PASS — 10. pilot opt-out (allow-list nothing) returns legacy union (incl. B + NULL) — count=6 hasB=true hasNull=true
