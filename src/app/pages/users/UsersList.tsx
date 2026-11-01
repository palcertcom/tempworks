import { useState, useEffect, useMemo, useRef } from 'react';
import { useColumnWidths, ResizeHandle } from '../../hooks/useColumnWidths';

const USERS_COL_DEFAULTS = {
  num: 60, name: 200, email: 220, role: 130, agency: 160,
  status: 110, lastLogin: 140, createdAt: 110,
  birthDate: 110, age: 70, actions: 200,
};

/** Whole years from a DOB; null for missing / unparseable input. */
function calcAge(dob: string | Date | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 ? age : null;
}
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Plus, Edit, Eye, Search, Trash2, Upload, Download, Copy, Check,
  ArrowUp, ArrowDown, ArrowUpDown, X, Columns2, RefreshCw,
} from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { usersApi, tenantsApi, getCurrentUser, resolveAssetUrl } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { usePermissions } from '../../hooks/usePermissions';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { formatDate } from '../../../i18n/formatters';

const STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING'];

function parseCsvText(text: string): any[] {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const record: any = {};
    headers.forEach((h, i) => { record[h] = values[i] ?? ''; });
    return record;
  });
}

// ── Column visibility ────────────────────────────────────────────────────────
type ColKey = 'email' | 'role' | 'agency' | 'status' | 'lastLogin' | 'createdAt' | 'birthDate' | 'age';

const ALL_COLUMNS: { key: ColKey; labelKey: string; defaultLabel?: string }[] = [
  { key: 'email',     labelKey: 'users.list.cols.email' },
  { key: 'role',      labelKey: 'users.list.cols.role' },
  { key: 'agency',    labelKey: 'users.list.cols.agency' },
  { key: 'status',    labelKey: 'users.list.cols.status' },
  { key: 'lastLogin', labelKey: 'users.list.cols.lastLogin' },
  { key: 'createdAt', labelKey: 'users.list.cols.createdAt', defaultLabel: 'Created' },
  { key: 'birthDate', labelKey: 'users.list.cols.birthDate', defaultLabel: 'Birth Date' },
  { key: 'age',       labelKey: 'users.list.cols.age',       defaultLabel: 'Age' },
];

const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  email: true, role: true, agency: true, status: true, lastLogin: true, createdAt: true,
  birthDate: false, age: false,
};

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const saved = localStorage.getItem('users-table-columns');
    return saved ? { ...DEFAULT_VISIBLE, ...JSON.parse(saved) } : DEFAULT_VISIBLE;
  } catch { return DEFAULT_VISIBLE; }
}

// ── Sort header ──────────────────────────────────────────────────────────────
type SortField = 'userNumber' | 'name' | 'email' | 'role' | 'agency' | 'status' | 'lastLogin' | 'createdAt';

function SortableHead({ label, field, sortBy, sortOrder, onSort, className, colKey, style, startResize }: {
  label: string; field: SortField; sortBy: SortField; sortOrder: 'asc' | 'desc';
  onSort: (f: SortField) => void; className?: string;
  colKey?: string; style?: React.CSSProperties; startResize?: (k: string, e: React.MouseEvent) => void;
}) {
  const active = sortBy === field;
  return (
    <TableHead className={`relative whitespace-normal align-top ${className ?? ''}`} style={style}>
      <button onClick={() => onSort(field)} className="flex items-center gap-1 hover:text-foreground font-medium group text-start break-words">
        <span className="break-words">{label}</span>
        {active
          ? sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-blue-600 shrink-0" /> : <ArrowDown className="w-3 h-3 text-blue-600 shrink-0" />
          : <ArrowUpDown className="w-3 h-3 opacity-30 group-hover:opacity-60 shrink-0" />}
      </button>
      {colKey && startResize && <ResizeHandle onMouseDown={(e) => startResize(colKey, e)} />}
    </TableHead>
  );
}

