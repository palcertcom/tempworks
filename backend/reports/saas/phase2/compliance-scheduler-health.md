# Phase 2.44 — compliance scheduler health signal

**12/12 PASS**

- PASS — 1. scheduler disabled: status=skipped — {"job":"compliance-alert-generation","status":"skipped","skipped":true,"processed":0,"succeeded":0,"failed":0,"alertsCreated":0,"notifySucceeded":0,"notifySkipped":0,"notifyFailed":0,"notifyDeduped":0,"cron":"0 */6 * * *","timestamp":"2026-05-10T21:33:38.613Z"}
- PASS — 2. fan-out off: status=skipped (refused), processed=0 — status=skipped refused=TENANT_JOB_FANOUT_ENABLED=false
- PASS — 3. pilot inactive: status=skipped (refused) — status=skipped refused=pilot inactive: TENANT_PRISMA_PILOT_ENABLED=false
- PASS — 4. happy path: status=ok, processed === active tenant count (2) — {"job":"compliance-alert-generation","status":"ok","skipped":false,"processed":2,"succeeded":2,"failed":0,"alertsCreated":2,"notifySucceeded":0,"notifySkipped":0,"notifyFailed":0,"notifyDeduped":0,"cron":"0 */6 * * *","timestamp":"2026-05-10T21:33:38.880Z"}
- PASS — 5. one tenant failure: status=partial_failure, failed=1, no throw — {"job":"compliance-alert-generation","status":"partial_failure","skipped":false,"processed":2,"succeeded":1,"failed":1,"alertsCreated":1,"notifySucceeded":0,"notifySkipped":0,"notifyFailed":0,"notifyDeduped":0,"cron":"0 */6 * * *","timestamp":"2026-05-10T21:33:38.941Z"}
- PASS — 6. notify error: status=partial_failure, notifyFailed=1 — {"job":"compliance-alert-generation","status":"partial_failure","skipped":false,"processed":2,"succeeded":2,"failed":0,"alertsCreated":1,"notifySucceeded":0,"notifySkipped":1,"notifyFailed":1,"notifyDeduped":0,"cron":"0 */6 * * *","timestamp":"2026-05-10T21:33:38.982Z"}
- PASS — 7. scheduler-level error: status=failed, no throw — {"job":"compliance-alert-generation","status":"failed","skipped":false,"processed":0,"succeeded":0,"failed":0,"alertsCreated":0,"notifySucceeded":0,"notifySkipped":0,"notifyFailed":0,"notifyDeduped":0,"error":"synthetic dispatch failure","cron":"0 */6 * * *","timestamp":"2026-05-10T21:33:39.005Z"}
- PASS — 8. health fingerprint emitted EXACTLY ONCE per tick — count=1
- PASS — 9. health log does NOT include sensitive sample payloads — len=285 found=none
- PASS — 10. ComplianceCron.tick calls only runScheduledComplianceAlertGeneration() — present=true
- PASS — 11. ComplianceCron.tick does not call dispatch directly — present=false
- PASS — 12. ComplianceCron.tick does not call notification helpers — present=false
