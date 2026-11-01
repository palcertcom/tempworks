import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi, getCurrentUser, setCurrentUser, type AuthUser } from '../../services/api';
import { MembersTab } from './TenantDetails';

// Phase 3.17 — dedicated "Tenant Members" page for System Admins so a
// tenant manager can add/remove users from their own tenant without
// needing PlatformAdmin authority. The MembersTab component is shared
// with the PlatformAdmin tenant details page.
// @tenant-reviewed: phase317-multi-tenant-login
export function MyTenantMembers() {
  const { t } = useTranslation('pages');
  const [me, setMe] = useState<AuthUser | null>(() => getCurrentUser());
  const [loading, setLoading] = useState(!me?.primaryTenantId);

  // Refresh /auth/me on mount so primaryTenantId is populated for users
  // whose cached AuthUser predates the Phase 3.17 field.
  useEffect(() => {
    authApi.me()
      .then((fresh) => { if (fresh) { setCurrentUser(fresh); setMe(fresh); } })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const tenantId = me?.primaryTenantId ?? me?.memberships?.[0]?.tenantId ?? null;
  const tenantName =
    me?.memberships?.find((m) => m.tenantId === tenantId)?.name ?? null;

  if (loading) return <div className="p-6 text-muted-foreground">{t('tenants.list.loading')}</div>;
  if (!tenantId) {
    return (
      <div className="p-6 space-y-2">
        <h1 className="text-2xl font-semibold">
          {t('tenants.myMembers.title', { defaultValue: 'Tenant Members' })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('tenants.myMembers.noTenant', {
            defaultValue: 'You are not associated with a tenant yet. Contact a platform administrator.',
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {t('tenants.myMembers.title', { defaultValue: 'Tenant Members' })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {tenantName
            ? t('tenants.myMembers.subtitleNamed', { defaultValue: 'Manage who can sign in to {{tenant}}.', tenant: tenantName })
            : t('tenants.myMembers.subtitle', { defaultValue: 'Manage who can sign in to your tenant.' })}
        </p>
      </div>
      <MembersTab tenantId={tenantId} canManage={true} />
    </div>
  );
}
