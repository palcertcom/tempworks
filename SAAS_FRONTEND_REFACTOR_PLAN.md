# SaaS Frontend Refactor Plan

**Frontend stack:** React + Vite + Tailwind under `src/` (app shell at `src/app/`).
**Auth state today:** `src/app/contexts/AuthContext.tsx` + `localStorage` (`current_user`, `access_token`, `refresh_token`).
**API client today:** `src/app/services/api.ts` — fetch wrapper with pre-emptive token refresh.
**Routes:** `src/app/routes.ts` — ~120 routes; sidebar visibility by role-name strings.
**i18n:** `src/i18n/` (8 locales) with `LanguageProvider`.
**Theme/branding:** `src/app/contexts/ThemeContext.tsx` + `useBranding()` hook reading `SystemSetting` keys.

---

## 1. Single-Tenant Assumptions in the Frontend (concrete)

| # | Assumption | Where | Fix |
|---|---|---|---|
| F1 | `current_user.agencyId` / `agencyIsSystem` drives gating | `AuthContext.tsx` | Replace with `activeTenantId` + `memberships[]` + permission set |
| F2 | Sidebar visibility uses hard-coded role strings (`'System Admin'`, …) | `components/layout/Sidebar.tsx` | Switch to `hasPermission('candidates:read')` |
| F3 | Branding is fetched from `SystemSetting` global keys | `useBranding()` | Read from `/api/v1/bootstrap` per tenant |
| F4 | Theme is global toggle | `ThemeContext.tsx` | Tenant default + user override |
| F5 | i18n default locale is global | `LanguageProvider` | Tenant-default locale; user override persists per tenant |
| F6 | API base URL from `VITE_API_URL` static | `services/api.ts` | Optionally derive from current host: `https://<host>/api/v1` |
| F7 | Tokens in `localStorage` (origin-scoped already — ok) | `services/api.ts` | Move **access** token to memory only (XSS); keep refresh in `localStorage` |
| F8 | No tenant context | nowhere | Add `TenantContext` + `MembershipContext` |
| F9 | No workspace switcher UI | nowhere | Add header dropdown |
| F10 | React Query keys (or fetch caches) are not tenant-keyed | hooks throughout | Prefix all keys with `tenantId` |
| F11 | `resolveAssetUrl()` builds public URLs to Spaces | `services/api.ts` | Replace with API-issued signed URL fetcher |
| F12 | Asset/avatar URLs assumed permanent | image components | Treat URLs as expiring; use lazy-fetch + cache |
| F13 | Routes assume one workspace context | `routes.ts` | No structural change needed if subdomain-per-tenant; verify deep-link guards |
| F14 | Session restore on tab focus calls `/auth/me` | `AuthContext.tsx` | Update endpoint to return tenant + memberships + perms |
| F15 | i18n keys for backend errors are role/agency neutral | `i18n/apiError.ts` | No tenant change; verify no tenant names leak via error text |

---

## 2. New Bootstrap Endpoint (contract the frontend depends on)

```
GET /api/v1/bootstrap
Authorization: Bearer <access>
Host: acme.app.tempworks.com

200 {
  "tenant": {
    "id": "...", "slug": "acme", "name": "Acme",
    "branding": { "logoUrl": "...", "primaryColor": "#1e40af",
                  "accentColor": "#06b6d4", "faviconUrl": "...",
                  "supportEmail": "support@acme.com" },
    "locale":   { "default": "en", "supported": ["en","ar","fr"], "rtl": true },
    "featureFlags": { "saml": true, "billing.usage": false, "ai.matching": false },
    "region": "eu"
  },
  "user": {
    "id": "...", "email": "...", "fullName": "...", "mfaEnabled": true
  },
  "membership": {
    "id": "...", "roles": ["tenant.admin"], "permissions": ["candidates:read", ...],
    "agencies": [{ "id": "...", "name": "Acme HR", "scope": "FULL" }]
  },
  "memberships": [
    { "tenantId": "...", "tenantSlug": "acme",   "tenantName": "Acme",   "host": "acme.app.tempworks.com" },
    { "tenantId": "...", "tenantSlug": "globex", "tenantName": "Globex", "host": "hr.globex.com" }
  ]
}
```

