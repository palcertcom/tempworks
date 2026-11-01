# Phase 2.43 — compliance → notifications event coupling

**12/12 PASS**

- PASS — 1. flag off (default): no coupling notifications created — before=0 after=0 notify=absent
- PASS — 2. flag on + TENANT_JOB_FANOUT_ENABLED=false: refused; no notifications — notify={"refused":"tenant fan-out gates off (TENANT_AWARE_JOBS_ENABLED / TENANT_JOB_FANOUT_ENABLED)"}
- PASS — 3. flag on + TENANT_AWARE_JOBS_ENABLED=false: refused; no notifications — notify={"refused":"tenant fan-out gates off (TENANT_AWARE_JOBS_ENABLED / TENANT_JOB_FANOUT_ENABLED)"}
- PASS — 4. compliance pilot inactive: upstream refusal; no notifications — msg=refused: TENANT_PRISMA_PILOT_ENABLED=false
- PASS — 5. happy path: notifications created with tenantId=A only — total=1 newA=1 notified=1
- PASS — 6. tenant B users do not receive tenant A notifications — newB=0
- PASS — 7. NULL-tenant notifications are NOT created — newNull=0
- PASS — 8. notification fan-out runs inside per-tenant ALS frame (tenantId stamped) — newA=1 newB=0 newNull=0
- PASS — 9. notification fan-out failure captured (no throw) — notify={"error":"synthetic fan-out failure"}
- PASS — 10. raw generateAlerts() body does NOT call notification fan-out — bodyLen=1476 callsNotify=false
- PASS — 11. ComplianceCron body still calls only runScheduledComplianceAlertGeneration() — OK
- PASS — 12. ComplianceScheduler body does not call notification helpers directly — OK
