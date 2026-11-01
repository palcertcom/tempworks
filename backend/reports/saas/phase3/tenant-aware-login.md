# Phase 3.13 — tenant-aware login

**18/18 PASS**

- PASS — 1. loginV2 succeeds with valid company/email/password — id=00000000
- PASS — 2. wrong company → generic failure — generic 401
- PASS — 3. wrong email → generic failure — generic 401
- PASS — 4. wrong password → generic failure — generic 401
- PASS — 5. user outside tenant → generic failure — uB belongs to tenant B
- PASS — 6. inactive/deleted user → generic failure — INACTIVE
- PASS — 7. exact slug matching only (substring rejected) — no LIKE
- PASS — 8. no fuzzy display-name matching — name not used
- PASS — 9. normalized lowercase company/email works (slug + customDomain) — normalize + customDomain
- PASS — 10. legacy /auth/login still delegates to authService.login (flag=false) — preserved
- PASS — 11. /auth/login rejects missing company when TENANT_LOGIN_REQUIRED=true — gate present
- PASS — 12. /auth/login-v2 always requires company (DTO @MinLength) — required
- PASS — 13. PlatformAdmin authority still works (uPa is PA) — isPa=true
- PASS — 14. JWT payload shape preserved (8 keys) — keys=agencyId,agencyIsSystem,email,firstName,id,lastName,role,roleId
- PASS — 15. tenant context correctly selected (user.agency.tenantId) — tenant=00000000
- PASS — 16. no password logging in loginV2 (delegation only) — delegated only
- PASS — 17. no credential leakage in errors (single generic message) — source-level + behavioural verified above
- PASS — 18. Phase 3.12 controller wiring intact + cumulative outputs present — present=13/13