Cached client-side for 60 s (stale-while-revalidate). Refetched on tenant switch and on permission-version bump (server sends `X-Perms-Version` header; client invalidates).

---

## 3. Module Map

### 3.1 `TenantProvider` (new) — `src/app/contexts/TenantContext.tsx`

```tsx
type TenantCtx = {
  tenant: BootstrapResponse['tenant'];
  membership: BootstrapResponse['membership'];
  memberships: BootstrapResponse['memberships'];
  hasPermission: (key: string) => boolean;
  inAgency: (agencyId: string) => boolean;
  switchTenant: (tenantId: string) => Promise<void>;
};
```

- Mounts above `<App />` and below `<AuthProvider />`.
- `switchTenant` → `POST /auth/switch-tenant { tenantId }` → redirect to that membership's `host`.
- `hasPermission` is constant-time (Set lookup on the cached `permissions[]`).

### 3.2 `AuthContext` — refactor

- Drop `agencyId`, `agencyIsSystem`.
- Add `activeTenantId`, `memberships`, `permissions`.
- `me()` returns the same shape as the membership block of `/bootstrap`.
- `logout()` calls `/auth/logout`, clears tokens, redirects to login on the **root** host (login is host-agnostic).

### 3.3 API client — `src/app/services/api.ts`

- Move access token to in-memory variable; refresh stays in `localStorage`.
- On every request: `Authorization: Bearer <access>` (no `X-Tenant-Id` needed when host carries it).
- On 401 with `WWW-Authenticate: switch-tenant`, call `/auth/switch-tenant` automatically and retry.
- On token-version mismatch (`X-Token-Version`), call `/auth/refresh` and retry.
- `resolveAssetUrl()` becomes `getSignedAssetUrl(opaqueKey)` that calls `GET /api/v1/files/sign?k=...` and caches for the URL's TTL.

### 3.4 Workspace Switcher — `src/app/components/WorkspaceSwitcher.tsx`

