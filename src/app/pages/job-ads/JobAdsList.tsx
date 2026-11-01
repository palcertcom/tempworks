import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, Link } from 'react-router';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { useTranslation } from 'react-i18next';
import {
  Plus, Search, ExternalLink, Edit2, Trash2,
  MapPin, Eye, Archive,
  ChevronLeft, ChevronRight,
  ArrowUp, ArrowDown, ArrowUpDown, Columns2, Check, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { jobAdsApi, settingsApi, getCurrentUser } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { Card, CardContent } from '../../components/ui/card';
import { formatDate } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';

const STATUS_COLORS: Record<string, string> = {
  DRAFT:     'bg-gray-100 text-gray-700',
  PUBLISHED: 'bg-emerald-100 text-emerald-700',
  ARCHIVED:  'bg-orange-100 text-orange-700',
};

const WRITE_ROLES = ['System Admin', 'HR Manager', 'Recruiter'];

// ── Column visibility ──────────────────────────────────────────────────────
type ColKey =
  | 'title' | 'tenant' | 'category' | 'city' | 'country' | 'contractType'
  | 'status' | 'applicants' | 'createdAt' | 'updatedAt' | 'slug';

const ALL_COLUMNS: { key: ColKey; labelKey: string }[] = [
  { key: 'title',        labelKey: 'jobAds.list.cols.title' },
  { key: 'tenant',       labelKey: 'jobAds.list.cols.tenant' },
  { key: 'category',     labelKey: 'jobAds.list.cols.category' },
  { key: 'city',         labelKey: 'jobAds.list.cols.city' },
  { key: 'country',      labelKey: 'jobAds.list.cols.country' },
  { key: 'contractType', labelKey: 'jobAds.list.cols.contractType' },
  { key: 'status',       labelKey: 'jobAds.list.cols.status' },
  { key: 'applicants',   labelKey: 'jobAds.list.cols.applicants' },
  { key: 'createdAt',    labelKey: 'jobAds.list.cols.createdAt' },
  { key: 'updatedAt',    labelKey: 'jobAds.list.cols.updatedAt' },
  { key: 'slug',         labelKey: 'jobAds.list.cols.slug' },
];

const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  title: true, tenant: true, category: true, city: true, country: true, contractType: true,
  status: true, applicants: true, createdAt: true,
  updatedAt: false, slug: false,
};

const STORAGE_KEY = 'job-ads-table-columns';

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...DEFAULT_VISIBLE, ...JSON.parse(saved) } : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

// ── Sorting ─────────────────────────────────────────────────────────────────
type SortField = ColKey;
type SortOrder = 'asc' | 'desc';

