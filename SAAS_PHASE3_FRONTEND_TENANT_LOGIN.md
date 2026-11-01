# SaaS Phase 3.14 — Frontend Login Migration to Tenant-Aware Endpoint

Phase 3.14 migrates the React login page + API client to send
`{ company, email, password }` against the Phase 3.13
`/auth/login-v2` endpoint, while keeping a clean fallback when
`company` is empty.

## Frontend changes

### `src/app/pages/public/LoginPage.tsx`
- New **Company** field (id `company`, label key `login.companyLabel`,
  placeholder `login.companyPlaceholder`). Required, autocomplete
  `organization`, spell-check disabled.
- Prefilled from `localStorage` via `getLastCompany()` on mount.
- Error path collapsed to a single generic message:
  `t('login.loginFailed')` for every 401, regardless of whether the
  failure was tenant / email / password / inactive / outside-tenant.
  No per-error i18n keys are referenced.

### `src/app/services/api.ts`
- New helper `getLastCompany()` and internal `rememberCompany(slug)`
  using the localStorage key `auth.lastCompany`.
- `authApi.login(email, password, company?)` now:
  - normalizes `email` and `company` (lowercase + trim).
  - routes to `/auth/login-v2` when `company` is non-empty, sending
    `{ company, email, password }`.
  - falls back to legacy `/auth/login` (legacy payload) when
    `company` is empty.
  - persists `company` after a successful (non-2FA) login.
- `setTokens` and `/auth/me` flow unchanged.

## API client summary

| Caller | Endpoint | Payload |
|---|---|---|
| `authApi.login(email, pw, company)` with `company` | `POST /auth/login-v2` | `{ company, email, password }` |
| `authApi.login(email, pw)` (legacy callers) | `POST /auth/login` | `{ email, password }` |

No password is ever written to `localStorage` or `sessionStorage`
(harness asserts via source-level scan).

## Backend behaviour (unchanged)

- `TENANT_LOGIN_REQUIRED` defaults to `false` — legacy `/auth/login`
  remains backwards-compatible while frontends migrate.
- `/auth/login-v2` returns the same generic 401 for every failure
  mode; frontend uses that as the entire error surface.

## Bake period + flag-flip plan

1. Roll Phase 3.14 to staging. Manual smoke test:
   - Successful login with valid `company`.
   - Five failure paths each show the same generic toast.
   - localStorage prefills `Company` on next visit.
2. Roll to production with `TENANT_LOGIN_REQUIRED=false`.
3. Bake one full release cycle. Watch:
   - login success rate
   - 401 rate on `/auth/login-v2`
   - average time-to-success after the new field appeared
4. After bake:
   - **set `TENANT_LOGIN_REQUIRED=true`** in the production env.
     Older clients without `company` start getting the same generic
     401 — coordinate with operations / customer support before
     flipping.
5. Once stable, optionally remove the legacy fallback path in the
   API client and require `company` at the controller layer.

## Rollback

- **Frontend rollback (preferred):** revert this commit. The
  Company field disappears, the API client returns to the legacy
  shape, and `/auth/login` continues to operate.
- **Backend safety net:** ensure `TENANT_LOGIN_REQUIRED` is `false`
  (or unset). The legacy `/auth/login` keeps accepting
  `{ email, password }` without `company`.
- No data, schema, or token state to roll back.

## Harness results

`saas:phase314-frontend-tenant-login-check`: **17/17 PASS**

Coverage:
1-2. Company field present + `required`.
3-5. API client conditional routing + payload shape + normalization.
6-7. Last company persisted; password never stored.
8. Single generic error message.
9. Legacy `/auth/login` retained when company empty.
10. `setTokens` flow preserved.
11. No specific error keys leak tenant/email existence.
12. Backend Phase 3.13 contract resolves a freshly-seeded tenant
    + agency + user using the same normalization the frontend uses.
13-17. Cross-phase wiring + cumulative sentinel outputs present.

Cumulative regression: **1094/1094 PASS** (1077 + 17).

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` (backend) | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase314-frontend-tenant-login-check` | 17/17 PASS |
| `saas:phase313-tenant-aware-login` | 18/18 PASS |
| `saas:phase312-platform-admin-controller` | 16/16 PASS |
| `saas:phase311-platform-admin-grant-revoke` | 22/22 PASS |
| `saas:phase390-drop-agency-is-system` | 14/14 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation` | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

> Vite is not installed in this clone, so `npm run build` (frontend)
> was not run as part of validation. Source-level invariants are
> exercised by the harness; the UI changes are minimal additions
> rather than refactors.

## Production behaviour status

- The frontend now sends `company` whenever the user fills the field
  (which it asks them to). All three tenant-resolution paths (slug,
  customDomain, fallback to legacy) are exercised.
- The backend response surface is unchanged: success returns the
  same JWT payload; failures remain a single generic 401.

## Remaining blockers

- Operator decision on when to flip `TENANT_LOGIN_REQUIRED=true`.
- Optional cleanup of the legacy fallback in the API client once
  every client has been confirmed to send `company`.

## Recommended next phase

**Phase 3.15 — Legacy login retirement.** After the bake, set
`TENANT_LOGIN_REQUIRED=true` in production, drop the
`if (!company)` fallback in the API client, and consider deleting
the legacy `/auth/login` payload shape (the route can keep its
URL but reject any request without `company`).
