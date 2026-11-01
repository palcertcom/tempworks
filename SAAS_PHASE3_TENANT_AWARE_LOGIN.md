# SaaS Phase 3.13 — Tenant-Aware Login (`/auth/login-v2`)

Phase 3.13 introduces a **parallel, tenant-aware** login endpoint
that accepts `company` + `email` + `password`. The legacy
`/auth/login` endpoint is unchanged at default settings; a feature
flag opts the legacy route into the same tenant-aware path so
frontends can migrate gradually.

## Endpoint contract

```http
POST /auth/login-v2
Content-Type: application/json

{ "company": "tempworks", "email": "user@example.com", "password": "secret" }
```

`company` may be a `Tenant.slug` or a `Tenant.customDomain`. Frontends
may label the field "Company", "Workspace", or "Tenant".

Success response is identical to `/auth/login` (JWT tokens + user
shape — preserves Phase 3.7+ JWT payload).

Failure response, for **every** failure mode:
```json
{ "code": "AUTH.INVALID_CREDENTIALS",
  "message": "Invalid company, email, or password" }
```
(HTTP 401)

## Tenant resolution order

`AuthService.loginV2` resolves the tenant by:

1. exact `Tenant.slug` match (case-insensitive)
2. exact `Tenant.customDomain` match (case-insensitive)
3. (no other matchers — `Tenant.name` is **never** consulted)

Both lookups go through a single `findFirst({ where: { OR: […] } })`
so resolution is deterministic. Multiple matches are not possible
because `slug` and `customDomain` are both globally `@unique`.

## User resolution

After tenant resolution, the user is looked up by:
- `email` (normalized to lowercase + trimmed)
- `deletedAt = null`
- `agency.tenantId = resolvedTenant.id`

If any of those conditions fails, the generic 401 is returned. The
service then delegates to the existing `login()` method with
`agencyId` pinned to the resolved user's agency, so:
- bcrypt password verification
- account-locked / failed-attempts tracking
- 2FA challenge issuance
- password-expiry handling
- audit logging
all behave identically to `/auth/login`.

Any `UnauthorizedException` thrown by the legacy method is caught
and re-thrown as the generic 401 — no information leakage.

## Security guarantees

- **Same status, same message** for tenant-not-found / user-not-found
  / wrong-password / inactive / deleted / outside-tenant /
  ambiguous-tenant.
- `company` and `email` are normalized (lowercase + trim).
- Passwords are never logged.
- No tenant existence is leaked.
- Per-failure audit rows are written via the existing audit pipeline
  with `LOGIN_FAILED` action.
- Agency-mismatch path in legacy `login()` provides defense-in-depth.

## Backward compatibility

`TENANT_LOGIN_REQUIRED` (default `false`):

| Flag | `/auth/login` behaviour | `/auth/login-v2` behaviour |
|---|---|---|
| `false` (default) | Unchanged: legacy `email + password` (optional `agencyId`). | Always tenant-aware; requires `company`. |
| `true` | Requires `company`; routes through `loginV2`. Missing → generic 401. | Always tenant-aware; requires `company`. |

This lets frontends migrate to passing `company` against the legacy
endpoint, and operators flip the flag once all clients have updated.

## Production behaviour status

- **No flag set** (default): legacy `/auth/login` is byte-identical
  to pre-Phase-3.13. The new `/auth/login-v2` is reachable but every
  failure path returns the generic message; success returns the same
  shape. No existing callers are affected.
- **`TENANT_LOGIN_REQUIRED=true`**: legacy endpoint requires
  `company`. Frontends without `company` will see 401.

## Frontend migration path

1. Roll backend with both endpoints; keep flag off.
2. Update frontend login UI to add a Company field (optional).
3. Switch frontend to call `/auth/login-v2` with `company`.
4. After the frontend release fully bakes, set
   `TENANT_LOGIN_REQUIRED=true`. Older frontends will get 401 —
   choose this only after the upgrade is complete.

UI guidance:
- Optional: remember last `company` slug in `localStorage` to
  prefill on next visit.
- Never store password.
- Render the same error text for every 401: "Invalid company, email,
  or password."

## Production enablement checklist

- [ ] Phase 3.5 backfill applied + Phase 3.7B `goPhase38: true`.
- [ ] Frontend supports `company` field and calls `/auth/login-v2`.
- [ ] Operator-side smoke test: login through both endpoints succeeds.
- [ ] Smoke test: 5 deliberate failure paths each return identical 401.
- [ ] Optional: `TENANT_LOGIN_REQUIRED=true` after a release bake.

## Harness results

`saas:phase313-tenant-aware-login`: **18/18 PASS**

Coverage:
1. valid login succeeds
2-7. wrong company / email / password / outside-tenant / inactive / substring-slug all generic
8. fuzzy display-name matching rejected
9. lowercase normalization + customDomain lookup
10. legacy `/auth/login` delegation preserved (source-level)
11. flag-true gate present in controller
12. login-v2 DTO requires company (`@MinLength(1)`)
13. PlatformAdmin authority unchanged
14. JWT payload shape preserved (8 keys)
15. tenant context selected via `user.agency.tenantId`
16. no password logging in `loginV2` source (delegation only)
17. only one error string in `loginV2` source
18. cumulative regression chain outputs present

Cumulative regression: **1077/1077 PASS** (1059 + 18).

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase313-tenant-aware-login` | 18/18 PASS |
| `saas:phase312-platform-admin-controller` | 16/16 PASS |
| `saas:phase311-platform-admin-grant-revoke` | 22/22 PASS |
| `saas:phase310-platform-admin-cleanup-audit-log` | 18/18 PASS |
| `saas:phase390-drop-agency-is-system` | 14/14 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation` | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

## Rollback

- Configuration: leave `TENANT_LOGIN_REQUIRED` unset / `false`.
  Legacy `/auth/login` continues to operate as before. New endpoint
  remains reachable but is opt-in for the frontend.
- Frontend: hide / remove the Company field; continue using legacy
  `/auth/login` and the legacy DTO.
- Code: revert the Phase 3.13 commit. The new DTO, controller route,
  and service method disappear; legacy endpoint and service are
  unaffected.

No schema or data rollback is required.

## Recommended next phase

**Phase 3.14 — Frontend migration + flag flip.** Update the login
UI to send `company`, switch to `/auth/login-v2`, bake one release,
then set `TENANT_LOGIN_REQUIRED=true` to retire the
no-`company` legacy path.
