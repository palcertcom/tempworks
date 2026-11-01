# Phase 2.52 — audit-log retention preview

**10/10 PASS**

- PASS — 1. retention disabled ⇒ enabled=false; no destructive action — enabled=false candidate=3
- PASS — 2. preview returns candidate count only (no rows array) — keys=enabled,days,cutoffIso,candidateCount,tenantId
- PASS — 3. tenant A preview counts only tenant A rows — count=3
- PASS — 4. tenant B preview counts only tenant B rows — count=2
- PASS — 5. NULL-tenant rows excluded from tenant preview; included in NULL preview — nullCount=1 A=3
- PASS — 6. date threshold respected (large days ⇒ zero candidates) — days=10000 count=0
- PASS — 7. no rows are deleted or modified (snapshot before/after equal) — before=983 after=983
- PASS — 8. preview is idempotent — a=3 b=3
- PASS — 9. retention days env fallback works for invalid values (defaults to 365) — days=365
- PASS — 10. retention preview source contains no destructive Prisma calls — noDestructive=true hasCount=true
