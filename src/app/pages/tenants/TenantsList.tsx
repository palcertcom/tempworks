import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Edit, Eye, Archive, Power, Trash2, RotateCcw } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { tenantsApi, getCurrentUser, type TenantRecord } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { formatDate } from '../../../i18n/formatters';

// Phase 3.15 — Tenant Management list page.
// @tenant-reviewed: phase315-tenant-management-module
export function TenantsList() {
  const { t } = useTranslation('pages');
  const me = getCurrentUser();
  const level = me?.platformAdmin?.level ?? 'NONE';
  const isSuper = level === 'SUPER';
  const canWrite = level === 'SUPER' || level === 'OPERATOR';

  const [rows, setRows] = useState<TenantRecord[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    tenantsApi.list({ search: search || undefined, status: status || undefined, includeDeleted })
      .then(res => setRows(res.data))
      .catch(err => toast.error(apiError(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, includeDeleted]);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const s = search.toLowerCase();
    return rows.filter(r =>
      r.name.toLowerCase().includes(s) ||
      r.slug.toLowerCase().includes(s) ||
      (r.customDomain ?? '').toLowerCase().includes(s),
    );
  }, [rows, search]);

  const statusBadge = (s: string) => {
    const cls =
      s === 'ACTIVE'    ? 'bg-green-500'  :
      s === 'SUSPENDED' ? 'bg-amber-500'  :
      s === 'INACTIVE'  ? 'bg-gray-500'   : 'bg-gray-400';
    return <Badge className={cls}>{t(`tenants.statuses.${s.toLowerCase()}`, { defaultValue: s })}</Badge>;
  };

  const onArchive = async (id: string) => {
    if (!await confirm({ title: t('tenants.confirmArchiveTitle'), description: t('tenants.confirmArchiveDesc') })) return;
    try { await tenantsApi.archive(id); toast.success(t('tenants.toastArchived')); load(); }
    catch (err) { toast.error(apiError(err)); }
  };
  const onActivate = async (id: string) => {
    try { await tenantsApi.activate(id); toast.success(t('tenants.toastActivated')); load(); }
    catch (err) { toast.error(apiError(err)); }
  };
  const onDelete = async (id: string) => {
    if (!await confirm({ title: t('tenants.confirmDeleteTitle'), description: t('tenants.confirmDeleteDesc'), variant: 'destructive' })) return;
    try { await tenantsApi.remove(id); toast.success(t('tenants.toastDeleted')); load(); }
    catch (err) { toast.error(apiError(err)); }
  };
  const onRestore = async (id: string) => {
    try { await tenantsApi.restore(id); toast.success(t('tenants.toastRestored')); load(); }
    catch (err) { toast.error(apiError(err)); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('tenants.list.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('tenants.list.subtitle')}</p>
        </div>
        {isSuper && (
          <Button asChild>
            <Link to="/dashboard/tenants/new"><Plus className="w-4 h-4 me-1.5" />{t('tenants.list.addTenant')}</Link>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="py-4 flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('tenants.list.searchPlaceholder')} className="ps-9" />
          </div>
          <Select value={status || '__all__'} onValueChange={(v) => setStatus(v === '__all__' ? '' : v)}>
            <SelectTrigger className="w-44"><SelectValue placeholder={t('tenants.list.allStatuses')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('tenants.list.allStatuses')}</SelectItem>
              <SelectItem value="ACTIVE">{t('tenants.statuses.active')}</SelectItem>
              <SelectItem value="SUSPENDED">{t('tenants.statuses.suspended')}</SelectItem>
              <SelectItem value="INACTIVE">{t('tenants.statuses.inactive')}</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
            <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
            {t('tenants.list.includeDeleted')}
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('tenants.list.cols.name')}</TableHead>
                <TableHead>{t('tenants.list.cols.slug')}</TableHead>
                <TableHead>{t('tenants.list.cols.domain')}</TableHead>
                <TableHead>{t('tenants.list.cols.status')}</TableHead>
                <TableHead>{t('tenants.list.cols.created')}</TableHead>
                <TableHead className="text-end">{t('tenants.list.cols.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">{t('tenants.list.loading')}</TableCell></TableRow>
              )}
              {!loading && filtered.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">{t('tenants.list.empty')}</TableCell></TableRow>
              )}
              {!loading && filtered.map(r => {
                const softDeleted = !!r.deletedAt;
                return (
                  <TableRow key={r.id} className={softDeleted ? 'opacity-60' : ''}>
                    <TableCell>
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">{r.region}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.slug}</TableCell>
                    <TableCell className="text-sm">{r.customDomain ?? '—'}</TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell className="text-sm">{formatDate(r.createdAt)}</TableCell>
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button asChild variant="ghost" size="sm" title={t('tenants.list.view')}>
                          <Link to={`/dashboard/tenants/${r.id}`}><Eye className="w-4 h-4" /></Link>
                        </Button>
                        {canWrite && !softDeleted && (
                          <Button asChild variant="ghost" size="sm" title={t('tenants.list.edit')}>
                            <Link to={`/dashboard/tenants/${r.id}/edit`}><Edit className="w-4 h-4" /></Link>
                          </Button>
                        )}
                        {canWrite && !softDeleted && r.status === 'ACTIVE' && (
                          <Button variant="ghost" size="sm" onClick={() => onArchive(r.id)} title={t('tenants.list.archive')}>
                            <Archive className="w-4 h-4" />
                          </Button>
                        )}
                        {canWrite && !softDeleted && r.status !== 'ACTIVE' && (
                          <Button variant="ghost" size="sm" onClick={() => onActivate(r.id)} title={t('tenants.list.activate')}>
                            <Power className="w-4 h-4" />
                          </Button>
                        )}
                        {isSuper && softDeleted && (
                          <Button variant="ghost" size="sm" onClick={() => onRestore(r.id)} title={t('tenants.list.restore')}>
                            <RotateCcw className="w-4 h-4" />
                          </Button>
                        )}
                        {isSuper && !softDeleted && (
                          <Button variant="ghost" size="sm" onClick={() => onDelete(r.id)} title={t('tenants.list.delete')} className="text-red-600 hover:text-red-700">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
