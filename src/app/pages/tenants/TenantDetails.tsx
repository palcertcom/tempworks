import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Edit, Archive, Power, Trash2, RotateCcw, UserPlus, X } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { tenantsApi, usersApi, getCurrentUser, type TenantRecord } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { formatDate, formatDateTime } from '../../../i18n/formatters';

// Phase 3.15 — Tenant Details page.
// @tenant-reviewed: phase315-tenant-management-module
export function TenantDetails() {
  const { t } = useTranslation('pages');
  const { id } = useParams();
  const me = getCurrentUser();
  const level = me?.platformAdmin?.level ?? 'NONE';
  const isSuper = level === 'SUPER';
  const canWrite = level === 'SUPER' || level === 'OPERATOR';
  // Phase 3.17 — a tenant's own System Admin can also manage that tenant's
  // memberships. Backend re-checks this on every membership endpoint; the
  // UI predicate just decides whether to render the grant/revoke controls.
  const isSystemAdminOfThis =
    me?.role === 'System Admin' &&
    !!me?.memberships?.some((m) => m.tenantId === id && m.status === 'ACTIVE');
  const canManageMembers = isSuper || isSystemAdminOfThis;

  const [tenant, setTenant] = useState<TenantRecord | null>(null);
  const [stats, setStats] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    if (!id) return;
    setLoading(true);
    Promise.all([tenantsApi.get(id), tenantsApi.stats(id).catch(() => null)])
      .then(([rec, s]) => { setTenant(rec); setStats(s); })
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  if (loading || !tenant) return <div className="p-6 text-muted-foreground">{t('tenants.list.loading')}</div>;

  const softDeleted = !!tenant.deletedAt;

  const onArchive = async () => {
    if (!await confirm({ title: t('tenants.confirmArchiveTitle'), description: t('tenants.confirmArchiveDesc') })) return;
    try { await tenantsApi.archive(tenant.id); toast.success(t('tenants.toastArchived')); load(); }
    catch (err) { toast.error(apiError(err)); }
  };
  const onActivate = async () => {
    try { await tenantsApi.activate(tenant.id); toast.success(t('tenants.toastActivated')); load(); }
    catch (err) { toast.error(apiError(err)); }
  };
  const onDelete = async () => {
    if (!await confirm({ title: t('tenants.confirmDeleteTitle'), description: t('tenants.confirmDeleteDesc'), variant: 'destructive' })) return;
    try { await tenantsApi.remove(tenant.id); toast.success(t('tenants.toastDeleted')); load(); }
    catch (err) { toast.error(apiError(err)); }
  };
  const onRestore = async () => {
    try { await tenantsApi.restore(tenant.id); toast.success(t('tenants.toastRestored')); load(); }
    catch (err) { toast.error(apiError(err)); }
  };

  const statusCls =
    tenant.status === 'ACTIVE'    ? 'bg-green-500' :
    tenant.status === 'SUSPENDED' ? 'bg-amber-500' :
    'bg-gray-500';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold">{tenant.name}</h1>
            <Badge className={statusCls}>{t(`tenants.statuses.${tenant.status.toLowerCase()}`)}</Badge>
            {softDeleted && <Badge variant="outline" className="border-red-500 text-red-600">{t('tenants.deleted')}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground font-mono">{tenant.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && !softDeleted && (
            <Button asChild variant="outline"><Link to={`/dashboard/tenants/${tenant.id}/edit`}><Edit className="w-4 h-4 me-1.5" />{t('tenants.list.edit')}</Link></Button>
          )}
          {canWrite && !softDeleted && tenant.status === 'ACTIVE' && (
            <Button variant="outline" onClick={onArchive}><Archive className="w-4 h-4 me-1.5" />{t('tenants.list.archive')}</Button>
          )}
          {canWrite && !softDeleted && tenant.status !== 'ACTIVE' && (
            <Button variant="outline" onClick={onActivate}><Power className="w-4 h-4 me-1.5" />{t('tenants.list.activate')}</Button>
          )}
          {isSuper && softDeleted && (
            <Button variant="outline" onClick={onRestore}><RotateCcw className="w-4 h-4 me-1.5" />{t('tenants.list.restore')}</Button>
          )}
          {isSuper && !softDeleted && (
            <Button variant="outline" onClick={onDelete} className="text-red-600 hover:text-red-700 border-red-300"><Trash2 className="w-4 h-4 me-1.5" />{t('tenants.list.delete')}</Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">{t('tenants.tabs.general')}</TabsTrigger>
          <TabsTrigger value="branding">{t('tenants.tabs.branding')}</TabsTrigger>
          <TabsTrigger value="access">{t('tenants.tabs.access')}</TabsTrigger>
          <TabsTrigger value="members">{t('tenants.tabs.members', { defaultValue: 'Members' })}</TabsTrigger>
          <TabsTrigger value="stats">{t('tenants.tabs.stats')}</TabsTrigger>
          <TabsTrigger value="flags">{t('tenants.tabs.flags')}</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card><CardContent className="py-6 grid sm:grid-cols-2 gap-3 text-sm">
            <Row label={t('tenants.fields.name')} value={tenant.name} />
            <Row label={t('tenants.fields.slug')} value={tenant.slug} mono />
            <Row label={t('tenants.fields.status')} value={t(`tenants.statuses.${tenant.status.toLowerCase()}`)} />
            <Row label={t('tenants.fields.region')} value={tenant.region} />
            <Row label={t('tenants.fields.contactEmail')} value={tenant.contactEmail} />
            <Row label={t('tenants.fields.contactPhone')} value={tenant.contactPhone} />
            <Row label={t('tenants.fields.address')} value={tenant.address} />
            <Row label={t('tenants.fields.notes')} value={tenant.notes} />
            <Row label={t('tenants.fields.createdAt')} value={formatDateTime(tenant.createdAt)} />
            <Row label={t('tenants.fields.updatedAt')} value={formatDateTime(tenant.updatedAt)} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="branding">
          <Card><CardContent className="py-6 grid sm:grid-cols-2 gap-3 text-sm">
            <Row label={t('tenants.fields.logoUrl')} value={tenant.logoUrl} />
            <Row label={t('tenants.fields.primaryColor')} value={
              tenant.primaryColor ? <span className="inline-flex items-center gap-2"><span className="inline-block w-4 h-4 rounded border" style={{ background: tenant.primaryColor }} />{tenant.primaryColor}</span> : '—'
            } />
            <Row label={t('tenants.fields.locale')} value={tenant.locale} />
            <Row label={t('tenants.fields.timezone')} value={tenant.timezone} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="access">
          <Card><CardContent className="py-6 grid sm:grid-cols-2 gap-3 text-sm">
            <Row label={t('tenants.fields.customDomain')} value={tenant.customDomain} />
            <Row label={t('tenants.fields.planId')} value={tenant.planId} />
            <Row label={t('tenants.fields.onboardingStatus')} value={tenant.onboardingStatus} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="members">
          <MembersTab tenantId={tenant.id} canManage={canManageMembers} />
        </TabsContent>

        <TabsContent value="stats">
          <Card><CardContent className="py-6 grid sm:grid-cols-3 gap-3 text-sm">
            {stats ? (
              <>
                <StatBox label={t('tenants.stats.agencies')}   value={stats.agencies ?? 0} />
                <StatBox label={t('tenants.stats.users')}      value={stats.users ?? 0} />
                <StatBox label={t('tenants.stats.employees')}  value={stats.employees ?? 0} />
                <StatBox label={t('tenants.stats.applicants')} value={stats.applicants ?? 0} />
                <StatBox label={t('tenants.stats.documents')}  value={stats.documents ?? 0} />
                <StatBox label={t('tenants.stats.memberships')} value={stats.memberships ?? 0} />
              </>
            ) : <div className="text-muted-foreground col-span-3">{t('tenants.stats.unavailable')}</div>}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="flags">
          <Card><CardContent className="py-6 text-sm">
            {Object.keys(tenant.featureFlags ?? {}).length === 0
              ? <span className="text-muted-foreground">{t('tenants.flags.empty')}</span>
              : <ul className="space-y-1">{Object.entries(tenant.featureFlags).map(([k, v]) => (
                <li key={k} className="flex items-center justify-between gap-2 border-b py-1">
                  <span className="font-mono text-xs">{k}</span>
                  <Badge className={v ? 'bg-green-500' : 'bg-gray-500'}>{String(v)}</Badge>
                </li>
              ))}</ul>}
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={mono ? 'font-mono text-sm' : 'text-sm'}>{value ?? '—'}</div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

// Phase 3.17 — TenantMembership management UI.
// @tenant-reviewed: phase317-multi-tenant-login
type MembershipRow = Awaited<ReturnType<typeof tenantsApi.listMemberships>>[number];

export function MembersTab({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const { t } = useTranslation('pages');
  // Phase 3.17 — only a SUPER PlatformAdmin viewer may revoke a SUPER
  // target's membership. Backend re-checks this; the UI just hides the
  // X to keep the contract obvious.
  const viewerIsSuper = (getCurrentUser()?.platformAdmin?.level ?? 'NONE') === 'SUPER';
  const [rows, setRows] = useState<MembershipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<any[]>([]);
  const [grantingId, setGrantingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    tenantsApi.listMemberships(tenantId)
      .then((data) => setRows(data))
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [tenantId]);

  // Lazy user search — only fires when the input is non-empty.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setCandidates([]); return; }
    let cancelled = false;
    const handle = setTimeout(() => {
      usersApi.list?.({ search: q, page: 1, limit: 10 })
        .then((res: any) => { if (!cancelled) setCandidates(res?.data ?? []); })
        .catch(() => { if (!cancelled) setCandidates([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [search]);

  const memberUserIds = new Set(
    rows.filter(r => r.status === 'ACTIVE').map(r => r.userId),
  );

  const grant = async (userId: string) => {
    setGrantingId(userId);
    try {
      await tenantsApi.grantMembership(tenantId, userId);
      toast.success(t('tenants.members.toastGranted', { defaultValue: 'Tenant access granted' }));
      setSearch(''); setCandidates([]);
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally { setGrantingId(null); }
  };

  const revoke = async (row: MembershipRow) => {
    const name = row.user ? `${row.user.firstName} ${row.user.lastName}` : row.userId;
    if (!await confirm({
      title: t('tenants.members.confirmRevokeTitle', { defaultValue: 'Revoke tenant access?' }),
      description: t('tenants.members.confirmRevokeDesc', { defaultValue: `${name} will no longer be able to sign in to this tenant.` }),
      variant: 'destructive',
    })) return;
    try {
      await tenantsApi.revokeMembership(tenantId, row.userId);
      toast.success(t('tenants.members.toastRevoked', { defaultValue: 'Tenant access revoked' }));
      load();
    } catch (err) { toast.error(apiError(err)); }
  };

  return (
    <Card>
      <CardContent className="py-6 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-medium">{t('tenants.members.title', { defaultValue: 'Tenant Members' })}</h3>
            <p className="text-sm text-muted-foreground">
              {t('tenants.members.subtitle', { defaultValue: 'Users who can sign in to this tenant via /auth/login-v2.' })}
            </p>
          </div>
          <Badge variant="outline" className="bg-slate-50 text-slate-800 border-slate-300">
            {rows.filter(r => r.status === 'ACTIVE').length} active
          </Badge>
        </div>

        {canManage && (
          <div className="rounded-md border p-3 space-y-2">
            <label className="text-xs font-medium">
              {t('tenants.members.grantLabel', { defaultValue: 'Grant tenant access to a user' })}
            </label>
            <div className="relative">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('tenants.members.searchPlaceholder', { defaultValue: 'Search by name or email…' })}
              />
              {candidates.length > 0 && (
                <div className="absolute z-10 left-0 right-0 mt-1 bg-white border rounded-md shadow-md max-h-60 overflow-auto">
                  {candidates.map((u: any) => {
                    const already = memberUserIds.has(u.id);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        disabled={already || grantingId === u.id}
                        onClick={() => grant(u.id)}
                        className="w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span>
                          <span className="font-medium">{u.firstName} {u.lastName}</span>
                          <span className="text-muted-foreground ms-2">{u.email}</span>
                        </span>
                        {already
                          ? <span className="text-xs text-muted-foreground">{t('tenants.members.alreadyMember', { defaultValue: 'already a member' })}</span>
                          : <UserPlus className="w-4 h-4 text-blue-600" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('tenants.members.cols.user', { defaultValue: 'User' })}</TableHead>
              <TableHead>{t('tenants.members.cols.email', { defaultValue: 'Email' })}</TableHead>
              <TableHead>{t('tenants.members.cols.status', { defaultValue: 'Status' })}</TableHead>
              <TableHead>{t('tenants.members.cols.joinedAt', { defaultValue: 'Joined' })}</TableHead>
              <TableHead className="text-end">{t('tenants.members.cols.actions', { defaultValue: 'Actions' })}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">{t('tenants.list.loading')}</TableCell></TableRow>
            )}
            {!loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">{t('tenants.members.empty', { defaultValue: 'No members yet.' })}</TableCell></TableRow>
            )}
            {!loading && rows.map((r) => {
              const targetIsSuper = r.platformAdminLevel === 'SUPER';
              const canRevokeRow  = canManage && r.status === 'ACTIVE' && (!targetIsSuper || viewerIsSuper);
              return (
                <TableRow key={r.id} className={r.status === 'REMOVED' ? 'opacity-60' : ''}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{r.user ? `${r.user.firstName} ${r.user.lastName}` : r.userId}</span>
                      {targetIsSuper && (
                        <Badge variant="outline" className="bg-red-50 text-red-700 border-red-300">SUPER</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{r.user?.email ?? '—'}</TableCell>
                  <TableCell>
                    <Badge className={
                      r.status === 'ACTIVE'    ? 'bg-green-500' :
                      r.status === 'INVITED'   ? 'bg-amber-500' :
                      r.status === 'SUSPENDED' ? 'bg-red-500'   :
                      'bg-gray-500'
                    }>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">{r.joinedAt ? formatDate(r.joinedAt) : '—'}</TableCell>
                  <TableCell className="text-end">
                    {canRevokeRow && (
                      <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => revoke(r)} title={t('tenants.members.revoke', { defaultValue: 'Revoke access' })}>
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                    {canManage && r.status === 'ACTIVE' && targetIsSuper && !viewerIsSuper && (
                      <span className="text-xs text-muted-foreground" title={t('tenants.members.superLocked', { defaultValue: 'Only a SUPER PlatformAdmin can remove a SUPER user.' })}>
                        🔒
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
