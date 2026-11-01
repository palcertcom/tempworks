# Phase 2.51 — cross-module audit-log backfill harness

**20/20 PASS**

- PASS — 1. dry-run updates zero rows — updated=0
- PASS — 2. dry-run reports candidates per entity — candidate=8 entities=6
- PASS — 3. apply refused when flag false — CROSS_MODULE_AUDIT_BACKFILL_APPLY=false (default; dry-run)
- PASS — 4. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate) — flag+SAFE both required
- PASS — 5. apply updates eligible Document audit rows only — updated=2
- PASS — 6. apply updates eligible FinancialRecord audit rows only — updated=2
- PASS — 7. apply updates eligible ComplianceAlert audit rows only — updated=1
- PASS — 8. apply updates eligible Notification audit rows only — updated=1
- PASS — 9. WorkPermit handled per schema (direct tenantId join) — updated=1
- PASS — 10. Visa handled per schema (direct tenantId join) — updated=1
- PASS — 11. already tenant-stamped audit rows are not overwritten — preserved
- PASS — 12. missing target rows are skipped — NULL preserved
- PASS — 13. target rows with NULL tenantId are skipped — NULL preserved
- PASS — 14. wrong-entity / non-target audit rows not touched (User sentinel still NULL) — tenantId=null
- PASS — 15. non-allow-listed entity rows are not touched (User entity stays NULL) — sentinel preserved
- PASS — 16. seeded candidates become tenant-stamped after apply — all stamped
- PASS — 17. rerun apply is idempotent (zero updates for seeded subset) — updated=0
- PASS — 18. per-entity updated counts cover all 6 target entities — all >=1
- PASS — 19. scanner registers phase251-cross-module-audit-backfill — tag found
- PASS — 20. backfill module exports runBackfill + uses env+SAFE guards — export + guards present
