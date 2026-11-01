# Phase 3.2 — duplicate cleanup harness

**22/22 PASS**

- PASS — 1. plan runs read-only — roJson=true noWrites=true exit=0
- PASS — 2. plan writes JSON and MD — md=true
- PASS — 3. Employee.email exact same-tenant dup detected — keep=00000000 del=1
- PASS — 4. Employee.employeeNumber exact same-tenant dup detected — keep=00000000
- PASS — 5. Applicant.email exact same-tenant dup detected — keep=00000000
- PASS — 6. conflicting active dup classified as conflicting_active — softDel=0
- PASS — 7. NULL-tenant dup reported separately — present
- PASS — 8. cross-tenant same email reported as observation, not blocker — present
- PASS — 9. plan MD masks emails — masked
- PASS — 10. apply refused when PHASE3_DUPLICATE_CLEANUP_ENABLED=false — dryRun=true reason="PHASE3_DUPLICATE_CLEANUP_ENABLED is not true" rows=0
- PASS — 11. apply refused when PHASE3_DUPLICATE_CLEANUP_APPLY=false — dryRun=true reason="PHASE3_DUPLICATE_CLEANUP_APPLY is not true" rows=0
- PASS — 12. apply refused outside SAFE_CLONE/SAFE_STAGING — dryRun=true reason="classification=UNKNOWN is not SAFE_CLONE/SAFE_STAGING"
- PASS — 13. apply soft-deletes only exact duplicate lower-priority row — softDeleted=3 old.deletedAt=set new.deletedAt=null active=1
- PASS — 14. apply does not mutate conflicting_active group — A=null B=null
- PASS — 15. apply does not mutate NULL-tenant rows — A=null B=null
- PASS — 16. apply does not mutate cross-tenant observation rows — A=null B=null
- PASS — 17. apply is idempotent (second run no-ops) — softDeleted=0 alreadyDeleted=3
- PASS — 18. before/after duplicate count decreases for exact groups — before=2 after=1
- PASS — 19. no hard-delete (DELETE FROM) source calls exist — none
- PASS — 20. Phase 3.1 readiness wiring intact — pkg.json
- PASS — 21. Phase 3.0 readiness wiring intact — pkg.json
- PASS — 22. cumulative regression chain outputs present — present=6/6
