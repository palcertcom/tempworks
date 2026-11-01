# Phase 2.32 — applicants conversion equivalence

**7/7 PASS**

- PASS — 1. legacy convert: response shape preserved — employeeId=bb8ae0c2
- PASS — 3. legacy convert: Employee.tenantId NULL — tenantId=null
- PASS — 5. legacy convert: Document re-linked to EMPLOYEE — entityType=EMPLOYEE
- PASS — 6. legacy convert: FinancialRecord re-linked to EMPLOYEE — entityType=EMPLOYEE
- PASS — 7. legacy convert: Applicant soft-deleted + back-pointer — deletedAt=true backPointer=true
- PASS — 2. pilot convert: response shape preserved — employeeId=6d51b0fc
- PASS — 4. pilot convert: Employee.tenantId = A — tenantId=11111111-1111-1111-1111-111111111111
