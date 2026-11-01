# Phase 3.12 — PlatformAdmin controller

**16/16 PASS**

- PASS — 1. flag off → all routes throw NotFoundException (HTTP_DISABLED) — rejects=3/3
- PASS — 2. SUPER can grant SUPPORT — PLATFORM_ADMIN_GRANTED
- PASS — 3. SUPER can grant OPERATOR — PLATFORM_ADMIN_GRANTED
- PASS — 4. SUPER can grant SUPER — PLATFORM_ADMIN_GRANTED
- PASS — 5. SUPPORT cannot grant (service rejects) — forbidden
- PASS — 6. OPERATOR cannot grant — forbidden
- PASS — 7. non-PlatformAdmin user cannot grant — forbidden
- PASS — 8. SUPER can revoke another PlatformAdmin — PLATFORM_ADMIN_REVOKED
- PASS — 9. self-revoke rejected — forbidden
- PASS — 10. list returns PlatformAdmin rows — count=5
- PASS — 11. grant emits PlatformAuditLog — grantRows=3
- PASS — 12. revoke emits PlatformAuditLog — revokeRows=1
- PASS — 13. duplicate grant deterministic (IDEMPOTENT vs LEVEL_CHANGED) — idem=PLATFORM_ADMIN_GRANT_IDEMPOTENT change=PLATFORM_ADMIN_LEVEL_CHANGED
- PASS — 14. controller delegates only to PlatformAdminService — usesService=true usesPrisma=false
- PASS — 15. Phase 3.11 grant/revoke harness wiring intact — pkg.json
- PASS — 16. cumulative regression chain outputs present — present=12/12
