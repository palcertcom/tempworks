# Phase 2.14.1 — Notifications Check-Method Audit

> Per-method audit of the four `check*` methods on `NotificationsService`.
> Phase 2.14 wrapped them in a per-tenant ALS frame; Phase 2.14.1
> narrows their internal scans.

---

## 1. Common shape

All four methods share the same skeleton:

```ts
const fleetManagers = await legacyPrisma.user.findMany({
  where: { role: { name: { contains: 'Fleet Manager' } }, status: 'ACTIVE' },
  include: { agency: true },
});
for (const manager of fleetManagers) {
  const things = await legacyPrisma.<Thing>.findMany({
    where: { agencyId: manager.agencyId, deletedAt: null, ... },
  });
  for (const t of things) {
    const existing = await legacyPrisma.notification.findFirst({
      where: { userId: manager.id, relatedEntityId: t.id, ... },
    });
    if (!existing) await legacyPrisma.notification.create({ data: ... });
  }
}
```

Three places need a tenant filter:
1. The outer `User.findMany`.
2. The per-manager inner scan (`Vehicle` / `MaintenanceRecord`).
3. The dedupe `Notification.findFirst` + the subsequent `Notification.create.data`.

User has no `tenantId` column today — the path is `agency.tenantId`.
Vehicle, MaintenanceRecord, Notification all have nullable `tenantId`
columns (Phase 2.3).

## 2. Per-method audit

### 2.1 `checkExpiringCompliance`

| Aspect | Detail |
|---|---|
| Models touched | User → Vehicle → Notification |
| Outer scan | fleet managers across all tenants |
| Per-manager scan | vehicles by `agencyId` + 6 expiry-field columns |
| Dedupe | `userId + relatedEntityId + type + isRead=false + createdAt > -24h` (global) |
| Notification write | one row per (manager, vehicle, check) when no recent dupe |
| Risk | dupes suppressed across tenants; cross-tenant manager scan |
| Phase 2.14.1 narrowing | `agency: { tenantId: tid }`, `tenantId: tid` on Vehicle, dedupe + create scoped |

### 2.2 `checkServiceDue`

| Aspect | Detail |
|---|---|
| Models touched | User → Vehicle (with maintenanceRecords include) → Notification |
| Outer scan | fleet managers across all tenants |
| Per-manager scan | vehicles by `agencyId` with at least one maintenance record |
| Dedupe | same shape as 2.1 with `type = VEHICLE_SERVICE_DUE` |
| Notification write | one row per (manager, vehicle) when km remaining ≤ threshold |
| Risk | same as 2.1 |
| Phase 2.14.1 narrowing | same as 2.1 |

### 2.3 `checkOverdue`

| Aspect | Detail |
|---|---|
| Models touched | User → Vehicle → Notification |
| Outer scan | fleet managers across all tenants |
| Per-manager scan | vehicles with any expired field via `OR: [...]` |
| Dedupe | `userId + relatedEntityId + severity=HIGH + isRead=false` (global, no time window) |
| Notification write | one HIGH-severity row per (manager, vehicle) |
| Risk | same; the no-time-window dedupe is intentional (HIGH alerts persist) |
| Phase 2.14.1 narrowing | same |

### 2.4 `checkScheduledMaintenance`

| Aspect | Detail |
|---|---|
| Models touched | User → MaintenanceRecord (with vehicle/maintenanceType/workshop include) → Notification |
| Outer scan | fleet managers across all tenants |
| Per-manager scan | maintenance records via `vehicle.agencyId` |
| Dedupe | `userId + relatedEntityId + type=VEHICLE_SERVICE_DUE + isRead=false + createdAt > -24h` |
| Notification write | one row per (manager, scheduled record) |
| Risk | same |
| Phase 2.14.1 narrowing | `MaintenanceRecord.tenantId: tid` (Phase 2.3 denorm); plus User narrowing + dedupe + create scoped |

## 3. Tenant ownership inference

```
User           — global; tenant via `agency.tenantId` (Phase 1)
Vehicle        — `tenantId` (Phase 2.3 denorm)
MaintenanceRecord — `tenantId` (Phase 2.3 denorm)
Notification   — `tenantId` (Phase 2.3 denorm)
NotificationPreference — global per-user; no tenant
```

Phase 2.14.1 uses these directly:

| Model | Filter spread |
|---|---|
| User | `...(tid ? { agency: { tenantId: tid } } : {})` |
| Vehicle | `...(tid ? { tenantId: tid } : {})` |
| MaintenanceRecord | same |
| Notification (read/dedupe) | same |
| Notification (create data) | `...(tid ? { tenantId: tid } : {})` |

## 4. Helper

`private narrowingTenantId(): string | null` returns:

- the active tenant id from ALS when both flags are on AND env is
  staging-classified AND ALS has a tenant.
- `null` in every other case (legacy mode, missing context, production).

Each method consults the helper once at the top:

```ts
async checkExpiringCompliance(): Promise<void> {
  const tid = this.narrowingTenantId();
  ...
}
```

The downstream spreads `...(tid ? { tenantId: tid } : {})` are no-ops
when `tid === null`. Legacy behaviour is therefore byte-identical.

## 5. Risks

- **Same user across multiple tenants**: today's dedupe used to
  collapse those into one notification; Phase 2.14.1 splits them per
  tenant. Production has no users spanning tenants today, so no
  observable change. See `SAAS_PHASE2_NOTIFICATIONS_DEDUPE_KEY_REVIEW.md`.
- **Notification.tenantId backfill**: legacy rows have `tenantId=NULL`.
  The new dedupe `findFirst` includes `tenantId: tid`, so it does
  NOT match a NULL-tenant legacy row; the next cron tick may create
  a duplicate notification per legacy row + tid combination on the
  first run after Phase 2.14.1 enables. Mitigation: production stays
  on the legacy path (`runAllChecks`) and never sees this; staging
  rehearsal reset the Notification table between rehearsals.
- **Empty tenants**: a tenant with no fleet managers produces an
  empty per-tenant frame that does nothing. The outer batch runner
  records `ok=true, durationMs≈0`. No noise.

## 6. Refactor approach

1. Add `narrowingTenantId()` helper (single source of truth).
2. In each `check*` method:
   - Read `const tid = this.narrowingTenantId();` at the top.
   - Spread `...(tid ? { agency: { tenantId: tid } } : {})` into the
     User where.
   - Spread `...(tid ? { tenantId: tid } : {})` into the inner scan
     where.
   - Spread `...(tid ? { tenantId: tid } : {})` into the dedupe
     `findFirst` where.
   - Spread `...(tid ? { tenantId: tid } : {})` into the
     `notification.create` data.
3. Move annotations from `phase210-excluded-background` →
   `phase214-pilot-scope` on every site that now narrows.
4. Extend the harness with source-level + runtime cases.

The helper-based approach keeps each method's skeleton intact —
risk of breaking legacy behaviour is minimal since every spread is a
no-op when `tid === null`.
