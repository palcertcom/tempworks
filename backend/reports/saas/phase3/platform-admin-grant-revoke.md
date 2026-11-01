# Phase 3.11 — PlatformAdmin grant/revoke service

**22/22 PASS**

- PASS — 1. SUPER actor can grant SUPPORT to active user — action=PLATFORM_ADMIN_GRANTED level=SUPPORT
- PASS — 2. SUPER actor can grant OPERATOR to active user — action=PLATFORM_ADMIN_GRANTED level=OPERATOR
- PASS — 3. SUPER actor can grant SUPER to active user — action=PLATFORM_ADMIN_GRANTED level=SUPER
- PASS — 4. non-SUPER PlatformAdmin cannot grant — forbidden
- PASS — 5. non-PlatformAdmin cannot grant — forbidden
- PASS — 6. cannot grant missing user — not-found
- PASS — 7. cannot grant inactive/deleted user — rejected
- PASS — 8. duplicate-grant deterministic (IDEMPOTENT same-level, LEVEL_CHANGED different-level) — same=PLATFORM_ADMIN_GRANT_IDEMPOTENT diff=PLATFORM_ADMIN_LEVEL_CHANGED
- PASS — 9. grant emits PlatformAuditLog — t1.auditRows=3
- PASS — 10. SUPER actor can revoke target PlatformAdmin — action=PLATFORM_ADMIN_REVOKED
- PASS — 11. non-SUPER cannot revoke — forbidden
- PASS — 12. non-PlatformAdmin cannot revoke — forbidden
- PASS — 13. cannot self-revoke — forbidden
- PASS — 14. revoke emits PlatformAuditLog — t2.revokeRows=1
- PASS — 15. list returns only PlatformAdmin rows — count=4
- PASS — 16. PlatformAuditLog rows carry actorId/action/reason/target — shape ok
- PASS — 17. PlatformAdminAccessService treats granted user as platform admin — uTarget3.isPa=true
- PASS — 18. PlatformAdminAccessService treats revoked user as NOT platform admin — uTarget2.isPa=false
- PASS — 19. JWT stamp reflects grant/revoke at validate() time — t3=true t2=false
- PASS — 20. Phase 3.10 cleanup harness wiring intact — pkg.json
- PASS — 21. Phase 3.9 drop-agency-is-system wiring intact — pkg.json
- PASS — 22. cumulative regression chain outputs present — present=17/17
