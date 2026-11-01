/**
 * RLS / GUC helpers — single source of truth.
 *
 * Validated by SPIKE-001.
 */

/** Strict UUID v1–v8 regex — rejects anything else. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, what = 'tenantId'): string {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID for ${what}`);
  }
  return value;
}

/**
 * The exact SQL fragment used inside the per-request transaction.
 *
 * Why `SET LOCAL`: scoped to the active transaction; safe under PgBouncer
 * transaction-mode pooling (SPIKE-001 F-2). Plain `SET` would persist on
 * the pooled backend and leak across requests — banned by lint.
 *
 * Why `''` quoting: `tenantId` is `assertUuid`-validated above; no SQL
 * injection surface, but parameterised binding is preferred when the
 * driver supports it for `SET LOCAL`. Most PG drivers do not, so we
 * inline. The `assertUuid` regex is the safety boundary.
 */
export function setLocalTenantSql(tenantId: string): string {
  return `SET LOCAL app.tenant_id = '${assertUuid(tenantId)}'`;
}

/**
 * Canonical RLS policy template. Every tenant-scoped table must use this
 * exact USING/CHECK shape — the `NULLIF` wrapper is required (SPIKE-001
 * F-1: `current_setting(...)::uuid` errors on empty string after a
 * session-level RESET).
 */
export const RLS_POLICY_TEMPLATE = `
-- Apply per tenant-scoped table (DO NOT modify the NULLIF clause):
ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "{table}" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "{table}"
  USING      ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Platform-admin bypass (separate Postgres role; never granted to API role).
CREATE POLICY platform_admin_bypass ON "{table}"
  TO platform_admin
  USING (true) WITH CHECK (true);
`;
