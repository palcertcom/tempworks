# Phase 3.9 — drop Agency.isSystem

**14/14 PASS**

- PASS — 1. migration drops only agencies.isSystem — DROP COLUMN agencies.isSystem
- PASS — 2. migration does not drop other agency columns — isSystem only
- PASS — 3. Prisma schema no longer contains Agency.isSystem — removed
- PASS — 4. PlatformAdminAccessService no longer reads Agency.isSystem — no non-comment isSystem reads
- PASS — 5. PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK is inert (column gone) — uNone.agencyIsSystem=false
- PASS — 6. JwtStrategy output still includes agencyIsSystem — keys=id,email,firstName,lastName,role,roleId,agencyId,agencyIsSystem
- PASS — 7. PlatformAdmin user stamps agencyIsSystem=true — agencyIsSystem=true
- PASS — 8. non-PlatformAdmin user stamps agencyIsSystem=false — agencyIsSystem=false
- PASS — 9. runtime inventory: no Agency.isSystem authorization read outside allow-list — clean
- PASS — 10. PlatformAuditLog still not written (table absent) — tableExists=false
- PASS — 11. down migration re-adds column default false + caveat documented — addsCol=true caveat=true
- PASS — 12. Phase 3.8 / 3.7B harness wiring intact — pkg.json
- PASS — 13. Phase 3.5 backfill harness updated for legacy criterion removal — updated
- PASS — 14. cumulative regression chain outputs present — present=15/15
