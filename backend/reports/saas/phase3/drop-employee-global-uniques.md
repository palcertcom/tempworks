# Phase 3.4 — drop legacy global Employee UNIQUEs

**20/20 PASS**

- PASS — 1. migration SQL contains no DROP for User.email — no users mention
- PASS — 2. migration SQL contains no DROP for Applicant indexes — none
- PASS — 3. migration SQL does not drop Phase 3.3 per-tenant indexes — no per-tenant index name in up
- PASS — 4. migration SQL drops only exact global Employee.email uniqueness — emailDrop=true whereGuard=true
- PASS — 5. migration SQL drops only exact global Employee.employeeNumber uniqueness — guarded by partial-index check
- PASS — 6. migration SQL contains no UPDATE/DELETE data mutation — no UPDATE/DELETE in up
- PASS — 7. after migration, same Employee.email in different tenants is allowed — inserted
- PASS — 8. after migration, same Employee.employeeNumber in different tenants is allowed — inserted
- PASS — 9. same-tenant Employee.email still rejected by employees_tenant_email_unique — code=23505 constraint=employees_tenant_email_unique
- PASS — 10. same-tenant Employee.employeeNumber still rejected by employees_tenant_employee_number_unique — code=23505 constraint=employees_tenant_employee_number_unique
- PASS — 11. User.email duplicate is still rejected globally — code=23505 constraint=users_email_key
- PASS — 12. Applicant same-tenant email duplicate is still rejected — code=23505 constraint=applicants_tenant_email_unique
- PASS — 13. Applicant cross-tenant same email behavior remains (allowed) — inserted
- PASS — 14. down migration restores global Employee.email uniqueness — present
- PASS — 15. down migration restores global Employee.employeeNumber uniqueness — present
- PASS — 16. down migration failure caveat documented when cross-tenant duplicates exist — documented
- PASS — 17. Phase 3.3 per-tenant unique harness wiring intact in package.json — pkg.json
- PASS — 18. Phase 3.2 cleanup harness wiring intact — pkg.json
- PASS — 19. Phase 3.1 readiness wiring intact — pkg.json
- PASS — 20. cumulative regression chain outputs present — present=8/8
