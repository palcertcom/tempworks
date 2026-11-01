import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, Download, Trash2, RefreshCw, FileText, Users, Activity, Shield,
  AlertTriangle, ChevronLeft, ChevronRight,
  ArrowUp, ArrowDown, ArrowUpDown, Columns2, Check, X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Label } from '../../components/ui/label';
import { logsApi } from '../../services/api';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { useAuthContext } from '../../contexts/AuthContext';
import { formatDateTime } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';

// ─── helpers ─────────────────────────────────────────────────────────────────
function getActionBadge(action: string) {
  const a = action?.toUpperCase() ?? '';
  if (a === 'CREATE') return <Badge className="bg-emerald-500 text-white">{action}</Badge>;
  if (a === 'UPDATE' || a === 'UPDATE_PROFILE') return <Badge className="bg-blue-500 text-white">{action}</Badge>;
  if (a === 'DELETE') return <Badge className="bg-red-500 text-white">{action}</Badge>;
  if (a === 'LOGIN') return <Badge className="bg-violet-500 text-white">LOGIN</Badge>;
  if (a === 'LOGOUT') return <Badge variant="outline">LOGOUT</Badge>;
  if (a === 'LOGIN_FAILED' || a === 'CHANGE_PASSWORD_FAILED') return <Badge className="bg-orange-500 text-white">{action}</Badge>;
  if (a.includes('UPLOAD') || a.includes('VERIFY')) return <Badge className="bg-cyan-500 text-white">{action}</Badge>;
  if (a.includes('STAGE') || a.includes('WORKFLOW')) return <Badge className="bg-amber-500 text-white">{action}</Badge>;
  if (a.includes('CHANGE_PASSWORD') || a.includes('PASSWORD')) return <Badge className="bg-purple-500 text-white">{action}</Badge>;
  return <Badge variant="outline">{action}</Badge>;
}

/**
 * Format a log timestamp as CET/CEST (Europe/Bratislava) with a
 * weekday abbreviation. The system stores UTC; rendering against a
 * fixed timezone keeps every viewer in sync and matches what the
 * accounting team expects when auditing logs.
 * Example: "Wed, 27.05.2026 10:36".
 */