export function UsersList() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canCreate, canView, canEdit, canDelete } = usePermissions();
  const currentUser = getCurrentUser();
  const isTempworksAdmin = currentUser?.role === 'System Admin' || currentUser?.role === 'HR Manager';
  // Anyone inside a non-system agency is an external tenant and
  // subject to the approval + per-user manager override gate —
  // Agency Manager, HR Manager, Recruiter, etc. all behave the same.
  // Tempworks root-agency users (agencyIsSystem=true) bypass it.
  const isExternalTenantCaller = !!currentUser?.agencyId && currentUser?.agencyIsSystem !== true;

  const isPending = (user: any) => user.approvalStatus === 'PENDING_APPROVAL';
  // Per-user overrides: pending users always act as "open" to the
  // tenant; once approved, only the flag that was flipped on unlocks
  // that specific capability. Use !! to be forgiving about the API
  // serialization (boolean, 1, "true" all pass).
  const canTenantView = (user: any) =>
    isPending(user) || user.allowManagerView !== false;
  const canTenantEdit = (user: any) =>
    isPending(user) || !!user.allowManagerEdit;
  const canTenantDelete = (user: any) =>
    isPending(user) || !!user.allowManagerDelete;
  const mayViewRow = (user: any) =>
    canView('users') && (!isExternalTenantCaller || canTenantView(user));
  const mayEditRow = (user: any) =>
    canEdit('users') && (!isExternalTenantCaller || canTenantEdit(user));
  const mayDeleteRow = (user: any) =>
    canDelete('users') && user.id !== currentUser?.id && (!isExternalTenantCaller || canTenantDelete(user));

  // ── Data ───────────────────────────────────────────────────────────────────
  const [users, setUsers]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Tenant filter (Phase 3.22) ────────────────────────────────────────────
  // Defaults to the caller's active tenant so a Super Admin doesn't see
  // every tenant's users mixed together. PlatformAdmin SUPER and users
  // with multiple memberships get a dropdown to switch.
  const initialTenantId =
    (currentUser as any)?.activeTenantId
    ?? (currentUser as any)?.primaryTenantId
    ?? (currentUser?.memberships?.[0]?.tenantId)
    ?? '';
  // Persist the SUPER tenant filter so the Add User page can default to
  // whichever tenant the operator was just viewing. Read-once on mount.
  const SUPER_TENANT_LS_KEY = 'users-page-tenant-filter';
  const [tenantFilter, setTenantFilter] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(SUPER_TENANT_LS_KEY);
      if (saved && saved.trim()) return saved;
    } catch { /* ignore */ }
    return initialTenantId;
  });
  useEffect(() => {
    try { localStorage.setItem(SUPER_TENANT_LS_KEY, tenantFilter ?? ''); } catch { /* ignore */ }
  }, [tenantFilter]);
  const tenantVersion = useTenantSyncVersion();
  // Tenants offered in the dropdown. Members get their own list; SUPER
  // platform admins get every tenant via tenantsApi.list().
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; name: string }>>(
    Array.isArray(currentUser?.memberships)
      ? currentUser!.memberships!.map(m => ({ id: m.tenantId, name: m.name }))
      : [],
  );
  const isPlatformSuper = (currentUser as any)?.platformAdmin?.level === 'SUPER';

  useEffect(() => {
    if (!isPlatformSuper) return;
    // Pull every tenant for SUPER admins so they can scope the user
    // list to a tenant they aren't a direct member of.
    tenantsApi.list({ limit: 500 })
      .then((res: any) => {
        const rows = Array.isArray(res?.data) ? res.data : [];
        setTenantOptions(rows.map((r: any) => ({ id: r.id, name: r.name })));
      })
      .catch(() => { /* fall back to memberships */ });
  }, [isPlatformSuper]);

  const reload = () => {
    setLoading(true);
    const params: Record<string, any> = { limit: 500 };
    if (tenantFilter) params.tenantId = tenantFilter;
    usersApi.list(params)
      .then((res: any) => setUsers(Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  };

  // Phase 2B (#5) — also refetch when the topbar tenant switches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [tenantFilter, tenantVersion]);

  // ── Filters ────────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]         = useState('');
  const [roleFilter, setRoleFilter]           = useState('');
  const [statusFilter, setStatusFilter]       = useState('');
  const [agencyFilter, setAgencyFilter]       = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [countryFilter, setCountryFilter]     = useState('');

  // ── Sorting ────────────────────────────────────────────────────────────────
  const [sortBy, setSortBy]       = useState<SortField>('createdAt');
  const { headStyle, startResize } = useColumnWidths('users-col-widths-v1', USERS_COL_DEFAULTS);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const handleSort = (field: SortField) => {
    if (sortBy === field) setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortOrder('asc'); }
  };

  // ── Column visibility ──────────────────────────────────────────────────────
  const [visibleColumns, setVisibleColumns] = useState<Record<ColKey, boolean>>(loadVisibleColumns);
  const [showColPicker, setShowColPicker]   = useState(false);
  const colPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showColPicker) return;
    const handler = (e: MouseEvent) => {
      if (colPickerRef.current && !colPickerRef.current.contains(e.target as Node))
        setShowColPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showColPicker]);

  const toggleColumn = (key: ColKey) => {
    setVisibleColumns(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('users-table-columns', JSON.stringify(next));
      return next;
    });
  };

  const col = (key: ColKey) => visibleColumns[key];

  // ── Derived filter options ─────────────────────────────────────────────────
  const roleOptions = useMemo(() => {
    const names = users.map(u => u.role?.name).filter(Boolean) as string[];
    return [...new Set(names)].sort();
  }, [users]);

  const agencyOptions = useMemo(() => {
    const names = users.map(u => u.agency?.name).filter(Boolean) as string[];
    return [...new Set(names)].sort();
  }, [users]);

  const departmentOptions = useMemo(() => {
    const names = users.map(u => u.department).filter(Boolean) as string[];
    return [...new Set(names)].sort();
  }, [users]);

  const countryOptions = useMemo(() => {
    const names = users.map(u => u.country).filter(Boolean) as string[];
    return [...new Set(names)].sort();
  }, [users]);

  // ── Filtered + sorted data ─────────────────────────────────────────────────
  const displayUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let data = users.filter(user => {
      // Full-text search across every visible & common field — the previous
      // version only checked name/email/role/userNumber, which meant typing
      // an agency (or phone, dept, city, etc.) returned nothing.
      if (q) {
        const haystack = [
          user.firstName, user.middleName, user.lastName,
          user.email, user.userNumber,
          user.phone,
          user.role?.name,
          user.agency?.name,
          user.jobTitle, user.department,
          user.city, user.country, user.postalCode,
          user.citizenship,
          user.status,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (roleFilter       && user.role?.name !== roleFilter)     return false;
      if (statusFilter     && user.status      !== statusFilter)   return false;
      if (agencyFilter     && user.agency?.name !== agencyFilter)  return false;
      if (departmentFilter && user.department   !== departmentFilter) return false;
      if (countryFilter    && user.country      !== countryFilter) return false;
      return true;
    });

    return [...data].sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortBy) {
        case 'userNumber': aVal = a.userNumber ?? ''; bVal = b.userNumber ?? ''; break;
        case 'name':       aVal = `${a.firstName ?? ''} ${a.lastName ?? ''}`.toLowerCase(); bVal = `${b.firstName ?? ''} ${b.lastName ?? ''}`.toLowerCase(); break;
        case 'email':      aVal = a.email?.toLowerCase() ?? ''; bVal = b.email?.toLowerCase() ?? ''; break;
        case 'role':       aVal = a.role?.name?.toLowerCase() ?? ''; bVal = b.role?.name?.toLowerCase() ?? ''; break;
        case 'agency':     aVal = a.agency?.name?.toLowerCase() ?? ''; bVal = b.agency?.name?.toLowerCase() ?? ''; break;
        case 'status':     aVal = a.status ?? ''; bVal = b.status ?? ''; break;
        case 'lastLogin':  aVal = a.lastLoginAt ?? ''; bVal = b.lastLoginAt ?? ''; break;
        case 'createdAt':  aVal = a.createdAt ?? '';   bVal = b.createdAt ?? '';   break;
        default:           aVal = ''; bVal = '';
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [users, searchQuery, roleFilter, statusFilter, agencyFilter, departmentFilter, countryFilter, sortBy, sortOrder]);

  const hasActiveFilters = !!(searchQuery || roleFilter || statusFilter || agencyFilter || departmentFilter || countryFilter);
  const clearFilters = () => {
    setSearchQuery(''); setRoleFilter(''); setStatusFilter('');
    setAgencyFilter(''); setDepartmentFilter(''); setCountryFilter('');
  };

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [showImportModal, setShowImportModal]   = useState(false);
  const [csvText, setCsvText]                   = useState('');
  const [importing, setImporting]               = useState(false);
  const [activationLink, setActivationLink]     = useState<string | null>(null);
  const [activationLinkUser, setActivationLinkUser] = useState('');
  const [linkCopied, setLinkCopied]             = useState(false);
  const [loadingLink, setLoadingLink]           = useState<string | null>(null);

  const handleDelete = async (user: any) => {
    if (!(await confirm({
      title: t('users.list.deleteTitle'),
      description: t('users.list.deleteBody', { name: `${user.firstName} ${user.lastName}` }),
      confirmText: tc('actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await usersApi.delete(user.id);
      setUsers(prev => prev.filter(u => u.id !== user.id));
      toast.success(t('users.list.deleteSuccess'));
    } catch (err: any) { toast.error(apiError(err, t('users.list.deleteFailed'))); }
  };

  // ── Tempworks-admin approval ──────────────────────────────────────────────
  // Per-user manager override (allowManagerEdit/Delete) lives on the
  // Edit User page for a clearer UI; this list only surfaces the
  // Approve action on pending rows.
  const [approveBusy, setApproveBusy] = useState<string | null>(null);

  const handleApprove = async (user: any) => {
    setApproveBusy(user.id);
    try {
      await usersApi.approveAgencyUser(user.id);
      toast.success(t('users.list.approveSuccess'));
      reload();
    } catch (err: any) {
      toast.error(apiError(err, t('users.list.approveFailed')));
    } finally {
      setApproveBusy(null);
    }
  };

  const handleBulkImport = async () => {
    if (!csvText.trim()) { toast.error(t('users.list.csvEmpty')); return; }
    const records = parseCsvText(csvText);
    if (records.length === 0) { toast.error(t('users.list.csvNoRecords')); return; }
    setImporting(true);
    try {
      await usersApi.bulkImport(records);
      toast.success(t('users.list.csvImported', { count: records.length }));
      setShowImportModal(false); setCsvText('');
      reload();
    } catch (err: any) { toast.error(apiError(err, t('users.list.bulkImportFailed'))); }
    finally { setImporting(false); }
  };

  const handleGetActivationLink = async (user: any) => {
    setLoadingLink(user.id);
    try {
      const res = await usersApi.getActivationLink(user.id);
      setActivationLink(res.url);
      setActivationLinkUser(`${user.firstName} ${user.lastName}`);
      setLinkCopied(false);
    } catch (err: any) { toast.error(err?.message || t('users.list.activationLinkFailed')); }
    finally { setLoadingLink(null); }
  };

  const handleCopyLink = () => {
    if (!activationLink) return;
    navigator.clipboard.writeText(activationLink).then(() => {
      setLinkCopied(true);
      toast.success(t('users.list.activationLinkCopied'));
      setTimeout(() => setLinkCopied(false), 3000);
    });
  };

  const handleExport = async () => {
    try {
      const data = await usersApi.bulkExport();
      if (!Array.isArray(data) || data.length === 0) { toast.info(t('users.list.noDataToExport')); return; }
      const headers = Object.keys(data[0]).join(',');
      const rows = data.map(row => Object.values(row).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
      const csv = [headers, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `users-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
      toast.success(t('users.list.exportDownloaded'));
    } catch (err: any) { toast.error(err?.message || tc('toast.exportFailed')); }
  };

  const hiddenCount = ALL_COLUMNS.filter(c => !visibleColumns[c.key]).length;
  const colSpan = 2 + ALL_COLUMNS.filter(c => visibleColumns[c.key]).length + 1; // # + user + visible + actions

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('users.list.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('users.list.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
            <RefreshCw className={`w-4 h-4 me-1 ${loading ? 'animate-spin' : ''}`} />
            {t('users.list.refresh')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="w-4 h-4 me-2" />{t('users.list.export')}
          </Button>
          {canCreate('users') && (
            <Button variant="outline" size="sm" onClick={() => setShowImportModal(true)}>
              <Upload className="w-4 h-4 me-2" />{t('users.list.bulkImport')}
            </Button>
          )}
          {canCreate('users') && (
            <Button asChild>
              <Link to="/dashboard/users/add">
                <Plus className="w-4 h-4 me-2" />{t('users.list.addButton')}
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Row 1: search (full width, so the icon can't get pushed out of
              place by wrapping filter pills) */}
          <div className="relative w-full">
            <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t('users.list.searchPh')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="ps-9 w-full"
            />
          </div>

          {/* Row 2: filter pills + column picker */}
          <div className="flex flex-wrap gap-3 items-center">
            {roleOptions.length > 0 && (
              <Select value={roleFilter || '__all__'} onValueChange={v => setRoleFilter(v === '__all__' ? '' : v)}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t('users.list.filterAllRoles')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('users.list.filterAllRoles')}</SelectItem>
                  {roleOptions.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            <Select value={statusFilter || '__all__'} onValueChange={v => setStatusFilter(v === '__all__' ? '' : v)}>
              <SelectTrigger className="w-40"><SelectValue placeholder={t('users.list.filterAllStatuses')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('users.list.filterAllStatuses')}</SelectItem>
                {STATUSES.map(s => <SelectItem key={s} value={s}>{t(`users.list.statuses.${s.toLowerCase()}`)}</SelectItem>)}
              </SelectContent>
            </Select>

            {/* Tenant filter — visible whenever the user has multiple
                memberships or is a SUPER platform admin. Defaults to
                the active tenant so a Super Admin doesn't open the
                page to a global mash-up of every tenant's users. */}
            {(tenantOptions.length > 1 || isPlatformSuper) && (
              <Select
                value={tenantFilter || '__all__'}
                onValueChange={v => setTenantFilter(v === '__all__' ? '' : v)}
              >
                <SelectTrigger className="w-44">
                  <SelectValue placeholder={t('users.list.filterAllTenants', { defaultValue: 'All tenants' })} />
                </SelectTrigger>
                <SelectContent>
                  {isPlatformSuper && (
                    <SelectItem value="__all__">
                      {t('users.list.filterAllTenants', { defaultValue: 'All tenants' })}
                    </SelectItem>
                  )}
                  {tenantOptions.map(opt => (
                    <SelectItem key={opt.id} value={opt.id}>{opt.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {agencyOptions.length > 0 && (
              <Select value={agencyFilter || '__all__'} onValueChange={v => setAgencyFilter(v === '__all__' ? '' : v)}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t('users.list.filterAllAgencies')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('users.list.filterAllAgencies')}</SelectItem>
                  {agencyOptions.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            {departmentOptions.length > 0 && (
              <Select value={departmentFilter || '__all__'} onValueChange={v => setDepartmentFilter(v === '__all__' ? '' : v)}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t('users.list.filterAllDepts')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('users.list.filterAllDepts')}</SelectItem>
                  {departmentOptions.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            {countryOptions.length > 0 && (
              <Select value={countryFilter || '__all__'} onValueChange={v => setCountryFilter(v === '__all__' ? '' : v)}>
                <SelectTrigger className="w-40"><SelectValue placeholder={t('users.list.filterAllCountries')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('users.list.filterAllCountries')}</SelectItem>
                  {countryOptions.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5 me-1" />{t('users.list.clearFilters')}
              </Button>
            )}

            {/* Column picker */}
            <div className="relative ms-auto" ref={colPickerRef}>
              <Button
                variant="outline" size="sm"
                onClick={() => setShowColPicker(v => !v)}
                className={showColPicker ? 'border-blue-500 text-blue-600' : ''}
              >
                <Columns2 className="w-4 h-4 me-1.5" />{t('users.list.columns')}
                {hiddenCount > 0 && (
                  <span className="ms-1.5 bg-blue-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                    {hiddenCount}
                  </span>
                )}
              </Button>
              {showColPicker && (
                <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[180px]">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{t('users.list.toggleCols')}</p>
                  <div className="space-y-0.5">
                    {ALL_COLUMNS.map(c => (
                      <button key={c.key} onClick={() => toggleColumn(c.key)} className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 text-sm text-start">
                        <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${visibleColumns[c.key] ? 'bg-blue-600 border-blue-600' : 'border-gray-300'}`}>
                          {visibleColumns[c.key] && <Check className="w-2.5 h-2.5 text-white" />}
                        </span>
                        {t(c.labelKey, { defaultValue: c.defaultLabel ?? c.labelKey })}
                      </button>
                    ))}
                  </div>
                  <div className="border-t mt-2 pt-2 flex gap-1.5">
                    <button onClick={() => { const all = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, true])) as Record<ColKey, boolean>; setVisibleColumns(all); localStorage.setItem('users-table-columns', JSON.stringify(all)); }} className="flex-1 text-xs text-center text-blue-600 hover:underline py-0.5">{t('users.list.showAll')}</button>
                    <span className="text-gray-300">|</span>
                    <button onClick={() => { const none = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, false])) as Record<ColKey, boolean>; setVisibleColumns(none); localStorage.setItem('users-table-columns', JSON.stringify(none)); }} className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5">{t('users.list.hideAll')}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-6">
          <div className="border rounded-lg overflow-x-auto">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <SortableHead colKey="num"  style={headStyle('num')}  startResize={startResize} label={t('users.list.cols.userNumber')} field="userNumber" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                  <SortableHead colKey="name" style={headStyle('name')} startResize={startResize} label={t('users.list.cols.user')}       field="name"       sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                  {col('email')     && <SortableHead colKey="email"     style={headStyle('email')}     startResize={startResize} label={t('users.list.cols.email')}     field="email"     sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('role')      && <SortableHead colKey="role"      style={headStyle('role')}      startResize={startResize} label={t('users.list.cols.role')}      field="role"      sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('agency')    && <SortableHead colKey="agency"    style={headStyle('agency')}    startResize={startResize} label={t('users.list.cols.agency')}    field="agency"    sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('status')    && <SortableHead colKey="status"    style={headStyle('status')}    startResize={startResize} label={t('users.list.cols.status')}    field="status"    sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('lastLogin') && <SortableHead colKey="lastLogin" style={headStyle('lastLogin')} startResize={startResize} label={t('users.list.cols.lastLogin')} field="lastLogin" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('createdAt') && <SortableHead colKey="createdAt" style={headStyle('createdAt')} startResize={startResize} label={t('users.list.cols.createdAt', { defaultValue: 'Created' })} field="createdAt" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('birthDate') && <TableHead className="relative whitespace-normal align-top" style={headStyle('birthDate')}>{t('users.list.cols.birthDate', { defaultValue: 'Birth Date' })}<ResizeHandle onMouseDown={(e) => startResize('birthDate', e)} /></TableHead>}
                  {col('age')       && <TableHead className="relative whitespace-normal align-top" style={headStyle('age')}>{t('users.list.cols.age', { defaultValue: 'Age' })}<ResizeHandle onMouseDown={(e) => startResize('age', e)} /></TableHead>}
                  <TableHead className="text-end relative whitespace-normal align-top" style={headStyle('actions')}>{t('users.list.actionsHeader')}<ResizeHandle onMouseDown={(e) => startResize('actions', e)} /></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
                {loading ? (
                  <TableRow><TableCell colSpan={colSpan} className="text-center py-8 text-muted-foreground">{tc('states.loading')}</TableCell></TableRow>
                ) : displayUsers.length === 0 ? (
                  <TableRow><TableCell colSpan={colSpan} className="text-center py-8 text-muted-foreground">{t('users.list.empty')}</TableCell></TableRow>
                ) : displayUsers.map(user => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">{user.userNumber ?? '—'}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {user.photoUrl ? (
                          <img
                            src={resolveAssetUrl(user.photoUrl)}
                            alt={`${user.firstName} ${user.lastName}`}
                            className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                          />
                        ) : (
                          <div
                            className="w-8 h-8 rounded-full bg-[#EFF6FF] flex items-center justify-center text-[#2563EB] text-xs font-bold flex-shrink-0"
                            aria-label={`${user.firstName} ${user.lastName}`}
                          >
                            {`${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || '?'}
                          </div>
                        )}
                        <div>
                          <div className="font-medium">{user.firstName} {user.lastName}</div>
                          <div className="text-xs text-muted-foreground">{user.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    {col('email')  && <TableCell className="text-sm">{user.email}</TableCell>}
                    {col('role')   && (
                      <TableCell>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge variant="outline" className={
                            user.role?.name?.toLowerCase().includes('admin') ? 'bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]' :
                            user.role?.name?.toLowerCase().includes('hr')    ? 'bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]' :
                            'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0]'
                          }>
                            {user.role?.name ?? '—'}
                          </Badge>
                          {user.platformAdmin?.level && user.platformAdmin.level !== 'NONE' && (
                            <Badge variant="outline" className={
                              user.platformAdmin.level === 'SUPER'    ? 'bg-[#FEF2F2] text-[#DC2626] border-[#DC2626]' :
                              user.platformAdmin.level === 'OPERATOR' ? 'bg-[#FFF7ED] text-[#EA580C] border-[#EA580C]' :
                              'bg-[#F5F3FF] text-[#7C3AED] border-[#7C3AED]'
                            }>
                              {user.platformAdmin.level}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                    )}
                    {col('agency')    && <TableCell className="text-sm">{user.agency?.name ?? '—'}</TableCell>}
                    {col('status')    && (
                      <TableCell>
                        <Badge className={user.status === 'ACTIVE' ? 'bg-green-500' : user.status === 'PENDING' ? 'bg-amber-500' : user.status === 'SUSPENDED' ? 'bg-red-500' : 'bg-gray-500'}>
                          {user.status ? t(`users.list.statuses.${String(user.status).toLowerCase()}`, { defaultValue: user.status }) : '—'}
                        </Badge>
                      </TableCell>
                    )}
                    {col('lastLogin') && (
                      <TableCell className="text-sm">
                        {user.lastLoginAt ? formatDate(user.lastLoginAt) : '—'}
                      </TableCell>
                    )}
                    {col('createdAt') && (
                      <TableCell className="text-sm whitespace-nowrap">
                        {user.createdAt ? formatDate(user.createdAt) : '—'}
                      </TableCell>
                    )}
                    {col('birthDate') && (
                      <TableCell className="text-sm whitespace-nowrap">
                        {user.dateOfBirth ? formatDate(user.dateOfBirth) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    {col('age') && (
                      <TableCell className="text-sm tabular-nums">
                        {calcAge(user.dateOfBirth) ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        {canEdit('users') && (user.status === 'PENDING' || user.status === 'INACTIVE') && (
                          <Button variant="ghost" size="sm" onClick={() => handleGetActivationLink(user)} disabled={loadingLink === user.id} className="text-amber-600 hover:text-amber-700 hover:bg-amber-50 text-xs" title={t('users.list.activationLinkTooltip')}>
                            <Copy className="w-3.5 h-3.5 me-1" />
                            {loadingLink === user.id ? '...' : t('users.list.activationLink')}
                          </Button>
                        )}
                        {/* Approval pill (pending only) */}
                        {user.approvalStatus === 'PENDING_APPROVAL' && (
                          <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 bg-amber-50">{t('users.list.pendingApproval')}</Badge>
                        )}
                        {isTempworksAdmin && user.approvalStatus === 'PENDING_APPROVAL' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleApprove(user)}
                            disabled={approveBusy === user.id}
                            className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 text-xs"
                            title={t('users.list.approveTooltip')}
                          >
                            {approveBusy === user.id ? '…' : t('users.list.approve')}
                          </Button>
                        )}
                        {/* Per-user manager override toggles live on the Edit User page — System Admin only. */}
                        {/* View-only button — shown when the caller has view
                            access but no edit override (otherwise Edit implies
                            view and this row would be redundant). */}
                        {mayViewRow(user) && !mayEditRow(user) && (
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/dashboard/users/${user.id}/edit`}><Eye className="w-4 h-4 me-1" />{t('users.list.view')}</Link>
                          </Button>
                        )}
                        {mayEditRow(user) && (
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/dashboard/users/${user.id}/edit`}><Edit className="w-4 h-4 me-1" />{t('users.list.edit')}</Link>
                          </Button>
                        )}
                        {mayDeleteRow(user) && (
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(user)} className="text-[#EF4444] hover:text-[#EF4444] hover:bg-[#FEF2F2]">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-sm text-muted-foreground mt-4">
            {t('users.list.showingOf', { shown: displayUsers.length, total: users.length })}
          </p>
        </CardContent>
      </Card>

      {/* Activation Link Modal */}
      {activationLink && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-[#0F172A]">{t('users.list.activationLinkTitle')}</h2>
              <Button variant="ghost" size="sm" onClick={() => setActivationLink(null)}>✕</Button>
            </div>
            <p className="text-sm text-muted-foreground"
              dangerouslySetInnerHTML={{ __html: t('users.list.shareLink', { name: activationLinkUser }) }}
            />
            <div className="bg-gray-50 border rounded-md p-3 break-all text-sm font-mono text-gray-700">{activationLink}</div>
            <div className="flex gap-3 pt-1">
              <Button className="flex-1" onClick={handleCopyLink}>
                {linkCopied ? <Check className="w-4 h-4 me-2 text-green-400" /> : <Copy className="w-4 h-4 me-2" />}
                {linkCopied ? t('users.list.copied') : t('users.list.copyLink')}
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => setActivationLink(null)}>{t('users.list.close')}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-[#0F172A]">{t('users.list.bulkImportTitle')}</h2>
              <Button variant="ghost" size="sm" onClick={() => { setShowImportModal(false); setCsvText(''); }}>✕</Button>
            </div>
            <p className="text-sm text-muted-foreground"
              dangerouslySetInnerHTML={{ __html: t('users.list.csvHelp') }}
            />
            <div className="space-y-2">
              <Label htmlFor="csvInput">{t('users.list.csvDataLabel')}</Label>
              <textarea
                id="csvInput" rows={10}
                className="w-full border rounded-md p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                placeholder={`firstName,lastName,email,roleId,agencyId\nJohn,Smith,john@example.com,role-id,agency-id`}
                value={csvText}
                onChange={e => setCsvText(e.target.value)}
              />
            </div>
            {csvText.trim() && (
              <p className="text-xs text-muted-foreground">{t('users.list.csvPreview', { count: parseCsvText(csvText).length })}</p>
            )}
            <div className="flex gap-3 pt-2">
              <Button className="flex-1" onClick={handleBulkImport} disabled={importing || !csvText.trim()}>
                {importing ? t('users.list.importing') : t('users.list.importRecords')}
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => { setShowImportModal(false); setCsvText(''); }}>{tc('actions.cancel')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
