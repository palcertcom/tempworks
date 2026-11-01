# Phase 2.40 — compliance real scheduler

**11/11 PASS**

- PASS — 1. scheduler disabled: skipped result, zero dispatch calls — skipped=true dispatchCalls=0
- PASS — 2. scheduler ON + fan-out OFF: dispatch refuses — refused=TENANT_JOB_FANOUT_ENABLED=false dispatchCalls=1
- PASS — 3. scheduler + fan-out ON + pilot OFF: dispatch refuses — refused=pilot inactive: TENANT_PRISMA_PILOT_ENABLED=false
- PASS — 4. scheduler+fanout+pilot: processes ACTIVE tenants only — processed=2 ids=11111111,22222222
- PASS — 5. scheduler creates no NULL-tenant alerts — newNull=false
- PASS — 6. scheduler creates no cross-tenant alerts — newA=1 newB=1
- PASS — 7. scheduler body never calls raw generateAlerts() — raw=false
- PASS — 8. scheduler body never calls generateAlertsForTenant() directly — forTenant=false
- PASS — 9. exactly one dispatch call per tick — dispatchCalls=1 dispatchSrc=true
- PASS — 10. concurrent ticks remain ALS-isolated — r1=2 r2=2 dispatchCalls=2
- PASS — 11. unexpected dispatch failure captured (no crash) — error=synthetic dispatch failure
