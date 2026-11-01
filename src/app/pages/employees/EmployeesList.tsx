import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useColumnWidths, ResizeHandle } from '../../hooks/useColumnWidths';

const EMPLOYEES_COL_DEFAULTS = {
  select: 40, employee: 220, tenant: 140, contact: 220, nationality: 130,
  license: 150, experience: 110, agency: 160, birthDate: 110, age: 80,
  status: 120, createdAt: 110, actions: 220,
};
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Download, Eye, Edit, Trash2, RefreshCw, ArrowUp, ArrowDown, ArrowUpDown, X, Columns2, Check, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { exportRecordsAsPdfZip, safeFilename } from '../../utils/bulkPdfExport';
import { buildEmployeePdfBlob } from '../../components/employees/EmployeePdfDocument';
import { WhatsAppButton } from '../../components/WhatsAppButton';
import { formatPhoneDisplay } from '../../data/phoneCodes';
import { formatDate } from '../../../i18n/formatters';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { employeesApi, agenciesApi, getAccessToken, documentsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { DateInput } from '../../components/ui/date-input';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';

const STATUSES = ['ACTIVE', 'PENDING', 'ONBOARDING', 'INACTIVE', 'SUSPENDED', 'ON_LEAVE'];

const getStatusColor = (status: string) => {
  switch (status?.toUpperCase()) {
    case 'ACTIVE':     return 'bg-green-500 text-white';
    case 'PENDING':    return 'bg-amber-500 text-white';
    case 'ONBOARDING': return 'bg-blue-600 text-white';
    case 'ON_LEAVE':   return 'bg-purple-500 text-white';
    default:           return 'bg-gray-500 text-white';
  }
};

type SortField = 'firstName' | 'email' | 'nationality' | 'licenseNumber' | 'yearsExperience' | 'agency' | 'status' | 'createdAt' | 'tenant' | 'birthDate' | 'age';
type SortOrder = 'asc' | 'desc';

// ── Column visibility ────────────────────────────────────────────────────────
type ColKey = 'contact' | 'nationality' | 'license' | 'experience' | 'agency' | 'birthDate' | 'age' | 'status' | 'createdAt';

const ALL_COLUMNS: { key: ColKey; labelKey: string; defaultLabel?: string }[] = [
  { key: 'contact',     labelKey: 'employees.list.cols.contact' },
  { key: 'nationality', labelKey: 'employees.list.cols.nationality' },
  { key: 'license',     labelKey: 'employees.list.cols.license' },
  { key: 'experience',  labelKey: 'employees.list.cols.experience' },
  { key: 'agency',      labelKey: 'employees.list.cols.agency' },
  { key: 'birthDate',   labelKey: 'employees.list.cols.birthDate' },
  { key: 'age',         labelKey: 'employees.list.cols.age' },
  { key: 'status',      labelKey: 'employees.list.cols.status' },
  { key: 'createdAt',   labelKey: 'employees.list.cols.createdAt', defaultLabel: 'Created' },
];

const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  contact: true, nationality: true, license: true,
  experience: true, agency: true, birthDate: false, age: false, status: true, createdAt: true,
};

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const saved = localStorage.getItem('employees-table-columns');
    return saved ? { ...DEFAULT_VISIBLE, ...JSON.parse(saved) } : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

