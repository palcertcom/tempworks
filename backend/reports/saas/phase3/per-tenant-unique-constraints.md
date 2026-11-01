# Phase 3.3 — per-tenant unique constraints

**19/19 PASS**

- PASS — 1. CREATE UNIQUE INDEX IF NOT EXISTS for employees(tenantId,email) — employees_tenant_email_unique
- PASS — 2. CREATE UNIQUE INDEX IF NOT EXISTS for employees(tenantId,employeeNumber) — employees_tenant_employee_number_unique
- PASS — 3. CREATE UNIQUE INDEX IF NOT EXISTS for applicants(tenantId,email) — applicants_tenant_email_unique
- PASS — 4. migration SQL does not DROP existing global constraints — no DROPs
- PASS — 5. migration SQL does not UPDATE/DELETE data — no UPDATE/DELETE in up
- PASS — 6. down migration drops only the new indexes — safe
- PASS — 15. existing global unique constraints still exist after migration — employees_email_key, employees_employeeNumber_key
- PASS — 7. same-tenant duplicate Employee.email rejected by DB — code=23505 constraint=employees_tenant_email_unique
- PASS — 8. different-tenant same Employee.email still rejected (global UNIQUE retained; Phase 3.4 will drop) — code=23505 constraint=employees_email_key
- PASS — 9. same-tenant duplicate Applicant.email rejected by DB — code=23505 constraint=applicants_tenant_email_unique
- PASS — 10. different-tenant same Applicant.email allowed (no global Applicant.email UNIQUE) — inserted
- PASS — 11. same-tenant duplicate Employee.employeeNumber rejected by DB — code=23505 constraint=employees_tenant_employee_number_unique
- PASS — 12. soft-deleted row does not block new active row (partial index) — inserted
- PASS — 13. NULL-tenant rows do not participate in new per-tenant index — inserted
- PASS — 14. NULL email/employeeNumber rows do not block (sparse partial index) — inserted
- PASS — 16. Phase 3.2 cleanup harness wiring intact — pkg.json
- PASS — 17. Phase 3.1 readiness wiring intact — pkg.json
- PASS — 18. Phase 3.0 readiness wiring intact — pkg.json
- PASS — 19. cumulative regression chain outputs present — present=7/7
