# Phase 2.50 — attendance audit-log backfill harness

**13/13 PASS**

- PASS — 1. dry-run updates zero rows — updated=0 applied=false
- PASS — 2. dry-run reports correct candidate count — candidate=10
- PASS — 3. apply refused when flag false — mode=dry-run reason=ATTENDANCE_AUDIT_BACKFILL_APPLY=false (default; dry-run)
- PASS — 4. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate) — flag+SAFE both required
- PASS — 5. apply updates only AttendanceRecord rows with matching ar.tenantId — mode=apply updated=10 candidate=10
- PASS — 6. apply does not overwrite already tenant-stamped rows — tenantId=11111111
- PASS — 7. apply skips missing AttendanceRecord entityId — tenantId=null
- PASS — 8. apply skips attendance rows with NULL tenantId — tenantId=null
- PASS — 9. apply does not touch non-AttendanceRecord audit rows — entity=Employee tenantId=null
- PASS — 10. seeded candidate becomes tenant-stamped after apply — tenantId=11111111
- PASS — 11. rerun apply is idempotent (zero updates) — updated=0
- PASS — 12. backfill module exports runBackfill + uses env+SAFE guards — export + guards present
- PASS — 13. scanner registers phase250-attendance-audit-backfill — tag found
