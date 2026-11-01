# Phase 3.6 — PlatformAdmin dual-read guard
**14/14 PASS**
- PASS — 1. legacy user with no PlatformAdmin returns false (Phase 3.9 supersedes legacy signal) — uLegacy
- PASS — 2. PlatformAdmin row user (non-system agency) returns platform admin — uNewOnly
- PASS — 3. user with both signals returns platform admin — uBoth
- PASS — 4. user with neither signal returns false — uNeither
- PASS — 5. deleted/inactive user returns false — uDeleted
- PASS — 6. existing PlatformAdmin row is not mutated by isPlatformAdmin() — level=SUPER grantedBy=phase360-test
- PASS — 7. Agency row is not mutated by isPlatformAdmin() (column dropped in Phase 3.9; row presence preserved) — sysAgency=00000000-0000-0000-0000-0000000036SA
- PASS — 11. PlatformAuditLog write is not attempted (table absent, no error raised) — tableExists=false
- PASS — 8. missing user returns false — result=true
- PASS — 9. PLATFORM_ADMIN_DUAL_READ_ENABLED flag inert under Phase 3.9 (PlatformAdmin sole authority) — uNewOnly=true uLegacy=false
- PASS — 10. source-level inventory captures remaining Agency.isSystem references — totalSites=9 mustHave=2
- PASS — 12. Phase 3.5 platform-admin-backfill wiring intact — pkg.json
- PASS — 13. Phase 3.4 employee unique harness wiring intact — pkg.json
- PASS — 14. cumulative regression chain outputs present — present=10/10
## Agency.isSystem inventory (9 sites)
| file | line | text |
| --- | --- | --- |
| src/saas/jobs/tenant-job-fanout-planner.ts | 28 | `readonly isSystem?: boolean;` |
| src/saas/jobs/tenant-job-fanout-planner.ts | 122 | `if (excludeSys && c.isSystem === true) {` |
| src/roles/roles.service.ts | 92 | `if (role.isSystem && dto.name && dto.name !== role.name) throw new BadRequestException('Cannot rename system roles');` |
| src/roles/roles.service.ts | 122 | `if (role.isSystem) throw new BadRequestException('Cannot delete system roles');` |
| src/recycle-bin/hard-delete.service.ts | 306 | `if (record.isSystem) {` |
| src/recycle-bin/recycle-bin.service.ts | 1147 | `extra: { isSystem: r.isSystem },` |
| src/auth/auth.service.ts | 551 | `agency: user.agency ? { id: user.agency.id, name: user.agency.name, isSystem: await this.platformAdminAccess.isPlatformAdmin(user.id) } : null,` |
| src/agencies/agencies.service.ts | 157 | `if ('isSystem' in (dto as any)) delete (dto as any).isSystem;` |
| src/agencies/agencies.service.ts | 210 | `if ('isSystem' in (dto as any)) delete (dto as any).isSystem;` |