export function JobAdsList() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const tenantVersion = useTenantSyncVersion();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenant = useSuperUserTenantFilter();
  const currentUser = getCurrentUser();
  const canWrite = WRITE_ROLES.includes(currentUser?.role ?? '');
  // Phase 3.18 — only PlatformAdmin viewers see the Tenant column.
  // Other viewers are already scoped to one tenant on the backend.
  const isPlatformAdminViewer =
    !!currentUser?.agencyIsSystem || currentUser?.platformAdmin?.level === 'SUPER';
  // Resolve the current tenant slug so View Public Page points to the
  // tenant-scoped /t/<slug>/jobs URL instead of the global /jobs board
  // (which now only lists tenant-less ads). PlatformAdmin viewers
  // fall through to the global /jobs link.
  const activeTenantId = currentUser?.activeTenantId ?? currentUser?.primaryTenantId ?? null;
  const activeTenantSlug = activeTenantId
    ? currentUser?.memberships?.find((m) => m.tenantId === activeTenantId)?.slug ?? null
    : null;
  const publicJobsHref = activeTenantSlug
    ? `/t/${encodeURIComponent(activeTenantSlug)}/jobs`
    : '/jobs';

  const [ads, setAds] = useState<any[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, totalPages: 1 });
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch]                 = useState('');
  const [statusFilter, setStatusFilter]     = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [countryFilter, setCountryFilter]   = useState('');
  const [cityFilter, setCityFilter]         = useState('');
  const [contractFilter, setContractFilter] = useState('');
  const [minApplicants, setMinApplicants]   = useState('');
  const [dateFrom, setDateFrom]             = useState('');
  const [dateTo, setDateTo]                 = useState('');

  const [categories, setCategories]     = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const limit = 20;

  // Sort state
  const [sortBy, setSortBy]       = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const handleSort = (f: SortField) => {
    if (sortBy === f) setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSortBy(f); setSortOrder('asc'); }
  };

  // Column visibility
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

  const col = (key: ColKey) => visibleColumns[key];
  const hiddenCount  = ALL_COLUMNS.filter(c => !visibleColumns[c.key]).length;
  const visibleCount = ALL_COLUMNS.filter(c =>  visibleColumns[c.key]).length;

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const res = await jobAdsApi.list(tenant.applyToParams({
        page: p, limit,
        ...(search       ? { search }        : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(categoryFilter ? { category: categoryFilter } : {}),
        ...(countryFilter  ? { country: countryFilter }   : {}),
      })) as any;
      setAds(res.data ?? []);
      setMeta(res.meta ?? { total: 0, page: 1, limit, totalPages: 1 });
    } catch {
      toast.error(t('jobAds.list.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, categoryFilter, countryFilter, t, tenantVersion, tenant.tenantFilter]);

  useEffect(() => {
    settingsApi.getJobTypes()
      .then((types: any[]) => setCategories(types.filter((t: any) => t.isActive).map((t: any) => t.name)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
    load(1);
    // tenant.tenantFilter + tenantVersion are required here so picking
    // a different tenant in the toolbar actually re-fires the list
    // query. Without them the SUPER per-page filter changed the
    // applyToParams payload on the NEXT call only — and there was no
    // next call until another filter changed.
  }, [search, statusFilter, categoryFilter, countryFilter, tenant.tenantFilter, tenantVersion]);

  const handlePage = (p: number) => {
    setPage(p);
    load(p);
  };

  const handleDelete = async (id: string, title: string) => {
    if (!(await confirm({
      title: t('jobAds.list.deleteTitle'),
      description: t('jobAds.list.deleteBody', { title }),
      confirmText: tc('actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await jobAdsApi.delete(id);
      toast.success(t('jobAds.list.deleteSuccess'));
      load(page);
    } catch (err: any) {
      toast.error(apiError(err, t('jobAds.list.deleteFailed')));
    }
  };

  const handleQuickStatus = async (id: string, newStatus: string) => {
    try {
      await jobAdsApi.update(id, { status: newStatus });
      toast.success(t('jobAds.list.statusMoved', { status: newStatus }));
      load(page);
    } catch (err: any) {
      toast.error(apiError(err, t('jobAds.list.statusFailed')));
    }
  };

  const countryOptions  = useMemo(() => Array.from(new Set(ads.map(a => a.country).filter(Boolean))).sort() as string[], [ads]);
  const contractOptions = useMemo(() => Array.from(new Set(ads.map(a => a.contractType).filter(Boolean))).sort() as string[], [ads]);

  const displayAds = useMemo(() => {
    let data = ads;
    if (cityFilter) {
      const q = cityFilter.toLowerCase();
      data = data.filter(a => (a.city ?? '').toLowerCase().includes(q));
    }
    if (contractFilter) data = data.filter(a => a.contractType === contractFilter);
    if (minApplicants) {
      const n = Number(minApplicants);
      data = data.filter(a => (a._count?.applicants ?? 0) >= n);
    }
    if (dateFrom || dateTo) {
      const from = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
      const to   = dateTo   ? new Date(dateTo + 'T23:59:59').getTime() : Infinity;
      data = data.filter(a => {
        const t = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        return t >= from && t <= to;
      });
    }
    return [...data].sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortBy) {
        case 'title':        aVal = (a.title ?? '').toLowerCase();        bVal = (b.title ?? '').toLowerCase(); break;
        case 'category':     aVal = (a.category ?? '').toLowerCase();     bVal = (b.category ?? '').toLowerCase(); break;
        case 'city':         aVal = (a.city ?? '').toLowerCase();         bVal = (b.city ?? '').toLowerCase(); break;
        case 'country':      aVal = (a.country ?? '').toLowerCase();      bVal = (b.country ?? '').toLowerCase(); break;
        case 'contractType': aVal = (a.contractType ?? '').toLowerCase(); bVal = (b.contractType ?? '').toLowerCase(); break;
        case 'status':       aVal = a.status ?? '';                        bVal = b.status ?? ''; break;
        case 'applicants':   aVal = a._count?.applicants ?? 0;             bVal = b._count?.applicants ?? 0; break;
        case 'createdAt':    aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                             bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0; break;
        case 'updatedAt':    aVal = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                             bVal = b.updatedAt ? new Date(b.updatedAt).getTime() : 0; break;
        case 'slug':         aVal = (a.slug ?? '').toLowerCase();         bVal = (b.slug ?? '').toLowerCase(); break;
        default:             aVal = ''; bVal = '';
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [ads, cityFilter, contractFilter, minApplicants, dateFrom, dateTo, sortBy, sortOrder]);

  const hasServerFilters = !!(search || statusFilter || categoryFilter || countryFilter);
  const hasExtraFilters  = !!(cityFilter || contractFilter || minApplicants || dateFrom || dateTo);
  const hasAnyFilters    = hasServerFilters || hasExtraFilters;

  const clearAllFilters = () => {
    setSearch(''); setStatusFilter(''); setCategoryFilter(''); setCountryFilter('');
    setCityFilter(''); setContractFilter(''); setMinApplicants('');
    setDateFrom(''); setDateTo('');
  };

  const SortableHead = ({ label, field, className }: { label: string; field: SortField; className?: string }) => {
    const active = sortBy === field;
    return (
      <th className={`px-4 py-3 text-start font-medium text-muted-foreground ${className ?? ''}`}>
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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('jobAds.list.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('jobAds.list.subtitle')}
          </p>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <Link to={publicJobsHref} target="_blank">
              <Button variant="outline" size="sm" className="gap-2">
                <ExternalLink className="w-4 h-4" /> {t('jobAds.list.viewPublicPage')}
              </Button>
            </Link>
            <Button onClick={() => navigate('/dashboard/job-ads/new')} className="gap-2">
              <Plus className="w-4 h-4" /> {t('jobAds.list.addButton')}
            </Button>
          </div>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex-1 min-w-[200px] relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={t('jobAds.list.searchPh')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="ps-9"
              />
            </div>
            {tenant.isPlatformSuper && (
              <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
            )}
            <Select
              value={statusFilter || '__all__'}
              onValueChange={v => setStatusFilter(v === '__all__' ? '' : v)}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder={t('jobAds.list.allStatuses')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('jobAds.list.allStatuses')}</SelectItem>
                <SelectItem value="DRAFT">{t('jobAds.list.draft')}</SelectItem>
                <SelectItem value="PUBLISHED">{t('jobAds.list.published')}</SelectItem>
                <SelectItem value="ARCHIVED">{t('jobAds.list.archived')}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={categoryFilter || '__all__'}
              onValueChange={v => setCategoryFilter(v === '__all__' ? '' : v)}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder={t('jobAds.list.allCategories')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('jobAds.list.allCategories')}</SelectItem>
                {categories.map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={countryFilter || '__all__'}
              onValueChange={v => setCountryFilter(v === '__all__' ? '' : v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder={t('jobAds.list.allCountries')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('jobAds.list.allCountries')}</SelectItem>
                {countryOptions.map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Input
              placeholder={t('jobAds.list.cityContains')}
              value={cityFilter}
              onChange={e => setCityFilter(e.target.value)}
              className="w-44"
            />
            <Select
              value={contractFilter || '__all__'}
              onValueChange={v => setContractFilter(v === '__all__' ? '' : v)}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder={t('jobAds.list.allContracts')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('jobAds.list.allContracts')}</SelectItem>
                {contractOptions.map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              placeholder={t('jobAds.list.minApplicants')}
              value={minApplicants}
              onChange={e => setMinApplicants(e.target.value)}
              className="w-36"
            />
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{t('jobAds.list.createdFrom')}</span>
              <DateInput value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36" />
              <span className="text-xs text-muted-foreground">{t('jobAds.list.createdTo')}</span>
              <DateInput value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36" />
            </div>
            {hasAnyFilters && (
              <Button variant="ghost" size="sm" onClick={clearAllFilters}>
                <X className="w-3 h-3 me-1" />{t('jobAds.list.clearFilters')}
              </Button>
            )}

            {/* Column picker */}
            <div className="relative ms-auto" ref={colPickerRef}>
              <Button
                variant="outline" size="sm"
                onClick={() => setShowColPicker(v => !v)}
                className={showColPicker ? 'border-primary text-primary' : ''}
              >
                <Columns2 className="w-4 h-4 me-1.5" />{t('jobAds.list.columns')}
                {hiddenCount > 0 && (
                  <span className="ms-1.5 bg-primary text-primary-foreground text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                    {hiddenCount}
                  </span>
                )}
              </Button>
              {showColPicker && (
                <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[200px]">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{t('jobAds.list.toggleColumns')}</p>
                  <div className="space-y-0.5 max-h-72 overflow-y-auto">
                    {ALL_COLUMNS.filter(c => c.key !== 'tenant' || isPlatformAdminViewer).map(c => (
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
                    >{t('jobAds.list.showAll')}</button>
                    <span className="text-gray-300">|</span>
                    <button
                      onClick={() => {
                        setVisibleColumns(DEFAULT_VISIBLE);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_VISIBLE));
                      }}
                      className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5"
                    >{t('jobAds.list.reset')}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              {col('title')        && <SortableHead label={t('jobAds.list.cols.title')}        field="title" />}
              {isPlatformAdminViewer && col('tenant') && (
                <th className="px-4 py-3 text-start font-medium text-muted-foreground">
                  {t('jobAds.list.cols.tenant', { defaultValue: 'Tenant' })}
                </th>
              )}
              {col('category')     && <SortableHead label={t('jobAds.list.cols.category')}     field="category" />}
              {col('city')         && <SortableHead label={t('jobAds.list.cols.city')}         field="city" />}
              {col('country')      && <SortableHead label={t('jobAds.list.cols.country')}      field="country" />}
              {col('contractType') && <SortableHead label={t('jobAds.list.cols.contractType')} field="contractType" />}
              {col('status')       && <SortableHead label={t('jobAds.list.cols.status')}       field="status" />}
              {col('applicants')   && <SortableHead label={t('jobAds.list.cols.applicants')}   field="applicants" />}
              {col('createdAt')    && <SortableHead label={t('jobAds.list.cols.createdAt')}    field="createdAt" />}
              {col('updatedAt')    && <SortableHead label={t('jobAds.list.cols.updatedAt')}    field="updatedAt" />}
              {col('slug')         && <SortableHead label={t('jobAds.list.cols.slug')}         field="slug" />}
              <th className="px-4 py-3 text-end font-medium text-muted-foreground">{t('jobAds.list.actionsHeader')}</th>
            </tr>
          </thead>
          <tbody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
            {loading ? (
              <tr>
                <td colSpan={visibleCount + 1} className="px-4 py-8 text-center text-muted-foreground">
                  {t('jobAds.list.loading')}
                </td>
              </tr>
            ) : displayAds.length === 0 ? (
              <tr>
                <td colSpan={visibleCount + 1} className="px-4 py-8 text-center text-muted-foreground">
                  {t('jobAds.list.emptyShort')}{' '}
                  {canWrite && (
                    <button
                      onClick={() => navigate('/dashboard/job-ads/new')}
                      className="text-primary underline"
                    >
                      {t('jobAds.list.createFirst')}
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              displayAds.map(ad => (
                <tr key={ad.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  {col('title') && (
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground line-clamp-1">{ad.title}</div>
                      <div className="text-xs text-muted-foreground">/{ad.slug}</div>
                    </td>
                  )}
                  {isPlatformAdminViewer && col('tenant') && (
                    <td className="px-4 py-3 text-sm">
                      {ad.tenant ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="font-medium">{ad.tenant.name}</span>
                          <span className="text-muted-foreground text-xs font-mono">/{ad.tenant.slug}</span>
                        </span>
                      ) : <span className="text-muted-foreground italic text-xs">no tenant</span>}
                    </td>
                  )}
                  {col('category')     && <td className="px-4 py-3 text-muted-foreground">{ad.category ?? '—'}</td>}
                  {col('city')         && <td className="px-4 py-3 text-muted-foreground text-xs">
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {ad.city ?? '—'}
                    </span>
                  </td>}
                  {col('country')      && <td className="px-4 py-3 text-muted-foreground text-xs">{ad.country ?? '—'}</td>}
                  {col('contractType') && <td className="px-4 py-3 text-muted-foreground text-xs">{ad.contractType ?? '—'}</td>}
                  {col('status') && (
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[ad.status] ?? ''}`}>
                        {ad.status === 'DRAFT' ? t('jobAds.list.draft')
                          : ad.status === 'PUBLISHED' ? t('jobAds.list.published')
                          : ad.status === 'ARCHIVED' ? t('jobAds.list.archived')
                          : ad.status}
                      </span>
                    </td>
                  )}
                  {col('applicants')   && <td className="px-4 py-3 text-muted-foreground text-center">{ad._count?.applicants ?? 0}</td>}
                  {col('createdAt')    && <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">{ad.createdAt ? formatDate(ad.createdAt) : '—'}</td>}
                  {col('updatedAt')    && <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">{ad.updatedAt ? formatDate(ad.updatedAt) : '—'}</td>}
                  {col('slug')         && <td className="px-4 py-3 text-muted-foreground text-xs font-mono">{ad.slug ?? '—'}</td>}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {canWrite && ad.status === 'DRAFT' && (
                        <button
                          onClick={() => handleQuickStatus(ad.id, 'PUBLISHED')}
                          title={t('jobAds.list.publish')}
                          className="p-1.5 rounded hover:bg-emerald-50 text-emerald-600 transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      )}
                      {canWrite && ad.status === 'PUBLISHED' && (
                        <button
                          onClick={() => handleQuickStatus(ad.id, 'ARCHIVED')}
                          title={t('jobAds.list.archive')}
                          className="p-1.5 rounded hover:bg-orange-50 text-orange-500 transition-colors"
                        >
                          <Archive className="w-4 h-4" />
                        </button>
                      )}
                      {canWrite && (
                        <button
                          onClick={() => navigate(`/dashboard/job-ads/${ad.id}/edit`)}
                          title={t('jobAds.list.edit')}
                          className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      )}
                      {canWrite && (
                        <button
                          onClick={() => handleDelete(ad.id, ad.title)}
                          title={t('jobAds.list.delete')}
                          className="p-1.5 rounded hover:bg-red-50 text-red-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {meta.total > 0 && (
            <tfoot>
              <tr className="border-t bg-muted/20">
                <td colSpan={visibleCount + 1} className="px-4 py-3">
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      {t('jobAds.list.footerCount', { count: meta.total })}
                      {' · '}{t('jobAds.list.footerPage', { page: meta.page, totalPages: meta.totalPages })}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost" size="sm"
                        disabled={page <= 1}
                        onClick={() => handlePage(page - 1)}
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        disabled={page >= meta.totalPages}
                        onClick={() => handlePage(page + 1)}
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