- Top-left header dropdown.
- Lists `memberships` with current marked.
- "+ Join workspace" link if user has any pending invites (`memberships?invited=1`).
- Switching:
  ```ts
  await api.post('/auth/switch-tenant', { tenantId });
  queryClient.clear();              // wipe React Query cache
  window.location.assign(`https://${nextHost}/`);
  ```
- Keyboard: `⌘K` opens command-palette switcher.

### 3.5 Branding & Theme

- Replace `useBranding()` reading `SystemSetting` with `useTenant().tenant.branding`.
- Mount CSS variables on `:root`:
  ```ts
  document.documentElement.style.setProperty('--color-primary', tenant.branding.primaryColor);
  ```
- Tailwind tokens consume CSS variables; **no rebuild per tenant**.
- `<link rel="icon">` updated to `tenant.branding.faviconUrl`.
- Logo in topbar reads from `tenant.branding.logoUrl`.

### 3.6 i18n

- `LanguageProvider` reads tenant default from `tenant.locale.default` if no user preference.
- Persisted per-tenant via `lang:<tenantId>` localStorage key (avoid cross-tenant pollution).
- RTL flag toggles `<html dir="rtl">` based on tenant + user locale.
- Translation files unchanged.

### 3.7 React Query / data hooks

- All query keys gain a tenant prefix:
  ```ts
  useQuery({ queryKey: ['t', tenantId, 'candidates', filter], queryFn: ... });
  ```
- A small wrapper `useTenantQuery(...)` enforces this so it can't be forgotten.
- `queryClient.clear()` called on tenant switch.

### 3.8 Routing

- Subdomain encodes tenant — no route changes for the active tenant.
- A small `<TenantGate>` wrapper at the root validates that bootstrap succeeded; if 404, render a "Workspace not found" page with link back to login origin.
- Public marketing/login lives on the root domain (`app.tempworks.com`) with no `TenantProvider`.

### 3.9 Sidebar / Navigation

- `Sidebar.tsx` items become `{ label, route, requires: 'candidates:read' }`.
- Filter at render: `items.filter(i => !i.requires || hasPermission(i.requires))`.
- Drop all `role.name === 'System Admin'` checks.
- Tempworks staff (PlatformAdmin) navigate via a separate `/_platform` shell with its own sidebar.

### 3.10 File / Asset Components

- Image components (`<EmployeePhoto>`, `<DocumentPreview>`) use `getSignedAssetUrl`.
- Cache returned URLs in a `Map` keyed by storage key, with TTL.
- On 403 from signed URL, force re-fetch.

---

## 4. Login & Selection UX

- `/login` — host-agnostic on root domain. Submits `{email, password}`. If 1 membership → redirect to its host. If N → show `/select-workspace`.
- `/select-workspace` — list memberships (cards with logo/name); clicking switches and redirects.
- `/invite/accept/:token` — accepts invite; if user is already logged in with same verified email, attaches membership; else prompts to create user.
- `/_platform/login` — separate platform-admin login with required MFA.

---

## 5. Caching, Storage, Cross-Tab

| Concern | Strategy |
|---|---|
| Access token | in-memory only |
| Refresh token | `localStorage` per origin (subdomain isolation already separates tenants) |
| Current user | derived from `/bootstrap`, cached 60 s |
| Tenant state | `TenantProvider` (in-memory) |
| Cross-tab sync | `BroadcastChannel('auth')`: logout / token-rotation messages |
| Tenant switch in another tab | `BroadcastChannel('tenant-switch')` → reload that tab |

---

## 6. Tasks (concrete file changes)

| # | File | Change |
|---|---|---|
| 1 | `src/app/contexts/TenantContext.tsx` | NEW — provider, hooks |
| 2 | `src/app/contexts/AuthContext.tsx` | refactor; drop agency-related fields |
| 3 | `src/app/services/api.ts` | token model, `getSignedAssetUrl`, switch-tenant interceptor |
| 4 | `src/app/components/layout/Sidebar.tsx` | role→permission |
| 5 | `src/app/components/WorkspaceSwitcher.tsx` | NEW |
| 6 | `src/app/components/layout/MainLayout.tsx` | mount switcher; load branding into CSS vars |
| 7 | `src/i18n/LanguageProvider.tsx` | tenant default; per-tenant key |
| 8 | `src/app/contexts/ThemeContext.tsx` | tenant default; per-tenant key |
| 9 | `src/app/hooks/useBranding.ts` | replace by `useTenant().tenant.branding` |
| 10 | `src/app/hooks/useTenantQuery.ts` | NEW — wraps `useQuery` with tenant key prefix |
| 11 | `src/app/routes.ts` | routes refactored to require permissions; add `/select-workspace`, `/invite/accept`, `/_platform/*` |
| 12 | `src/app/components/files/*` | signed-URL fetching for documents/photos |

---

## 7. Risks & Gotchas

- **Mixed-host third-party scripts** (analytics, recaptcha): re-verify CSP after subdomain proliferation.
- **Cookie domain**: avoid setting cookies at `.app.tempworks.com` — that would let one tenant tab read another's cookies. Use per-subdomain cookies / localStorage only.
- **Service worker scope**: per-origin; safe across tenants but cache must be cleared on logout.
- **Custom domains** (Phase 4): SSL cert provisioning lag — show a friendly error page during cert issuance.
- **Image hot-link caches**: when flipping objects from public to private, browsers may retain. Force a `?v=<n>` cache-buster on cutover.
- **Multi-tab N tenants**: opening Acme in tab 1 and Globex in tab 2 must not share state — different subdomains keep them isolated; **do not** persist tenant state under a key shared across origins.
