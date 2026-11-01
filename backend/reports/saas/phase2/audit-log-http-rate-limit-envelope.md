# Phase 2.60 — audit-log HTTP rate-limit envelope

**17/17 PASS**

- PASS — 1. limiter disabled ⇒ no Retry-After header added — headers=none
- PASS — 2. enabled RPM=1 ⇒ second list request returns 429 — status=429
- PASS — 3. 429 body has error="rate_limited" — error=rate_limited
- PASS — 4. 429 body has retryAfterSeconds positive integer — retryAfterSeconds=60
- PASS — 5. 429 body has limit — limit=1
- PASS — 6. 429 body has remaining=0 — remaining=0
- PASS — 7. 429 body has windowSeconds — windowSeconds=60
- PASS — 8. Retry-After header equals retryAfterSeconds — header=60 envelope=60
- PASS — 9. stats route returns same structured 429 envelope — status=429 error=rate_limited
- PASS — 10. retention-preview returns same structured 429 envelope — status=429 error=rate_limited
- PASS — 11. export.csv returns structured 429 envelope, not CSV — bodyLen=0 contentType=undefined
- PASS — 12. byId route returns same structured 429 envelope — status=429 error=rate_limited
- PASS — 13. successful export.csv still returns text/csv and export headers — Content-Type=text/csv; charset=utf-8
- PASS — 14. tenant A 429 envelope does not affect tenant B — A=429 B.passes=true
- PASS — 15. global FULL_ACCESS rate-limit envelope uses global/user key — status=429 key=global
- PASS — 16. missing ALS in pilot returns Forbidden, not rate-limit envelope — message=Audit-log read requires an active tenant context
- PASS — 17. every TenantAuditController GET handler passes res to enforceRateLimit — routes=5 wired=5
