# Phase 2.59 — audit-log HTTP rate limit

**17/17 PASS**

- PASS — 1. limiter disabled ⇒ list behaves as Phase 2.58 — count=2
- PASS — 2. limiter disabled ⇒ export.csv behaves as Phase 2.58 — bodyLen=437
- PASS — 3. RPM=2 ⇒ third list request returns 429 — 429
- PASS — 10. rejected 429 does NOT call LogsService data query — before=2 after=2
- PASS — 4. tenant A exhaustion does not block tenant B — A=429 B.pass=true
- PASS — 5. tenant B exhaustion does not block tenant A separately — B=429
- PASS — 6. stats route is rate-limited — 429
- PASS — 7. retention-preview route is rate-limited — 429
- PASS — 8. export.csv route is rate-limited — 429
- PASS — 9. byId route is rate-limited — 429
- PASS — 11. invalid AUDIT_LOG_HTTP_RATE_LIMIT_RPM falls back to disabled (no 429) — no 429
- PASS — 12. missing ALS in pilot still raises Forbidden (RBAC reachable through limiter) — first=forbidden second=429
- PASS — 13. FULL_ACCESS with global gate OFF is tenant-keyed — B passes
- PASS — 14. FULL_ACCESS with global gate ON is global/user-keyed — 429 across tenants
- PASS — 15. limiter window expiry allows requests again — blocked=true allowedAfterWait=true
- PASS — 16. every TenantAuditController GET handler invokes enforceRateLimit — routes=5 wired=5
- PASS — 17. no destructive routes added — GET only
