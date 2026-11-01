# Phase 2.31 — `publicSubmit` Tenant Attribution Decision

> "A public applicant must still enter through a tenant door."

---

## 1. Selected option — Hybrid A + B

In pilot mode, the tenant id used to stamp a public-submit row is
resolved in this order:

1. **ALS frame from the request.** If `TenantContextMiddleware` already
   resolved a tenant (host / subdomain / explicit header), the active
   ALS frame's `tenantId` wins. This is **Option A**.
2. **Agency-derived fallback.** If no ALS frame is present **and** the
   payload includes a UUID `agencyId`, the helper resolves the agency
   via the pilot client (no tenant filter, since there is no active
   frame to filter by) and uses `agency.tenantId`. This is **Option B**.
3. **Reject otherwise.** With pilot mode active and neither (1) nor
   (2) yielding a tenant, the submission is rejected with
   `APPLICANT.PUBLIC_SUBMIT_NO_TENANT`. NULL-tenant public submissions
   are allowed only in **legacy mode** (flag off).

If both (1) and (2) yield a tenant, they MUST agree. A mismatch
(active ALS = tenant A, body says `agencyId` belonging to tenant B)
raises `APPLICANT.PUBLIC_SUBMIT_TENANT_MISMATCH`. This guards against
agency-id swaps from a tenant A subdomain.

## 2. Why not Option A alone

Option A — "require ALS context, reject otherwise" — would break the
existing public form today. The form is currently served from the
SaaS root host, not from a tenant subdomain. Until custom-domain
public forms ship in Phase 3, there is no tenant frame for many
real submissions, even though the body identifies the target agency.
Hard-rejecting these would amount to a production behaviour change.

## 3. Why not Option B alone

Option B — "always derive from `agencyId`" — would silently lose
attribution when the form is hosted on a tenant subdomain *and* the
agency id is missing. It would also be vulnerable to spoofing if the
caller is on a tenant subdomain but submits an agency id from a
different tenant; without the cross-check from (1), the foreign
agency id wins.

The hybrid keeps the strict cross-check while still working for the
common case today (no ALS, agency id in body).

## 4. Why not Option C — explicit default tenant

Option C — "use a configured default tenant when neither (1) nor (2)
applies" — silently buckets every misrouted submission into one
tenant's funnel. That is the wrong default: it makes mis-attributed
data look correct. We deliberately reject in this case so the
operator notices and routes the form properly.

If a future product requirement explicitly demands a default-tenant
fallback (e.g. a "central applicant pool" tenant), it should land in
its own phase with its own flag. Phase 2.31 does NOT introduce one.

## 5. Future custom-domain public forms

When tenant custom domains ship (Phase 3 product), the per-tenant
public form will populate the ALS frame at the middleware layer via
`TenantResolverService.resolveFromHost(...)`. The hybrid resolver
above will silently start preferring path (1) — no further code
changes are required in `applicants.service.ts`. That is the main
reason the hybrid is preferred over a pure Option B: **path (2) is
the bridge; path (1) is the future**.

## 6. Backward compatibility with flags OFF

With `TENANT_PRISMA_PILOT_ENABLED=false` (production default) the
attribution helper short-circuits and `publicSubmit` writes a row
with no `tenantId` — byte-identical to pre-2.31. The new error codes
`APPLICANT.PUBLIC_SUBMIT_NO_TENANT` and
`APPLICANT.PUBLIC_SUBMIT_TENANT_MISMATCH` are unreachable.

## 7. Error contract added

| Code | When raised |
|---|---|
| `APPLICANT.PUBLIC_SUBMIT_NO_TENANT` | Pilot mode, no ALS frame, no payload `agencyId`, no resolvable tenant. |
| `APPLICANT.PUBLIC_SUBMIT_TENANT_MISMATCH` | Pilot mode, ALS frame and payload `agencyId` resolve to different tenants. |
| `APPLICANT.PUBLIC_SUBMIT_AGENCY_NOT_FOUND` | Pilot mode, payload `agencyId` does not resolve. (No leak: returns the same shape as the unauthenticated NotFound.) |

These codes are namespaced and additive — no existing client
contract is altered.

## 8. Test plan summary

The Phase 2.31 isolation harness covers:
- Pilot mode + ALS A + payload agencyId of A: row gets `tenantId = A`.
- Pilot mode + ALS A + payload agencyId of B: rejected (`TENANT_MISMATCH`).
- Pilot mode + no ALS + payload agencyId of A: row gets `tenantId = A`.
- Pilot mode + no ALS + no agencyId: rejected (`NO_TENANT`).
- Legacy mode + no ALS + no agencyId: row created with `tenantId = NULL` (today's behaviour).

## 9. Out of scope

- No reCAPTCHA changes.
- No identifier-generation changes.
- No email-notification changes.
- No new endpoint, no new DTO field, no new column.
