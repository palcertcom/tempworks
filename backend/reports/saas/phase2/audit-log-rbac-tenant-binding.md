# Phase 2.56 — audit-log RBAC tenant binding

**15/15 PASS**

- PASS — 1. tenant A FULL_ACCESS actor sees only tenant A audit rows — count=3
- PASS — 2. tenant A FULL_ACCESS actor does not see tenant B audit rows — B excluded
- PASS — 3. tenant A FULL_ACCESS actor does not see NULL-tenant audit rows — NULL excluded
- PASS — 4. tenant B FULL_ACCESS actor sees only tenant B audit rows — count=2
- PASS — 5. entity filter under tenant A cannot leak tenant B row — all tenantA
- PASS — 6. entityId filter for tenant B id under tenant A returns empty — count=0
- PASS — 7. READ_ROLES actor requires active tenant context in pilot mode — ForbiddenException raised
- PASS — 8. FULL_ACCESS without global gate also refuses without ALS frame — ForbiddenException raised
- PASS — 9. FULL_ACCESS role with global gate OFF remains tenant-scoped in pilot — all tenantA
- PASS — 10. FULL_ACCESS with explicit global gate ON sees global rows (B + NULL) — count=6 hasB=true hasNull=true
- PASS — 11. non-allowed role cannot read audit rows (RBAC roles decorator pinned) — roles pinned + no Random Role
- PASS — 12. pagination under tenant A cannot page into tenant B rows — p1=2 p2=1
- PASS — 13. getStats respects tenant-bound RBAC scope — total=196
- PASS — 14. concurrent ALS frames remain isolated for findAll — A=3 B=2
- PASS — 15. assertAuditReadAccess + auditTenantWhereForActor + global gate are wired — all helpers present + called
