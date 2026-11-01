import { useState, useEffect, useMemo } from 'react';
import { getCurrentUser, tenantsApi } from '../services/api';

/**
 * SUPER USER tenant filter state for cross-tenant list screens
 * (Applicants / Candidates / Employees). Mirrors the User Management
 * filter pattern.
 *
 * Visibility/authority:
 *   • `isPlatformSuper` is true only for platform admins at SUPER level
 *     (currentUser.platformAdmin.level === 'SUPER'). Only then is the
 *     filter shown and a tenantId ever sent.
 *   • Defaults to the active tenant (never "All Tenants").
 *   • Empty `tenantFilter` for a SUPER user == "All Tenants".
 *
 * The backend is the final authority — it ignores tenantId from any
 * non-platform caller regardless of what the client sends.
 */
export interface SuperUserTenantFilter {
  isPlatformSuper: boolean;
  tenantFilter: string;
  setTenantFilter: (id: string) => void;
  tenantOptions: Array<{ id: string; name: string }>;
  tenantNameById: Record<string, string>;
  /** True when a SUPER user has selected "All Tenants" (cleared the filter). */
  showAllTenants: boolean;
  loadError: boolean;
  /** Resolve a record's tenant display name via its agency.tenantId / tenantId. */
  resolveTenantName: (record: any) => string;
  /** Apply the tenant filter to a list-query params object (mutates + returns). */
  applyToParams: <T extends Record<string, any>>(params: T) => T;
}

export function useSuperUserTenantFilter(): SuperUserTenantFilter {
  const currentUser = getCurrentUser();
  // Treat tenant-wide admins as 'super' for filter purposes: platform-admin
  // SUPER OR the System Admin role. The latter is the cross-tenant admin
  // operating without an explicit PlatformAdmin row. Backend re-checks
  // authority on every list endpoint regardless, so this is a UI gate only.
  const role: any = (currentUser as any)?.role;
  const roleName: string = typeof role === 'string' ? role : (role?.name ?? '');
  const isPlatformSuper =
    (currentUser as any)?.platformAdmin?.level === 'SUPER'
    || roleName.trim().toLowerCase() === 'system admin';

  const initialTenantId =
    (currentUser as any)?.activeTenantId
    ?? (currentUser as any)?.primaryTenantId
    ?? (currentUser?.memberships?.[0]?.tenantId)
    ?? '';

  const [tenantFilter, setTenantFilter] = useState<string>(isPlatformSuper ? initialTenantId : '');
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; name: string }>>(
    Array.isArray(currentUser?.memberships)
      ? currentUser!.memberships!.map(m => ({ id: m.tenantId, name: m.name }))
      : [],
  );
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!isPlatformSuper) return;
    tenantsApi.list({ limit: 500 })
      .then((res: any) => {
        const rows = Array.isArray(res?.data) ? res.data : [];
        setTenantOptions(rows.map((r: any) => ({ id: r.id, name: r.name })));
      })
      .catch(() => setLoadError(true));
  }, [isPlatformSuper]);

  const tenantNameById = useMemo(
    () => Object.fromEntries(tenantOptions.map(o => [o.id, o.name])),
    [tenantOptions],
  );

  const showAllTenants = isPlatformSuper && !tenantFilter;

  const resolveTenantName = (record: any): string => {
    const id = record?.agency?.tenantId ?? record?.tenantId ?? '';
    return id ? (tenantNameById[id] ?? id) : '—';
  };

  const applyToParams = <T extends Record<string, any>>(params: T): T => {
    if (isPlatformSuper && tenantFilter) (params as any).tenantId = tenantFilter;
    return params;
  };

  return {
    isPlatformSuper, tenantFilter, setTenantFilter, tenantOptions,
    tenantNameById, showAllTenants, loadError, resolveTenantName, applyToParams,
  };
}
