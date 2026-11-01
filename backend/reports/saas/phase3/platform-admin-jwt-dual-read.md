# Phase 3.7 — JWT dual-read stamp

**15/15 PASS**

- PASS — 1. legacy user (no PlatformAdmin) stamps agencyIsSystem=false (Phase 3.9 supersedes legacy) — agencyIsSystem=false
- PASS — 2. PlatformAdmin-only user stamps agencyIsSystem=true — agencyIsSystem=true
- PASS — 3. user with both signals stamps true — agencyIsSystem=true
- PASS — 4. user with neither signal stamps false — agencyIsSystem=false
- PASS — 5. PLATFORM_ADMIN_DUAL_READ_ENABLED flag inert under Phase 3.9 — uNewOnly=true uLegacy=false
- PASS — 6. inactive user → existing UnauthorizedException preserved — rejected
- PASS — 7. JwtStrategy returns the existing field shape — keys=agencyId,agencyIsSystem,email,firstName,id,lastName,role,roleId
- PASS — 8. downstream check (isExternalActor) consumes agencyIsSystem unchanged — legacy.ext=true newOnly.ext=false neither.ext=true
- PASS — 9. PlatformAdminAccessService called exactly once per validate — calls=4 (4 successful validates)
- PASS — 10. PlatformAuditLog write is not attempted (table absent, no error raised) — tableExists=false
- PASS — 11. Agency row unchanged after validate (Phase 3.9 — column dropped) — sysAgency=00000000-0000-0000-0000-0000000037SA
- PASS — 12. PlatformAdmin rows unchanged after validate — level=SUPER grantedBy=phase370-test
- PASS — 13. Phase 3.6 dual-read guard wiring intact — pkg.json
- PASS — 14. Phase 3.5 backfill wiring intact — pkg.json
- PASS — 15. cumulative regression chain outputs present — present=11/11
