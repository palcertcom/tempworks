# Phase 2.58 — audit-log CSV export

**17/17 PASS**

- PASS — 1. export under tenant A returns only tenant A rows — rows=32
- PASS — 2. export under tenant A excludes tenant B rows — B excluded
- PASS — 3. export under tenant A excludes NULL-tenant rows — NULL excluded
- PASS — 7. CSV header contains expected safe columns — id,tenantId,createdAt,userId,userEmail,action,entity,entityId,ipAddress,userAgent
- PASS — 4. entity filter preserved — rows=32
- PASS — 5. entityId filter cannot leak tenant B row — rows=0
- PASS — 6. date range filter preserved (last 6h ⊂ all 25h) — rows=13
- PASS — 8. CSV escaping handles comma, quote, and newline safely — tricky row escaped
- PASS — 9. row cap enforced — rows=5 capped=true max=5
- PASS — 10. invalid AUDIT_LOG_EXPORT_MAX_ROWS falls back to default 50000 — max=50000
- PASS — 11. FULL_ACCESS with global gate OFF remains tenant-bound — B=true NULL=true
- PASS — 12. FULL_ACCESS with global gate ON exports global rows (B + NULL) — B=true NULL=true
- PASS — 13. missing ALS tenant context refuses safely (Forbidden) — ForbiddenException
- PASS — 14. controller @Roles allow-list pinned for export.csv — allow-list pinned
- PASS — 15. export route is GET-only — GET only
- PASS — 16. no Post/Put/Patch/Delete in controller — GET only
- PASS — 17. controller does not import retention/hard-delete scripts — no script imports