function formatDate(iso: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bratislava',
    weekday: 'short',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (k: string) => parts.find(p => p.type === k)?.value ?? '';
  return `${get('weekday')}, ${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

function exportToCsv(rows: any[]) {
  const headers = ['Timestamp', 'User', 'Email', 'Action', 'Entity', 'EntityId', 'IP Address'];
  const lines = [
    headers.join(','),
    ...rows.map(r => [
      formatDate(r.createdAt),
      r.user ? `${r.user.firstName} ${r.user.lastName}` : r.userEmail ?? '—',
      r.user?.email ?? r.userEmail ?? '—',
      r.action,
      r.entity,
      r.entityId,
      r.ipAddress ?? '—',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Column visibility ───────────────────────────────────────────────────────
type ColKey =
  | 'timestamp' | 'user' | 'userEmail' | 'action' | 'entity'
  | 'entityId' | 'changes' | 'ipAddress' | 'userAgent' | 'tenant';

const ALL_COLUMNS: { key: ColKey; labelKey: string; superOnly?: boolean }[] = [
  { key: 'timestamp', labelKey: 'logs.list.cols.timestamp' },
  { key: 'user',      labelKey: 'logs.list.cols.user' },
  { key: 'userEmail', labelKey: 'logs.list.cols.userEmail' },
  { key: 'action',    labelKey: 'logs.list.cols.action' },
  { key: 'entity',    labelKey: 'logs.list.cols.entity' },
  { key: 'entityId',  labelKey: 'logs.list.cols.entityId' },
  { key: 'tenant',    labelKey: 'logs.list.cols.tenant', superOnly: true },
  { key: 'changes',   labelKey: 'logs.list.cols.changes' },
  { key: 'ipAddress', labelKey: 'logs.list.cols.ipAddress' },
  { key: 'userAgent', labelKey: 'logs.list.cols.userAgent' },
];

const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  timestamp: true, user: true, action: true, entity: true,
  entityId: true, changes: true, ipAddress: true,
  // Tenant is shown by default for SUPER users (hidden for everyone
  // else regardless of this value — see `effectiveColumns` below).
  tenant: true,
  userEmail: false, userAgent: false,
};

const STORAGE_KEY = 'system-logs-table-columns';

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...DEFAULT_VISIBLE, ...JSON.parse(saved) } : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

// ─── Sorting ─────────────────────────────────────────────────────────────────
type SortField = ColKey;
type SortOrder = 'asc' | 'desc';

// ─── component ───────────────────────────────────────────────────────────────
export function LogsDashboard() {
  const { t } = useTranslation('pages');
  const { user: currentUser } = useAuthContext();
  const isAdmin = currentUser?.role === 'System Admin';
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenantVersion = useTenantSyncVersion();
  const tenant = useSuperUserTenantFilter();

  // filters
  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [dateRange, setDateRange] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [ipFilter, setIpFilter] = useState('');
  const [entityIdFilter, setEntityIdFilter] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  // sorting
  const [sortBy, setSortBy] = useState<SortField>('timestamp');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const handleSort = (f: SortField) => {
    if (sortBy === f) setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSortBy(f); setSortOrder('asc'); }
  };

  // column visibility
  const [visibleColumns, setVisibleColumns] = useState<Record<ColKey, boolean>>(loadVisibleColumns);
  const [showColPicker,  setShowColPicker]  = useState(false);
  const colPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showColPicker) return;
    const handler = (e: MouseEvent) => {
      if (colPickerRef.current && !colPickerRef.current.contains(e.target as Node)) {
        setShowColPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showColPicker]);

  const toggleColumn = (key: ColKey) => {
    setVisibleColumns(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  // Hide superOnly columns (Tenant) entirely for non-platform users —
  // they can't even toggle them in the column picker, and the column
  // doesn't take a slot in the table or the visible-count maths.
  const effectiveColumns = ALL_COLUMNS.filter(c => !c.superOnly || tenant.isPlatformSuper);
  const col = (key: ColKey) => {
    const def = ALL_COLUMNS.find(c => c.key === key);
    if (def?.superOnly && !tenant.isPlatformSuper) return false;
    return visibleColumns[key];
  };
  const hiddenCount  = effectiveColumns.filter(c => !visibleColumns[c.key]).length;
  const visibleCount = effectiveColumns.filter(c =>  visibleColumns[c.key]).length;

  // data
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);

  // clear logs dialog
  const [clearOpen, setClearOpen] = useState(false);
  const [clearFrom, setClearFrom] = useState('');
  const [clearTo, setClearTo] = useState('');
  const [clearEntity, setClearEntity] = useState('');
  const [clearing, setClearing] = useState(false);

  const getDateFilter = useCallback(() => {
    const now = new Date();
    if (dateRange === 'today') {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      return { fromDate: start.toISOString() };
    }
    if (dateRange === 'week') {
      const start = new Date(now.getTime() - 7 * 86400000);
      return { fromDate: start.toISOString() };
    }
    if (dateRange === 'month') {
      const start = new Date(now.getTime() - 30 * 86400000);
      return { fromDate: start.toISOString() };
    }
    if (dateRange === 'quarter') {
      const start = new Date(now.getTime() - 90 * 86400000);
      return { fromDate: start.toISOString() };
    }
    if (dateRange === 'custom') {
      const out: Record<string, any> = {};
      if (customFrom) out.fromDate = new Date(customFrom).toISOString();
      if (customTo) {
        const end = new Date(customTo); end.setHours(23, 59, 59, 999);
        out.toDate = end.toISOString();
      }
      return out;
    }
    return {};
  }, [dateRange, customFrom, customTo]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = { page, limit, search: search || undefined };
      if (entityFilter !== 'all') params.entity = entityFilter;
      if (actionFilter !== 'all') params.action = actionFilter;
      Object.assign(params, getDateFilter());
      tenant.applyToParams(params);
      Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);
      const res = await logsApi.list(params);
      setLogs(res?.data ?? res?.items ?? []);
      setTotal(res?.total ?? res?.meta?.total ?? 0);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [page, search, entityFilter, actionFilter, getDateFilter, tenantVersion, tenant.tenantFilter]);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      // Send the active SUPER tenant filter so the dashboard cards
      // line up with the rows below them.
      const params = tenant.applyToParams({});
      const s = await logsApi.getStats(params);
      setStats(s);
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
    // Re-fetch whenever the SUPER tenant picker changes so the cards
    // and the row list stay aligned.
  }, [tenant.tenantFilter, tenantVersion]);

  useEffect(() => { setPage(1); }, [search, entityFilter, actionFilter, dateRange, customFrom, customTo]);
  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  const handleClearLogs = async () => {
    setClearing(true);
    try {
      const filters: any = {};
      if (clearFrom) filters.fromDate = clearFrom;
      if (clearTo) filters.toDate = clearTo;
      if (clearEntity && clearEntity !== 'all') filters.entity = clearEntity;
      await logsApi.clearLogs(filters);
      setClearOpen(false);
      setClearFrom(''); setClearTo(''); setClearEntity('');
      await Promise.all([fetchLogs(), fetchStats()]);
    } finally {
      setClearing(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  // Unique entities for filter dropdowns
  const knownEntities = ['User', 'Role', 'Agency', 'Employee', 'Applicant', 'Application',
    'Document', 'WorkflowStage', 'JobType', 'DocumentType', 'NotificationRule', 'Settings'];

  // ─── Client-side filter + sort of the current page ────────────────────────
  const displayLogs = useMemo(() => {
    let data = logs;

    if (userFilter) {
      const q = userFilter.toLowerCase();
      data = data.filter(log => {
        const name = log.user
          ? `${log.user.firstName ?? ''} ${log.user.lastName ?? ''}`
          : (log.userEmail ?? '');
        const email = log.user?.email ?? log.userEmail ?? '';
        return name.toLowerCase().includes(q) || email.toLowerCase().includes(q);
      });
    }
    if (ipFilter) {
      const q = ipFilter.toLowerCase();
      data = data.filter(log => (log.ipAddress ?? '').toLowerCase().includes(q));
    }
    if (entityIdFilter) {
      const q = entityIdFilter.toLowerCase();
      data = data.filter(log => (log.entityId ?? '').toLowerCase().includes(q));
    }

    return [...data].sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortBy) {
        case 'timestamp':
          aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0; break;
        case 'user':
          aVal = (a.user ? `${a.user.firstName ?? ''} ${a.user.lastName ?? ''}` : (a.userEmail ?? '')).toLowerCase();
          bVal = (b.user ? `${b.user.firstName ?? ''} ${b.user.lastName ?? ''}` : (b.userEmail ?? '')).toLowerCase(); break;
        case 'userEmail':
          aVal = (a.user?.email ?? a.userEmail ?? '').toLowerCase();
          bVal = (b.user?.email ?? b.userEmail ?? '').toLowerCase(); break;
        case 'action':    aVal = (a.action ?? '').toLowerCase();    bVal = (b.action ?? '').toLowerCase(); break;
        case 'entity':    aVal = (a.entity ?? '').toLowerCase();    bVal = (b.entity ?? '').toLowerCase(); break;
        case 'entityId':  aVal = (a.entityId ?? '').toLowerCase();  bVal = (b.entityId ?? '').toLowerCase(); break;
        case 'changes':
          aVal = a.changes ? JSON.stringify(a.changes).toLowerCase() : '';
          bVal = b.changes ? JSON.stringify(b.changes).toLowerCase() : ''; break;
        case 'ipAddress': aVal = (a.ipAddress ?? '').toLowerCase(); bVal = (b.ipAddress ?? '').toLowerCase(); break;
        case 'userAgent': aVal = (a.userAgent ?? '').toLowerCase(); bVal = (b.userAgent ?? '').toLowerCase(); break;
        default: aVal = ''; bVal = '';
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [logs, userFilter, ipFilter, entityIdFilter, sortBy, sortOrder]);

  const hasExtraFilters = !!(userFilter || ipFilter || entityIdFilter
    || (dateRange === 'custom' && (customFrom || customTo)));

  const clearExtraFilters = () => {
    setUserFilter(''); setIpFilter(''); setEntityIdFilter('');
    setCustomFrom(''); setCustomTo('');
  };

  const SortableHead = ({ label, field }: { label: string; field: SortField }) => {
    const active = sortBy === field;
    return (
      <th className="text-start px-4 py-3 font-medium text-muted-foreground">
        <button onClick={() => handleSort(field)} className="flex items-center gap-1 hover:text-foreground group">
          {label}
          {active
            ? sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-primary" /> : <ArrowDown className="w-3 h-3 text-primary" />
            : <ArrowUpDown className="w-3 h-3 opacity-30 group-hover:opacity-60" />}
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t('logs.dashboard.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('logs.dashboard.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { fetchLogs(); fetchStats(); }}>
            <RefreshCw className="w-4 h-4 me-1.5" />
            {t('logs.dashboard.refresh')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportToCsv(displayLogs)} disabled={displayLogs.length === 0}>
            <Download className="w-4 h-4 me-1.5" />
            {t('logs.dashboard.exportCsv')}
          </Button>
          {/* Column picker */}
          <div className="relative" ref={colPickerRef}>
            <Button
              variant="outline" size="sm"
              onClick={() => setShowColPicker(v => !v)}
              className={showColPicker ? 'border-primary text-primary' : ''}
            >
              <Columns2 className="w-4 h-4 me-1.5" />{t('logs.dashboard.columns')}
              {hiddenCount > 0 && (
                <span className="ms-1.5 bg-primary text-primary-foreground text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                  {hiddenCount}
                </span>
              )}
            </Button>
            {showColPicker && (
              <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[200px]">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{t('logs.dashboard.toggleColumns')}</p>
                <div className="space-y-0.5 max-h-72 overflow-y-auto">
                  {effectiveColumns.map(c => (
                    <button
                      key={c.key}
                      onClick={() => toggleColumn(c.key)}
                      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 text-sm text-start"
                    >
                      <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${visibleColumns[c.key] ? 'bg-primary border-primary' : 'border-gray-300'}`}>
                        {visibleColumns[c.key] && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                      </span>
                      {t(c.labelKey)}
                    </button>
                  ))}
                </div>
                <div className="border-t mt-2 pt-2 flex gap-1.5">
                  <button
                    onClick={() => {
                      const all = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, true])) as Record<ColKey, boolean>;
                      setVisibleColumns(all);
                      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
                    }}
                    className="flex-1 text-xs text-center text-primary hover:underline py-0.5"
                  >{t('logs.dashboard.showAll')}</button>
                  <span className="text-gray-300">|</span>
                  <button
                    onClick={() => {
                      setVisibleColumns(DEFAULT_VISIBLE);
                      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_VISIBLE));
                    }}
                    className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5"
                  >{t('logs.dashboard.reset')}</button>
                </div>
              </div>
            )}
          </div>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive border-destructive hover:bg-destructive hover:text-destructive-foreground"
              onClick={() => setClearOpen(true)}
            >
              <Trash2 className="w-4 h-4 me-1.5" />
              {t('logs.dashboard.clearLogs')}
            </Button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            icon: FileText, label: t('logs.dashboard.totalLogs'),
            value: statsLoading ? '…' : (stats?.total ?? 0).toLocaleString(),
            color: 'text-primary', bg: 'bg-primary/10',
          },
          {
            icon: Activity, label: t('logs.dashboard.last24h'),
            value: statsLoading ? '…' : (stats?.last24hCount ?? 0).toLocaleString(),
            color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/30',
          },
          {
            icon: Shield, label: t('logs.dashboard.last7d'),
            value: statsLoading ? '…' : (stats?.last7dCount ?? 0).toLocaleString(),
            color: 'text-amber-600', bg: 'bg-amber-100 dark:bg-amber-900/30',
          },
          {
            icon: Users, label: t('logs.dashboard.topModules'),
            value: statsLoading ? '…' : (stats?.byEntity?.length ?? 0).toLocaleString(),
            color: 'text-violet-600', bg: 'bg-violet-100 dark:bg-violet-900/30',
          },
        ].map(({ icon: Icon, label, value, color, bg }) => (
          <Card key={label}>
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg ${bg} flex items-center justify-center`}>
                  <Icon className={`w-5 h-5 ${color}`} />
                </div>
                <div>
                  <p className="text-xl font-semibold">{value}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Top entities breakdown */}
      {stats?.byEntity?.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">{t('logs.dashboard.activityByModule')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {stats.byEntity.slice(0, 6).map((row: any) => (
                  <div key={row.entity} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{row.entity}</span>
                    <Badge variant="outline">{row._count.id.toLocaleString()}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">{t('logs.dashboard.activityByAction')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {stats.byAction.slice(0, 6).map((row: any) => (
                  <div key={row.action} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{row.action}</span>
                    <Badge variant="outline">{row._count.id.toLocaleString()}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={t('logs.dashboard.searchPh')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="ps-9"
              />
            </div>
            {tenant.isPlatformSuper && (
              <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
            )}
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger><SelectValue placeholder={t('logs.dashboard.dateRange')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('logs.dashboard.allTime')}</SelectItem>
                <SelectItem value="today">{t('logs.dashboard.today')}</SelectItem>
                <SelectItem value="week">{t('logs.dashboard.last7Days')}</SelectItem>
                <SelectItem value="month">{t('logs.dashboard.last30Days')}</SelectItem>
                <SelectItem value="quarter">{t('logs.dashboard.last90Days')}</SelectItem>
                <SelectItem value="custom">{t('logs.dashboard.customRange')}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={entityFilter} onValueChange={setEntityFilter}>
              <SelectTrigger><SelectValue placeholder={t('logs.dashboard.moduleEntity')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('logs.dashboard.allModules')}</SelectItem>
                {knownEntities.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger><SelectValue placeholder={t('logs.dashboard.action')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('logs.dashboard.allActions')}</SelectItem>
                <SelectItem value="CREATE">{t('logs.dashboard.create')}</SelectItem>
                <SelectItem value="UPDATE">{t('logs.dashboard.update')}</SelectItem>
                <SelectItem value="DELETE">{t('logs.dashboard.delete')}</SelectItem>
                <SelectItem value="LOGIN">{t('logs.dashboard.login')}</SelectItem>
                <SelectItem value="LOGOUT">{t('logs.dashboard.logout')}</SelectItem>
                <SelectItem value="LOGIN_FAILED">{t('logs.dashboard.loginFailed')}</SelectItem>
                <SelectItem value="UPLOAD">{t('logs.dashboard.upload')}</SelectItem>
                <SelectItem value="VERIFY">{t('logs.dashboard.verify')}</SelectItem>
                <SelectItem value="CHANGE_PASSWORD">{t('logs.dashboard.changePassword')}</SelectItem>
                <SelectItem value="STAGE_CHANGE">{t('logs.dashboard.stageChange')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Custom date range inputs – only when 'custom' is selected */}
          {dateRange === 'custom' && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{t('logs.dashboard.customFrom')}</span>
              <DateInput value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="w-40" />
              <span className="text-xs text-muted-foreground">{t('logs.dashboard.customTo')}</span>
              <DateInput value={customTo} onChange={e => setCustomTo(e.target.value)} className="w-40" />
            </div>
          )}

          {/* Extra client-side filters */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder={t('logs.dashboard.userContains')}
              value={userFilter}
              onChange={e => setUserFilter(e.target.value)}
              className="w-64"
            />
            <Input
              placeholder={t('logs.dashboard.ipContains')}
              value={ipFilter}
              onChange={e => setIpFilter(e.target.value)}
              className="w-48"
            />
            <Input
              placeholder={t('logs.dashboard.entityIdContains')}
              value={entityIdFilter}
              onChange={e => setEntityIdFilter(e.target.value)}
              className="w-56"
            />
            {hasExtraFilters && (
              <Button variant="ghost" size="sm" onClick={clearExtraFilters}>
                <X className="w-3 h-3 me-1" />{t('logs.dashboard.clearExtras')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            {t('logs.dashboard.activityLogs')}
            <span className="ms-2 text-sm font-normal text-muted-foreground">
              {loading ? t('logs.dashboard.loading') : t('logs.dashboard.entries', { count: total })}
            </span>
          </CardTitle>
          {totalPages > 1 && (
            <div className="flex items-center gap-2 text-sm">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="text-muted-foreground">{t('logs.dashboard.pageOf', { page, totalPages })}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-t overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  {col('timestamp') && <SortableHead label={t('logs.list.cols.timestamp')} field="timestamp" />}
                  {col('user')      && <SortableHead label={t('logs.list.cols.user')}      field="user" />}
                  {col('userEmail') && <SortableHead label={t('logs.list.cols.userEmail')} field="userEmail" />}
                  {col('action')    && <SortableHead label={t('logs.list.cols.action')}    field="action" />}
                  {col('entity')    && <SortableHead label={t('logs.list.cols.entity')}    field="entity" />}
                  {col('entityId')  && <SortableHead label={t('logs.list.cols.entityId')}  field="entityId" />}
                  {col('tenant')    && (
                    <th className="text-start px-4 py-3 font-medium text-muted-foreground">
                      {t('logs.list.cols.tenant', { defaultValue: 'Tenant' })}
                    </th>
                  )}
                  {col('changes')   && <SortableHead label={t('logs.list.cols.changes')}   field="changes" />}
                  {col('ipAddress') && <SortableHead label={t('logs.list.cols.ipAddress')} field="ipAddress" />}
                  {col('userAgent') && <SortableHead label={t('logs.list.cols.userAgent')} field="userAgent" />}
                </tr>
              </thead>
              <tbody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b">
                      {Array.from({ length: visibleCount }).map((_, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 rounded bg-muted animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : displayLogs.length === 0 ? (
                  <tr>
                    <td colSpan={visibleCount} className="px-4 py-12 text-center text-muted-foreground">
                      {t('logs.dashboard.noEntriesFound')}
                    </td>
                  </tr>
                ) : (
                  displayLogs.map(log => {
                    const userName = log.user
                      ? `${log.user.firstName ?? ''} ${log.user.lastName ?? ''}`.trim()
                      : log.userEmail ?? '—';
                    const changesStr = log.changes
                      ? JSON.stringify(log.changes).slice(0, 80) + (JSON.stringify(log.changes).length > 80 ? '…' : '')
                      : '—';
                    return (
                      <tr key={log.id} className="border-b hover:bg-muted/30 transition-colors">
                        {col('timestamp') && (
                          <td className="px-4 py-3 tabular-nums text-muted-foreground whitespace-nowrap">
                            {formatDate(log.createdAt)}
                          </td>
                        )}
                        {col('user') && (
                          <td className="px-4 py-3">
                            <p className="font-medium">{userName}</p>
                            {log.user?.email && log.user.email !== userName && (
                              <p className="text-xs text-muted-foreground">{log.user.email}</p>
                            )}
                          </td>
                        )}
                        {col('userEmail') && (
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {log.user?.email ?? log.userEmail ?? '—'}
                          </td>
                        )}
                        {col('action')   && <td className="px-4 py-3">{getActionBadge(log.action)}</td>}
                        {col('entity')   && <td className="px-4 py-3"><Badge variant="outline">{log.entity}</Badge></td>}
                        {col('entityId') && (
                          <td className="px-4 py-3">
                            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                              {log.entityId ? `${log.entityId.slice(0, 12)}…` : '—'}
                            </code>
                          </td>
                        )}
                        {col('tenant') && (
                          <td className="px-4 py-3 text-sm">
                            {log.tenantId
                              ? (tenant.tenantNameById[log.tenantId] ?? log.tenantId.slice(0, 8) + '…')
                              : <span className="text-muted-foreground italic">{t('logs.list.cols.tenantNone', { defaultValue: '—' })}</span>}
                          </td>
                        )}
                        {col('changes') && (
                          <td className="px-4 py-3 text-xs text-muted-foreground max-w-[200px] truncate" title={JSON.stringify(log.changes)}>
                            {changesStr}
                          </td>
                        )}
                        {col('ipAddress') && (
                          <td className="px-4 py-3 text-muted-foreground">{log.ipAddress ?? '—'}</td>
                        )}
                        {col('userAgent') && (
                          <td className="px-4 py-3 text-xs text-muted-foreground max-w-[220px] truncate" title={log.userAgent}>
                            {log.userAgent ?? '—'}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* CET note (Phase 1 #21) */}
          <p className="px-4 py-2 text-xs text-muted-foreground border-t">
            {t('logs.dashboard.cetNote', { defaultValue: 'All times are shown in Central European Time (CET/CEST).' })}
          </p>

          {/* Bottom pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-sm text-muted-foreground">
                {t('logs.dashboard.showingRange', { from: (page - 1) * limit + 1, to: Math.min(page * limit, total), total })}
              </p>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(1)}>{t('logs.dashboard.first')}</Button>
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>{t('logs.dashboard.last')}</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Clear Logs Dialog – System Admin only */}
      {isAdmin && (
        <Dialog open={clearOpen} onOpenChange={setClearOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('logs.dashboard.clearLogsTitle')}</DialogTitle>
              <DialogDescription>
                {t('logs.dashboard.clearLogsBody')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                <AlertTriangle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
                <p className="text-sm text-destructive">{t('logs.dashboard.irreversible')}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="clearFrom">{t('logs.dashboard.fromDate')}</Label>
                  <DateInput id="clearFrom" value={clearFrom} onChange={e => setClearFrom(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="clearTo">{t('logs.dashboard.toDate')}</Label>
                  <DateInput id="clearTo" value={clearTo} onChange={e => setClearTo(e.target.value)} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="clearEntity">{t('logs.dashboard.moduleEntity')}</Label>
                <Select value={clearEntity || 'all'} onValueChange={v => setClearEntity(v === 'all' ? '' : v)}>
                  <SelectTrigger id="clearEntity"><SelectValue placeholder={t('logs.dashboard.allModulesPh')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('logs.dashboard.allModulesPh')}</SelectItem>
                    {knownEntities.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <p className="text-xs text-muted-foreground">
                {!clearFrom && !clearTo && !clearEntity
                  ? t('logs.dashboard.clearLogsAllSummary')
                  : t('logs.dashboard.clearLogsFilteredSummary')}
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setClearOpen(false)} disabled={clearing}>
                {t('logs.dashboard.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={handleClearLogs}
                disabled={clearing}
              >
                {clearing ? t('logs.dashboard.deleting') : t('logs.dashboard.deleteLogs')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
