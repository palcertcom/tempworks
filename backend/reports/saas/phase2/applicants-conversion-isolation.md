# Phase 2.32 — applicants conversion isolation

**9/9 PASS**

- PASS — 1. tenant A: convert(tenantB-id) rejected; no Employee created — threw=true employees=0
- PASS — 2. pilot: Employee.tenantId = A — tenantId=11111111-1111-1111-1111-111111111111
- PASS — 3. pilot: tenant A document re-linked to EMPLOYEE — entityType=EMPLOYEE
- PASS — 4. pilot: tenant A FinancialRecord re-linked to EMPLOYEE — entityType=EMPLOYEE
- PASS — 5. pilot: tenant B document NOT smuggled — entityType=APPLICANT entityId=f37f5edd
- PASS — 6. pilot: tenant B FinancialRecord NOT smuggled — entityType=APPLICANT
- PASS — 7. legacy: both rows re-linked (today's behaviour) — A=EMPLOYEE B=EMPLOYEE
- PASS — 8. concurrent ALS frames: A→A, B→B — eA=11111111-1111-1111-1111-111111111111 eB=22222222-2222-2222-2222-222222222222
- PASS — 9. source-level: phase232 patterns present — OK
