# Phase 3.14 — frontend tenant-login source-level check

**17/17 PASS**

- PASS — 1. LoginPage contains a Company field — company input present
- PASS — 2. Company field is required — required
- PASS — 3. authApi.login routes to /auth/login-v2 when company provided — conditional path
- PASS — 4. Payload contains { company, email, password } — shape ok
- PASS — 5. company and email normalized (trim + lowercase) — normalized
- PASS — 6. last company stored in localStorage (LAST_COMPANY_KEY) — persisted
- PASS — 7. password is NOT stored (api + LoginPage) — no password storage
- PASS — 8. generic auth error shown for any 401 — generic only
- PASS — 9. legacy /auth/login fallback when company is empty — present
- PASS — 10. token/session handling unchanged (setTokens called) — unchanged
- PASS — 11. no user-facing error leaks tenant/email existence — generic only
- PASS — 12. backend Phase 3.13 contract resolves a fresh tenant/user pair — resolved
- PASS — 13. Phase 3.12 controller wiring intact — pkg.json
- PASS — 14. Phase 3.11 grant/revoke wiring intact — pkg.json
- PASS — 15. Phase 3.10 cleanup harness wiring intact — pkg.json
- PASS — 16. Phase 3.9 drop-agency-is-system wiring intact — pkg.json
- PASS — 17. cumulative regression chain outputs present — present=8/8
