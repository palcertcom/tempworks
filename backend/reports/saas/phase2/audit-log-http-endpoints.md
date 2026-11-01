# Phase 2.57 — audit-log HTTP endpoints

**18/18 PASS**

- PASS — 1. list endpoint under tenant A returns only tenant A rows — count=2
- PASS — 2. list endpoint under tenant A excludes tenant B rows — B excluded
- PASS — 3. list endpoint under tenant A excludes NULL-tenant rows — NULL excluded
- PASS — 4. list endpoint preserves entity filter — count=2
- PASS — 5. list endpoint preserves entityId filter without tenant leakage — count=0
- PASS — 6. list endpoint preserves date range filter — count=1
- PASS — 7. list endpoint preserves pagination shape — page=1 limit=1
- PASS — 8. byId endpoint returns tenant A row for tenant A — id=b40b350c
- PASS — 9. byId endpoint hides tenant B row from tenant A (NotFound) — NotFoundException
- PASS — 10. stats endpoint counts only tenant A rows — total=196 entities=10
- PASS — 11. retention-preview endpoint returns count only and modifies zero rows — candidate=3 before=983 after=983
- PASS — 12. retention-preview endpoint excludes tenant B rows for tenant A — tenantId=11111111
- PASS — 13. missing ALS tenant context refuses safely (Forbidden) — ForbiddenException
- PASS — 14. controller @Roles pinned to System Admin / Compliance Officer only — allowed=true noRecruiter=true
- PASS — 15. FULL_ACCESS with global gate OFF remains tenant-bound (delegates to LogsService) — covered by cases 1-3 (System Admin sees only tenant A)
- PASS — 16. FULL_ACCESS with global gate ON sees global rows (B + NULL) — count=4 hasB=true hasNull=true
- PASS — 17. no HTTP route exposes retention apply, soft-delete, or hard-delete — GET only
- PASS — 18. controller does not call retention/hard-delete scripts — no script imports