// ── Sortable header ──────────────────────────────────────────────────────────
function SortableHead({ label, field, sortBy, sortOrder, onSort, colKey, style, startResize }: {
  label: string; field: SortField; sortBy: SortField; sortOrder: SortOrder; onSort: (f: SortField) => void;
  colKey?: string; style?: React.CSSProperties; startResize?: (k: string, e: React.MouseEvent) => void;
}) {
  const active = sortBy === field;
  return (
    <TableHead className="relative whitespace-normal align-top" style={style}>
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

export function EmployeesList() {
  const { canCreate, canEdit, canDelete } = usePermissions();
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { t: tEnums } = useTranslation('enums');

  // ── Column visibility ──────────────────────────────────────────────────────
  const [visibleColumns, setVisibleColumns] = useState<Record<ColKey, boolean>>(loadVisibleColumns);
  const { headStyle, startResize } = useColumnWidths('employees-col-widths-v1', EMPLOYEES_COL_DEFAULTS);
  const [showColPicker, setShowColPicker] = useState(false);
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
      localStorage.setItem('employees-table-columns', JSON.stringify(next));
      return next;
    });
  };

  const col = (key: ColKey) => visibleColumns[key];

  // ── Filters ────────────────────────────────────────────────────────────────
  // Read initial status from URL (?status=ACTIVE) so KPI-card deep
  // links from the Dashboard land with the filter applied.
  const [searchParams] = useSearchParams();
  const initialStatus = (searchParams.get('status') ?? '').trim().toUpperCase();
  const [searchTerm, setSearchTerm]               = useState('');
  const [statusFilter, setStatusFilter]           = useState(initialStatus);
  const [agencyFilter, setAgencyFilter]           = useState('');
  const [nationalityFilter, setNationalityFilter] = useState('');
  const [dateFrom, setDateFrom]                   = useState('');
  const [dateTo, setDateTo]                       = useState('');
  const tenant = useSuperUserTenantFilter();
  const tenantVersion = useTenantSyncVersion();

  // ── Sorting (client-side) ──────────────────────────────────────────────────
  const [sortBy, setSortBy]       = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const handleSort = (field: SortField) => {
    if (sortBy === field) setSortOrder(o => (o === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortOrder('asc'); }
  };

  // ── Data ───────────────────────────────────────────────────────────────────
  const [employees, setEmployees] = useState<any[]>([]);
  const [totalEmployees, setTotalEmployees] = useState(0);
  const [loading, setLoading] = useState(true);
  const [agencies, setAgencies] = useState<any[]>([]);

  // Row selection for 'Export Selected'
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = { page: 1, limit: 500 };
      if (searchTerm)       params.search    = searchTerm;
      if (statusFilter)     params.status    = statusFilter;
      if (agencyFilter)     params.agencyId  = agencyFilter;
      if (nationalityFilter) params.nationality = nationalityFilter;
      tenant.applyToParams(params);
      const result = await employeesApi.list(params);
      setEmployees(result.data || []);
      setTotalEmployees(result.meta?.total || 0);
    } catch {
      setEmployees([]);
    } finally {
      setLoading(false);
    }
  }, [searchTerm, statusFilter, agencyFilter, nationalityFilter, tenant.tenantFilter, tenant.isPlatformSuper, tenantVersion]);

  useEffect(() => {
    const timer = setTimeout(fetchEmployees, 300);
    return () => clearTimeout(timer);
  }, [fetchEmployees]);

  useEffect(() => {
    agenciesApi.list({ limit: 200 }).then((r: any) => setAgencies(r?.data ?? [])).catch(() => {});
  }, []);

  // ── Sorted + date-filtered display data ───────────────────────────────────
  const displayData = useMemo(() => {
    let data = employees;
    if (dateFrom || dateTo) {
      const from = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
      const to   = dateTo   ? new Date(dateTo + 'T23:59:59').getTime() : Infinity;
      data = data.filter(e => {
        const t = e.createdAt ? new Date(e.createdAt).getTime() : 0;
        return t >= from && t <= to;
      });
    }
    return [...data].sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortBy) {
        case 'firstName':       aVal = `${a.firstName ?? ''} ${a.lastName ?? ''}`.toLowerCase(); bVal = `${b.firstName ?? ''} ${b.lastName ?? ''}`.toLowerCase(); break;
        case 'email':           aVal = a.email?.toLowerCase() ?? ''; bVal = b.email?.toLowerCase() ?? ''; break;
        case 'nationality':     aVal = a.nationality?.toLowerCase() ?? ''; bVal = b.nationality?.toLowerCase() ?? ''; break;
        case 'licenseNumber':   aVal = a.licenseNumber?.toLowerCase() ?? ''; bVal = b.licenseNumber?.toLowerCase() ?? ''; break;
        case 'yearsExperience': aVal = Number(a.yearsExperience ?? 0); bVal = Number(b.yearsExperience ?? 0); break;
        case 'agency':          aVal = (a.agency?.name ?? a.agencyName ?? '').toLowerCase(); bVal = (b.agency?.name ?? b.agencyName ?? '').toLowerCase(); break;
        case 'status':          aVal = a.status ?? ''; bVal = b.status ?? ''; break;
        case 'createdAt':       aVal = a.createdAt ?? ''; bVal = b.createdAt ?? ''; break;
        case 'tenant':          aVal = tenant.resolveTenantName(a).toLowerCase(); bVal = tenant.resolveTenantName(b).toLowerCase(); break;
        case 'birthDate':       aVal = a.dateOfBirth ?? ''; bVal = b.dateOfBirth ?? ''; break;
        case 'age': {
          const toAge = (dob: any): number => {
            if (!dob) return -1;
            const d = new Date(dob); if (Number.isNaN(d.getTime())) return -1;
            const now = new Date();
            let age = now.getUTCFullYear() - d.getUTCFullYear();
            const m = now.getUTCMonth() - d.getUTCMonth();
            if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
            return age >= 0 ? age : -1;
          };
          aVal = toAge(a.dateOfBirth); bVal = toAge(b.dateOfBirth); break;
        }
        default:                aVal = ''; bVal = '';
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, sortBy, sortOrder, dateFrom, dateTo, tenant.tenantNameById]);

  const nationalityOptions = useMemo(() => {
    const all = employees.map(e => e.nationality).filter(Boolean) as string[];
    return [...new Set(all)].sort();
  }, [employees]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = async (employee: any) => {
    if (!(await confirm({
      title: t('employees.list.deleteTitle'),
      description: t('employees.list.deleteBody', { name: `${employee.firstName} ${employee.lastName}` }),
      confirmText: tc('actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await employeesApi.delete(employee.id);
      setEmployees(prev => prev.filter(e => e.id !== employee.id));
      setTotalEmployees(prev => prev - 1);
      toast.success(t('employees.list.deleteSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('employees.list.deleteFailed')));
    }
  };

  // ── Bulk PDF Export ────────────────────────────────────────────────────────
  const [pdfExporting, setPdfExporting] = useState(false);
  const handleBulkPdfExport = async () => {
    if (selected.size === 0) {
      toast.error(t('employees.list.selectAtLeastOne'));
      return;
    }
    setPdfExporting(true);
    const tid = toast.loading(t('employees.list.preparingPdfs', { count: selected.size }));
    try {
      const ids = [...selected];
      const full = await Promise.all(ids.map(id => employeesApi.get(id).catch(() => null)));
      const records = full.filter(Boolean) as any[];
      if (records.length === 0) {
        toast.error(t('employees.list.loadSelectedFailed'), { id: tid });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      await exportRecordsAsPdfZip({
        records,
        zipName: `Employees_Profiles_${today}`,
        // Merge each employee's uploaded documents into their PDF so
        // the bulk ZIP includes the full dossier, not just the profile.
        buildBlob: async (rec) => {
          const docsRes: any = await documentsApi.getByEntity('EMPLOYEE', rec.id).catch(() => []);
          const docs = Array.isArray(docsRes) ? docsRes : Array.isArray(docsRes?.data) ? docsRes.data : [];
          return buildEmployeePdfBlob(rec, docs);
        },
        filename: (rec) => {
          const name = safeFilename([rec.firstName, rec.lastName].filter(Boolean).join('_') || 'Employee');
          const num = rec.employeeNumber || rec.id;
          return `Employee_${name}_${num}.pdf`;
        },
        onProgress: (done, total) => {
          toast.loading(t('employees.list.generatingPdfs', { done, total }), { id: tid });
        },
      });
      toast.success(t('employees.list.exportedCount', { count: records.length }), { id: tid });
    } catch (err: any) {
      toast.error(apiError(err, t('employees.list.pdfFailed')), { id: tid });
    } finally {
      setPdfExporting(false);
    }
  };

  // ── Excel Export ───────────────────────────────────────────────────────────
  // Backend streams the .xlsx (employees.service.exportExcel) so auth
  // and per-employee agency-access grants are enforced server-side.
  // Only the currently selected rows are exported; the toolbar button
  // stays disabled until at least one row is ticked.
  const handleExportExcel = () => {
    if (selected.size === 0) {
      toast.error(t('employees.list.selectToExport'));
      return;
    }
    const token = getAccessToken();
    const url = employeesApi.exportExcel({ ids: Array.from(selected) });
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `employees-selected-${Date.now()}.xlsx`;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(objectUrl);
      })
      .catch(() => toast.error(t('employees.list.exportFailed')));
  };

  // ── Filters ────────────────────────────────────────────────────────────────
  const hasActiveFilters = searchTerm || statusFilter || agencyFilter || nationalityFilter || dateFrom || dateTo;
  const clearFilters = () => { setSearchTerm(''); setStatusFilter(''); setAgencyFilter(''); setNationalityFilter(''); setDateFrom(''); setDateTo(''); };

  // ── Stats ──────────────────────────────────────────────────────────────────
  const activeCount     = employees.filter(e => e.status === 'ACTIVE').length;
  const onboardingCount = employees.filter(e => e.status === 'ONBOARDING').length;
  const pendingCount    = employees.filter(e => e.status === 'PENDING').length;

  // +1 for the select checkbox column we add at the far left.
  const colSpan = 3 + ALL_COLUMNS.filter(c => visibleColumns[c.key]).length + (tenant.isPlatformSuper ? 1 : 0);

  const visibleIds = displayData.map(e => e.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some(id => selected.has(id));
  const toggleSelectAllVisible = () => {
    setSelected(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visibleIds.forEach(id => next.delete(id));
        return next;
      }
      const next = new Set(prev);
      visibleIds.forEach(id => next.add(id));
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('employees.list.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('employees.list.subtitle')}</p>
        </div>
        {canCreate('employees') && (
          <Button asChild>
            <Link to="/dashboard/employees/add">
              <Plus className="w-4 h-4 me-2" />{t('employees.list.addButton')}
            </Link>
          </Button>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{t('employees.list.stats.total')}</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-[#0F172A]">{totalEmployees}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{t('employees.list.stats.active')}</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-green-600">{activeCount}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{t('employees.list.stats.onboarding')}</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-blue-600">{onboardingCount}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{t('employees.list.stats.pending')}</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-amber-600">{pendingCount}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-6">
          {/* Filter rows */}
          <div className="space-y-3 mb-6">
            {/* Row 1 */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-48 relative">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder={t('employees.list.search')} value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="ps-10" />
              </div>

              <Select value={statusFilter || '__all__'} onValueChange={v => setStatusFilter(v === '__all__' ? '' : v)}>
                <SelectTrigger className="w-40"><SelectValue placeholder={t('employees.list.filters.allStatuses')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('employees.list.filters.allStatuses')}</SelectItem>
                  {STATUSES.map(s => <SelectItem key={s} value={s}>{tEnums(`employeeStatus.${s}`, { defaultValue: s.replace(/_/g, ' ') })}</SelectItem>)}
                </SelectContent>
              </Select>

              {tenant.isPlatformSuper && (
                <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
              )}

              {agencies.length > 0 && (
                <Select value={agencyFilter || '__all__'} onValueChange={v => setAgencyFilter(v === '__all__' ? '' : v)}>
                  <SelectTrigger className="w-44"><SelectValue placeholder={t('employees.list.filters.allAgencies')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">{t('employees.list.filters.allAgencies')}</SelectItem>
                    {agencies.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}

              <Button variant="outline" size="sm" onClick={fetchEmployees} disabled={loading}>
                <RefreshCw className={`w-4 h-4 me-1 ${loading ? 'animate-spin' : ''}`} />{t('employees.list.refresh')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportExcel}
                disabled={selected.size === 0}
                title={selected.size === 0 ? t('employees.list.exportExcelTitle') : undefined}
              >
                <Download className="w-4 h-4 me-2" />{t('employees.list.exportToExcel')} ({selected.size})
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkPdfExport}
                disabled={selected.size === 0 || pdfExporting}
                title={selected.size === 0 ? t('employees.list.exportPdfsTitle') : undefined}
              >
                {pdfExporting
                  ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  : <FileText className="w-4 h-4 me-2" />}
                {t('employees.list.exportPdfs')} ({selected.size})
              </Button>

              {/* Column picker */}
              <div className="relative" ref={colPickerRef}>
                <Button
                  variant="outline" size="sm"
                  onClick={() => setShowColPicker(v => !v)}
                  className={showColPicker ? 'border-blue-500 text-blue-600' : ''}
                >
                  <Columns2 className="w-4 h-4 me-1.5" />{t('employees.list.columnsButton')}
                  {ALL_COLUMNS.filter(c => !visibleColumns[c.key]).length > 0 && (
                    <span className="ms-1.5 bg-blue-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                      {ALL_COLUMNS.filter(c => !visibleColumns[c.key]).length}
                    </span>
                  )}
                </Button>

                {showColPicker && (
                  <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[180px]">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{t('employees.list.toggleColumns')}</p>
                    <div className="space-y-0.5">
                      {ALL_COLUMNS.map(c => (
                        <button
                          key={c.key}
                          onClick={() => toggleColumn(c.key)}
                          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 text-sm text-start"
                        >
                          <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${visibleColumns[c.key] ? 'bg-blue-600 border-blue-600' : 'border-gray-300'}`}>
                            {visibleColumns[c.key] && <Check className="w-2.5 h-2.5 text-white" />}
                          </span>
                          {t(c.labelKey, { defaultValue: c.defaultLabel ?? c.labelKey })}
                        </button>
                      ))}
                    </div>
                    <div className="border-t mt-2 pt-2 flex gap-1.5">
                      <button onClick={() => { const all = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, true])) as Record<ColKey, boolean>; setVisibleColumns(all); localStorage.setItem('employees-table-columns', JSON.stringify(all)); }} className="flex-1 text-xs text-center text-blue-600 hover:underline py-0.5">{t('employees.list.showAll')}</button>
                      <span className="text-gray-300">|</span>
                      <button onClick={() => { const none = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, false])) as Record<ColKey, boolean>; setVisibleColumns(none); localStorage.setItem('employees-table-columns', JSON.stringify(none)); }} className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5">{t('employees.list.hideAll')}</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Row 2 */}
            <div className="flex flex-wrap items-center gap-3">
              <Select value={nationalityFilter || '__all__'} onValueChange={v => setNationalityFilter(v === '__all__' ? '' : v)}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t('employees.list.filters.allCitizenships')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('employees.list.filters.allCitizenships')}</SelectItem>
                  {nationalityOptions.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground whitespace-nowrap">{t('employees.list.filters.joinedFrom')}</span>
                <DateInput value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36 text-sm" />
                <span className="text-xs text-muted-foreground">{t('employees.list.filters.to')}</span>
                <DateInput value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36 text-sm" />
              </div>

              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5 me-1" />{t('employees.list.clearFilters')}
                </Button>
              )}
            </div>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" style={headStyle('select')}>
                    <Checkbox
                      checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                      onCheckedChange={toggleSelectAllVisible}
                      aria-label={t('employees.list.selectAllAria')}
                    />
                  </TableHead>
                  <SortableHead colKey="employee" style={headStyle('employee')} startResize={startResize} label={t('employees.list.tableHeaders.employee')}    field="firstName"       sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                  {tenant.isPlatformSuper && <SortableHead colKey="tenant" style={headStyle('tenant')} startResize={startResize} label={t('tenantFilter.tenant', { defaultValue: 'Tenant' })} field="tenant" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('contact')     && <SortableHead colKey="contact"     style={headStyle('contact')}     startResize={startResize} label={t('employees.list.tableHeaders.contact')}      field="email"           sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('nationality') && <SortableHead colKey="nationality" style={headStyle('nationality')} startResize={startResize} label={t('employees.list.tableHeaders.citizenship')}  field="nationality"     sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('license')     && <SortableHead colKey="license"     style={headStyle('license')}     startResize={startResize} label={t('employees.list.tableHeaders.license')}      field="licenseNumber"   sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('experience')  && <SortableHead colKey="experience"  style={headStyle('experience')}  startResize={startResize} label={t('employees.list.tableHeaders.experience')}   field="yearsExperience" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('agency')      && <SortableHead colKey="agency"      style={headStyle('agency')}      startResize={startResize} label={t('employees.list.tableHeaders.agency')}       field="agency"          sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('birthDate')   && <SortableHead colKey="birthDate" style={headStyle('birthDate')} startResize={startResize} label={t('employees.list.tableHeaders.birthDate', { defaultValue: 'Birth Date' })} field="birthDate" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('age')         && <SortableHead colKey="age"       style={headStyle('age')}       startResize={startResize} label={t('employees.list.tableHeaders.age', { defaultValue: 'Age' })} field="age" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('status')      && <SortableHead colKey="status"     style={headStyle('status')}     startResize={startResize} label={t('employees.list.tableHeaders.status')}       field="status"          sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('createdAt')   && <SortableHead colKey="createdAt"  style={headStyle('createdAt')}  startResize={startResize} label={t('employees.list.tableHeaders.createdAt', { defaultValue: 'Created' })} field="createdAt"      sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  <TableHead className="text-end relative whitespace-normal align-top" style={headStyle('actions')}>{t('employees.list.tableHeaders.actions')}<ResizeHandle onMouseDown={(e) => startResize('actions', e)} /></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
                {loading && (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="text-center py-8 text-muted-foreground">{t('employees.list.loading')}</TableCell>
                  </TableRow>
                )}
                {!loading && displayData.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="text-center py-12 text-muted-foreground">{t('employees.list.emptyFiltered')}</TableCell>
                  </TableRow>
                )}
                {!loading && displayData.map(driver => (
                  <TableRow key={driver.id} data-state={selected.has(driver.id) ? 'selected' : undefined}>
                    <TableCell className="w-10">
                      <Checkbox
                        checked={selected.has(driver.id)}
                        onCheckedChange={() => toggleSelect(driver.id)}
                        aria-label={t('employees.list.selectRowAria', { name: `${driver.firstName ?? ''} ${driver.lastName ?? ''}`.trim() })}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {driver.photoUrl ? (
                          <img
                            src={driver.photoUrl.startsWith('http') ? driver.photoUrl : `${(import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '')}${driver.photoUrl}`}
                            alt={driver.firstName}
                            className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-[#EFF6FF] flex items-center justify-center text-[#2563EB] text-sm font-semibold flex-shrink-0">
                            {driver.firstName?.[0]}{driver.lastName?.[0]}
                          </div>
                        )}
                        <div>
                          <div className="font-medium text-[#0F172A]">{driver.firstName} {driver.lastName}</div>
                          <div className="text-sm text-muted-foreground font-mono">{driver.employeeNumber ?? '—'}</div>
                        </div>
                      </div>
                    </TableCell>
                    {tenant.isPlatformSuper && (
                      <TableCell className="text-sm">{tenant.resolveTenantName(driver)}</TableCell>
                    )}
                    {col('contact') && (
                      <TableCell>
                        <div className="text-sm">
                          <div>{driver.email}</div>
                          <div className="text-muted-foreground">{driver.phone}</div>
                        </div>
                      </TableCell>
                    )}
                    {col('nationality') && <TableCell className="text-sm">{driver.nationality}</TableCell>}
                    {col('license') && (
                      <TableCell className="text-sm">{driver.licenseNumber ?? '—'}</TableCell>
                    )}
                    {col('experience') && (
                      <TableCell className="text-sm">
                        {driver.yearsExperience != null ? t('employees.list.yearsValue', { count: Number(driver.yearsExperience) }) : '—'}
                      </TableCell>
                    )}
                    {col('agency') && (
                      <TableCell>
                        {driver.agency
                          ? <span className="text-sm">{driver.agency.name ?? driver.agencyName}</span>
                          : driver.agencyName
                            ? <span className="text-sm">{driver.agencyName}</span>
                            : <span className="text-sm text-muted-foreground">{t('employees.list.direct')}</span>}
                      </TableCell>
                    )}
                    {col('birthDate') && (
                      <TableCell className="text-sm tabular-nums whitespace-nowrap">
                        {driver.dateOfBirth ? formatDate(driver.dateOfBirth) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    {col('age') && (
                      <TableCell className="text-sm tabular-nums">
                        {(() => {
                          if (!driver.dateOfBirth) return <span className="text-muted-foreground">—</span>;
                          const d = new Date(driver.dateOfBirth);
                          if (isNaN(d.getTime())) return <span className="text-muted-foreground">—</span>;
                          const now = new Date();
                          let age = now.getFullYear() - d.getFullYear();
                          const m = now.getMonth() - d.getMonth();
                          if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
                          return age;
                        })()}
                      </TableCell>
                    )}
                    {col('status') && (
                      <TableCell>
                        <Badge className={getStatusColor(driver.status)}>
                          {driver.status ? tEnums(`employeeStatus.${driver.status}`, { defaultValue: driver.status.replace(/_/g, ' ').toLowerCase() }) : ''}
                        </Badge>
                      </TableCell>
                    )}
                    {col('createdAt') && (
                      <TableCell className="text-sm whitespace-nowrap">
                        {driver.createdAt ? new Date(driver.createdAt).toLocaleDateString() : '—'}
                      </TableCell>
                    )}
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        {/* Order: View → Edit → WhatsApp → Delete (Phase 1 #13, #16) */}
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/dashboard/employees/${driver.id}`}><Eye className="w-4 h-4 me-1" />{t('employees.list.actions.view')}</Link>
                        </Button>
                        {canEdit('employees') && (
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/dashboard/employees/${driver.id}/edit`}><Edit className="w-4 h-4 me-1" />{t('employees.list.actions.edit')}</Link>
                          </Button>
                        )}
                        <WhatsAppButton phone={formatPhoneDisplay(driver.phone)} size="icon" />
                        {canDelete('employees') && (
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(driver)} className="text-[#EF4444] hover:text-[#EF4444] hover:bg-[#FEF2F2]">
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

          <div className="mt-4">
            <p className="text-sm text-muted-foreground">
              {t('employees.list.showingCount', { count: totalEmployees, shown: displayData.length, total: totalEmployees })}
              {selected.size > 0 && t('employees.list.selectedSuffix', { count: selected.size })}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
