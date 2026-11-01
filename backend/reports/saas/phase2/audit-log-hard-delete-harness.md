# Phase 2.54 — audit-log hard-delete harness

**17/17 PASS**

- PASS — 1. dry-run deletes zero rows — mode=dry-run deleted=0
- PASS — 2. dry-run reports correct eligible count for tenant A (>=2) — eligible=3
- PASS — 3. apply refused when AUDIT_LOG_HARD_DELETE_ENABLED=false — AUDIT_LOG_HARD_DELETE_ENABLED=false
- PASS — 4. apply refused when AUDIT_LOG_HARD_DELETE_APPLY=false — AUDIT_LOG_HARD_DELETE_APPLY=false
- PASS — 5. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate) — all 3 gates wired
- PASS — 6. apply refuses tenant scope without tenant id — scope=tenant requires AUDIT_LOG_HARD_DELETE_TENANT_ID
- PASS — 7. apply hard-deletes only already soft-deleted rows older than grace — deleted=3
- PASS — 8. apply does not delete rows where deletedAt IS NULL — live row preserved
- PASS — 9. apply does not delete soft-deleted rows inside grace window — inside-grace row preserved
- PASS — 10. tenant A hard-delete does not touch tenant B rows — B old row preserved
- PASS — 7b. tenant A old eligible rows physically removed — A1.exists=false A2.exists=false
- PASS — 11. tenant B hard-delete does not touch tenant A rows — B.gone=true A.live=true A.grace=true deleted=1
- PASS — 12. null-tenant scope deletes only NULL-tenant eligible rows — null.gone=true A.still=true B.still=true deleted=1
- PASS — 13. all scope deletes all eligible rows only when explicitly requested — A.gone=true B.gone=true null.gone=true live=true grace=true deleted=4
- PASS — 14. rerun apply is idempotent (zero deletes) — deleted=0 eligible=0
- PASS — 15. DELETE FROM audit_logs lives ONLY in scripts/ + the pre-existing recycle-bin admin path — allowed sites only
- PASS — 16. scanner registers phase254-audit-log-hard-delete — tag found
