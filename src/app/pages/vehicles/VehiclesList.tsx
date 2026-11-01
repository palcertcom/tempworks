import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { useTranslation } from 'react-i18next';
import {
  Search, Download, Eye, Plus, Truck, RefreshCw, X,
  Edit, Trash2, ArrowUp, ArrowDown, ArrowUpDown, Columns2, Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { vehiclesApi, settingsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { formatDate } from '../../../i18n/formatters';

// Legacy enum codes that may still appear on rows created before the
// vehicle-types lookup was introduced. The frontend resolves them through
// `enums.vehicleType.<KEY>` with a defaultValue fallback so unknown
// admin-added types still render their stored name.
const LEGACY_TYPE_KEYS = new Set(['TRUCK', 'CAR', 'VAN', 'TANKER', 'TRAILER', 'REFRIGERATED_TRAILER', 'SPECIALTY']);

const VEHICLE_STATUSES = [
  { value: 'ACTIVE',          color: 'bg-green-100 text-green-800' },
  { value: 'INACTIVE',        color: 'bg-gray-100 text-gray-700' },
  { value: 'IN_MAINTENANCE',  color: 'bg-yellow-100 text-yellow-800' },
  { value: 'SCRAPPED',        color: 'bg-red-100 text-red-800' },
];

type TFn = (key: string, opts?: any) => string;

function statusBadge(status: string, tEnums: TFn) {
  const s = VEHICLE_STATUSES.find((x) => x.value === status);
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${s?.color ?? 'bg-gray-100 text-gray-700'}`}>{tEnums(`vehicleStatus.${status}`, { defaultValue: status })}</span>;
}

function typeLabel(type: string, tEnums: TFn): string {
  if (!type) return '';
  if (LEGACY_TYPE_KEYS.has(type)) return tEnums(`vehicleType.${type}`, { defaultValue: type });
  return type;
}

function ExpiryBadge({ date, tList }: { date: string | null | undefined; tList: TFn }) {
  if (!date) return <span className="text-muted-foreground text-xs">—</span>;
  const d = new Date(date);
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (days < 0)   return <span className="text-xs text-red-600 font-medium">{tList('expired')}</span>;
  if (days <= 30) return <span className="text-xs text-amber-600 font-medium">{tList('daysLeft', { count: days })}</span>;
  return <span className="text-xs text-green-700">{formatDate(d)}</span>;
}

// ── Column visibility ────────────────────────────────────────────────────────
type ColKey = 'type' | 'makeModel' | 'year' | 'status' | 'driver' | 'mot' | 'tax' | 'registration' | 'insurance' | 'tachograph' | 'atp' | 'pressureTest' | 'lastService' | 'serviceType' | 'workshop' | 'odometer' | 'createdAt';

const ALL_COLUMNS: { key: ColKey; labelKey: string; defaultLabel?: string }[] = [
  { key: 'type',      labelKey: 'vehicles.list.cols.type' },
  { key: 'makeModel', labelKey: 'vehicles.list.cols.makeModel' },
  { key: 'year',      labelKey: 'vehicles.list.cols.year' },
  { key: 'status',    labelKey: 'vehicles.list.cols.status' },
  { key: 'driver',    labelKey: 'vehicles.list.cols.driver' },
  { key: 'mot',       labelKey: 'vehicles.list.cols.mot' },
  { key: 'tax',       labelKey: 'vehicles.list.cols.tax' },
  { key: 'registration', labelKey: 'vehicles.list.cols.registration' },
  { key: 'insurance', labelKey: 'vehicles.list.cols.insurance' },
  { key: 'tachograph', labelKey: 'vehicles.list.cols.tachograph' },
  { key: 'atp',       labelKey: 'vehicles.list.cols.atp' },
  { key: 'pressureTest', labelKey: 'vehicles.list.cols.pressureTest' },
  { key: 'lastService', labelKey: 'vehicles.list.cols.lastService' },
  { key: 'serviceType', labelKey: 'vehicles.list.cols.serviceType' },
  { key: 'workshop', labelKey: 'vehicles.list.cols.workshop' },
  { key: 'odometer', labelKey: 'vehicles.list.cols.odometer' },
  { key: 'createdAt', labelKey: 'vehicles.list.cols.createdAt', defaultLabel: 'Created' },
];

// All compliance/expiry columns are visible by default so the Fleet
// list surfaces every regulated date at a glance. Operators can hide
// the type-specific ones (Tachograph / ATP / Pressure Test) via the
// Columns picker if their fleet doesn't use them. Maintenance columns
// (Last Service, Service Type) are visible; Workshop and Odometer
// are hidden by default.
const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  type: true, makeModel: true, year: true, status: true,
  driver: true, mot: true, tax: true, registration: true,
  insurance: true, tachograph: true, atp: true, pressureTest: true,
  lastService: true, serviceType: true, workshop: false, odometer: false,
  createdAt: true,
};

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const saved = localStorage.getItem('vehicles-table-columns');
    return saved ? { ...DEFAULT_VISIBLE, ...JSON.parse(saved) } : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

// ── Sort header ──────────────────────────────────────────────────────────────
type SortField = 'registration' | 'type' | 'makeModel' | 'year' | 'status' | 'driver' | 'mot' | 'tax' | 'registrationExp' | 'insurance' | 'tachograph' | 'atp' | 'pressureTest' | 'lastService' | 'serviceType' | 'workshop' | 'odometer' | 'createdAt';

function SortableHead({ label, field, sortBy, sortOrder, onSort, className }: {
  label: string; field: SortField; sortBy: SortField; sortOrder: 'asc' | 'desc';
  onSort: (f: SortField) => void; className?: string;
}) {
  const active = sortBy === field;
  return (
    <TableHead className={className}>
      <button onClick={() => onSort(field)} className="flex items-center gap-1 hover:text-foreground font-medium group">
        {label}
        {active
          ? sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-blue-600" /> : <ArrowDown className="w-3 h-3 text-blue-600" />
          : <ArrowUpDown className="w-3 h-3 opacity-30 group-hover:opacity-60" />}
      </button>
    </TableHead>
  );
}

export function VehiclesList() {
  const navigate = useNavigate();
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { t: tEnums } = useTranslation('enums');
  // Bound helpers — `tList` resolves under `vehicles.list.*`, used by
  // pure render helpers (statusBadge, ExpiryBadge) so they don't need
  // to thread the raw t() through long signatures.
  const tList: TFn = (key, opts) => t(`vehicles.list.${key}`, opts);
  const { canCreate } = usePermissions();
  const tenantVersion = useTenantSyncVersion();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenant = useSuperUserTenantFilter();
  const canWrite = canCreate('vehicles');

  // ── Data ───────────────────────────────────────────────────────────────────
  const [vehicles, setVehicles]         = useState<any[]>([]);
  const [stats, setStats]               = useState<any>(null);
  const [loading, setLoading]           = useState(true);
  const [total, setTotal]               = useState(0);
  const [page, setPage]                 = useState(1);
  const [exporting, setExporting]       = useState(false);
  const [vehicleTypes, setVehicleTypes] = useState<string[]>([]);
  const LIMIT = 20;

  // Centralised type list — the filter dropdown reads from System Settings →
  // Vehicle Settings so admins can add/rename categories without a code
  // change. Falls back to the seed defaults if the lookup ever fails.
  useEffect(() => {
    settingsApi.getVehicleSettings()
      .then((data) => {
        const list = data?.vehicleTypes;
        setVehicleTypes(Array.isArray(list) && list.length
          ? list
          : ['Truck', 'Car', 'Van', 'Tanker', 'Trailer', 'Refrigerated Trailer', 'Specialty']);
      })
      .catch(() => setVehicleTypes(['Truck', 'Car', 'Van', 'Tanker', 'Trailer', 'Refrigerated Trailer', 'Specialty']));
  }, []);

  // ── Filters ────────────────────────────────────────────────────────────────
  const [search, setSearch]             = useState('');
  const [typeFilter, setTypeFilter]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // ── Sorting (client-side on current page) ─────────────────────────────────
  const [sortBy, setSortBy]       = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const handleSort = (field: SortField) => {
    if (sortBy === field) setSortOrder(o => (o === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortOrder('asc'); }
  };

  // ── Column visibility ──────────────────────────────────────────────────────
  const [visibleColumns, setVisibleColumns] = useState<Record<ColKey, boolean>>(loadVisibleColumns);
  const [showColPicker, setShowColPicker]   = useState(false);
  const colPickerRef = useRef<HTMLDivElement>(null);

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
      localStorage.setItem('vehicles-table-columns', JSON.stringify(next));
      return next;
    });
  };

  const col = (key: ColKey) => visibleColumns[key];

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const loadVehicles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await vehiclesApi.list(tenant.applyToParams({
        page, limit: LIMIT,
        search: search || undefined,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
      }));
      setVehicles(res.data ?? []);
      setTotal(res.total ?? 0);
    } catch {
      toast.error(t('vehicles.list.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [page, search, typeFilter, statusFilter, t, tenantVersion, tenant.tenantFilter]);

  const loadStats = useCallback(async () => {
    try { setStats(await vehiclesApi.getStats()); } catch { /* non-critical */ }
  }, []);

  useEffect(() => { loadVehicles(); }, [loadVehicles]);
  useEffect(() => { loadStats(); }, [loadStats]);

  // Reset page and clear selection when filters change
  useEffect(() => { setPage(1); setSelectedIds(new Set()); }, [search, typeFilter, statusFilter]);

  // ── Sorted vehicles ────────────────────────────────────────────────────────
  const displayVehicles = useMemo(() => {
    return [...vehicles].sort((a, b) => {
      let aVal: any, bVal: any;
      const driverA = a.driverAssignments?.[0]?.employee;
      const driverB = b.driverAssignments?.[0]?.employee;
      switch (sortBy) {
        case 'registration': aVal = a.registrationNumber?.toLowerCase() ?? ''; bVal = b.registrationNumber?.toLowerCase() ?? ''; break;
        case 'type':         aVal = typeLabel(a.type, tEnums).toLowerCase(); bVal = typeLabel(b.type, tEnums).toLowerCase(); break;
        case 'makeModel':    aVal = `${a.make ?? ''} ${a.model ?? ''}`.toLowerCase(); bVal = `${b.make ?? ''} ${b.model ?? ''}`.toLowerCase(); break;
        case 'year':         aVal = Number(a.year ?? 0); bVal = Number(b.year ?? 0); break;
        case 'status':       aVal = a.status ?? ''; bVal = b.status ?? ''; break;
        case 'driver':       aVal = driverA ? `${driverA.firstName} ${driverA.lastName}`.toLowerCase() : ''; bVal = driverB ? `${driverB.firstName} ${driverB.lastName}`.toLowerCase() : ''; break;
        case 'mot':          aVal = a.motExpiryDate ?? ''; bVal = b.motExpiryDate ?? ''; break;
        case 'tax':          aVal = a.taxExpiryDate ?? ''; bVal = b.taxExpiryDate ?? ''; break;
        case 'registrationExp': aVal = a.registrationExpiryDate ?? ''; bVal = b.registrationExpiryDate ?? ''; break;
        case 'insurance':    aVal = a.insuranceExpiryDate ?? ''; bVal = b.insuranceExpiryDate ?? ''; break;
        case 'tachograph':   aVal = a.tachographCalibrationExpiry ?? ''; bVal = b.tachographCalibrationExpiry ?? ''; break;
        case 'atp':          aVal = a.atpCertificateExpiry ?? ''; bVal = b.atpCertificateExpiry ?? ''; break;
        case 'pressureTest': aVal = a.nextPressureTestDate ?? ''; bVal = b.nextPressureTestDate ?? ''; break;
        case 'lastService':  aVal = a.maintenanceRecords?.[0]?.completedDate ?? ''; bVal = b.maintenanceRecords?.[0]?.completedDate ?? ''; break;
        case 'serviceType':  aVal = a.maintenanceRecords?.[0]?.maintenanceType?.name?.toLowerCase() ?? ''; bVal = b.maintenanceRecords?.[0]?.maintenanceType?.name?.toLowerCase() ?? ''; break;
        case 'workshop':     aVal = a.maintenanceRecords?.[0]?.workshop?.name?.toLowerCase() ?? ''; bVal = b.maintenanceRecords?.[0]?.workshop?.name?.toLowerCase() ?? ''; break;
        case 'odometer':     aVal = Number(a.currentMileage ?? 0); bVal = Number(b.currentMileage ?? 0); break;
        case 'createdAt':    aVal = a.createdAt ?? ''; bVal = b.createdAt ?? ''; break;
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [vehicles, sortBy, sortOrder]);

  // ── Delete / Export ────────────────────────────────────────────────────────
  const handleDelete = async (vehicleId: string) => {
    if (!(await confirm({
      title: t('vehicles.list.deleteTitle'),
      description: t('vehicles.list.deleteBody'),
      confirmText: tc('actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await vehiclesApi.delete(vehicleId);
      toast.success(t('vehicles.list.deleteSuccess'));
      loadVehicles(); loadStats();
    } catch (err: any) { toast.error(apiError(err, t('vehicles.list.deleteFailed'))); }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === displayVehicles.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(displayVehicles.map(v => v.id)));
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      // Export only selected vehicles if any are selected, otherwise use filters
      const vehicleIds = selectedIds.size > 0 ? Array.from(selectedIds) : undefined;
      const blob = await vehiclesApi.exportExcel({
        type: typeFilter || undefined,
        status: statusFilter || undefined,
        vehicleIds,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `vehicles-${new Date().toISOString().split('T')[0]}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
      toast.success(selectedIds.size > 0 ? t('vehicles.list.exportedCount', { count: selectedIds.size }) : t('vehicles.list.exportedAll'));
    } catch { toast.error(t('vehicles.list.exportFailed')); }
    finally { setExporting(false); }
  };

  const clearFilters = () => { setSearch(''); setTypeFilter(''); setStatusFilter(''); setPage(1); };
  const hasFilters = search || typeFilter || statusFilter;
  const totalPages = Math.ceil(total / LIMIT);

  const hiddenCount = ALL_COLUMNS.filter(c => !visibleColumns[c.key]).length;
  const colSpan = 3 + ALL_COLUMNS.filter(c => visibleColumns[c.key]).length; // checkbox + registration + visible + actions

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Truck className="w-7 h-7 text-primary" />
            {t('vehicles.list.title')}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t('vehicles.list.subtitle')}</p>
        </div>
        <div className="flex gap-2 items-center">
          <Button variant="outline" size="sm" onClick={loadVehicles} disabled={loading}>
            <RefreshCw className={`w-4 h-4 me-1 ${loading ? 'animate-spin' : ''}`} />
            {tList('refresh')}
          </Button>

          {/* Column picker */}
          <div className="relative" ref={colPickerRef}>
            <Button
              variant="outline" size="sm"
              onClick={() => setShowColPicker(v => !v)}
              className={showColPicker ? 'border-blue-500 text-blue-600' : ''}
            >
              <Columns2 className="w-4 h-4 me-1.5" />{tList('columnsButton')}
              {hiddenCount > 0 && (
                <span className="ms-1.5 bg-blue-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                  {hiddenCount}
                </span>
              )}
            </Button>
            {showColPicker && (
              <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[180px]">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{t('vehicles.list.toggleCols')}</p>
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
                  <button onClick={() => { const all = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, true])) as Record<ColKey, boolean>; setVisibleColumns(all); localStorage.setItem('vehicles-table-columns', JSON.stringify(all)); }} className="flex-1 text-xs text-center text-blue-600 hover:underline py-0.5">{t('vehicles.list.showAll')}</button>
                  <span className="text-gray-300">|</span>
                  <button onClick={() => { const none = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, false])) as Record<ColKey, boolean>; setVisibleColumns(none); localStorage.setItem('vehicles-table-columns', JSON.stringify(none)); }} className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5">{t('vehicles.list.hideAll')}</button>
                </div>
              </div>
            )}
          </div>

          <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} className={selectedIds.size > 0 ? 'border-blue-500 text-blue-600' : ''}>
            <Download className="w-4 h-4 me-2" />
            {exporting ? tList('exporting') : selectedIds.size > 0 ? tList('exportSelected', { count: selectedIds.size }) : tList('exportExcel')}
          </Button>
          {canWrite && (
            <Button size="sm" onClick={() => navigate('/dashboard/vehicles/new')}>
              <Plus className="w-4 h-4 me-2" />{tList('addButton')}
            </Button>
          )}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { key: 'total',           label: tList('stats.total'),           value: stats.totalVehicles,       color: 'text-blue-700' },
            { key: 'active',          label: tList('stats.active'),          value: stats.activeVehicles,      color: 'text-green-700' },
            { key: 'inMaintenance',   label: tList('stats.inMaintenance'),   value: stats.inMaintenance,       color: 'text-amber-700' },
            { key: 'scrapped',        label: tList('stats.scrapped'),        value: stats.scrapped,            color: 'text-gray-500' },
            { key: 'upcomingService', label: tList('stats.upcomingService'), value: stats.upcomingMaintenance, color: 'text-purple-700' },
            { key: 'expiringDocs',    label: tList('stats.expiringDocs'),    value: stats.expiringDocs,        color: 'text-red-700' },
          ].map((s) => (
            <Card key={s.key} className="p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={tList('searchPh')}
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="ps-9"
              />
            </div>
            {tenant.isPlatformSuper && (
              <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
            )}
            <Select value={typeFilter || 'all'} onValueChange={(v) => { setTypeFilter(v === 'all' ? '' : v); setPage(1); }}>
              <SelectTrigger className="w-44"><SelectValue placeholder={t('vehicles.list.filterAllTypes')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('vehicles.list.filterAllTypes')}</SelectItem>
                {vehicleTypes.map((vt) => {
                  // Translate canonical seed names (Truck, Van, …) via the
                  // enums.vehicleType catalog; fall back to the raw stored
                  // name for admin-added custom types.
                  const upperKey = vt.toUpperCase().replace(/\s+/g, '_');
                  return <SelectItem key={vt} value={vt}>{tEnums(`vehicleType.${upperKey}`, { defaultValue: vt })}</SelectItem>;
                })}
              </SelectContent>
            </Select>
            <Select value={statusFilter || 'all'} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setPage(1); }}>
              <SelectTrigger className="w-40"><SelectValue placeholder={t('vehicles.list.filterAllStatuses')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('vehicles.list.filterAllStatuses')}</SelectItem>
                {VEHICLE_STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{tEnums(`vehicleStatus.${s.value}`)}</SelectItem>)}
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="w-4 h-4 me-1" />{tList('clear')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">
            {tList('fleetCount', { count: total })}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <input
                      type="checkbox"
                      checked={displayVehicles.length > 0 && selectedIds.size === displayVehicles.length}
                      indeterminate={selectedIds.size > 0 && selectedIds.size < displayVehicles.length}
                      onChange={toggleSelectAll}
                      className="w-4 h-4 cursor-pointer"
                      aria-label={tList('selectAllAria')}
                    />
                  </TableHead>
                  <SortableHead label={tList('registrationHeader')}      field="registration"    sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                  {col('type')         && <SortableHead label={tList('cols.type')}          field="type"            sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('makeModel')    && <SortableHead label={tList('cols.makeModel')}     field="makeModel"       sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('year')         && <SortableHead label={tList('cols.year')}          field="year"            sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('status')       && <SortableHead label={tList('cols.status')}        field="status"          sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('driver')       && <SortableHead label={tList('cols.driver')}        field="driver"          sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('mot')          && <SortableHead label={tList('cols.mot')}           field="mot"             sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('tax')          && <SortableHead label={tList('cols.tax')}           field="tax"             sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('registration') && <SortableHead label={tList('cols.registration')}  field="registrationExp" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('insurance')    && <SortableHead label={tList('cols.insurance')}     field="insurance"       sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('tachograph')   && <SortableHead label={tList('cols.tachograph')}    field="tachograph"      sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('atp')          && <SortableHead label={tList('cols.atp')}           field="atp"             sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('pressureTest') && <SortableHead label={tList('cols.pressureTest')}  field="pressureTest"    sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('lastService')  && <SortableHead label={tList('cols.lastService')}   field="lastService"     sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('serviceType')  && <SortableHead label={tList('cols.serviceType')}   field="serviceType"     sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('workshop')     && <SortableHead label={tList('cols.workshop')}      field="workshop"        sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('odometer')     && <SortableHead label={tList('cols.odometer')}      field="odometer"        sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('createdAt')    && <SortableHead label={tList('cols.createdAt', { defaultValue: 'Created' })} field="createdAt" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  <TableHead className="text-end">{tList('actionsHeader')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
                {loading ? (
                  <TableRow><TableCell colSpan={colSpan} className="text-center py-8 text-muted-foreground">{tc('states.loading')}</TableCell></TableRow>
                ) : displayVehicles.length === 0 ? (
                  <TableRow><TableCell colSpan={colSpan} className="text-center py-8 text-muted-foreground">{t('vehicles.list.empty')}</TableCell></TableRow>
                ) : displayVehicles.map((v) => {
                  const driver = v.driverAssignments?.[0]?.employee;
                  const isSelected = selectedIds.has(v.id);
                  return (
                    <TableRow key={v.id} className={`cursor-pointer hover:bg-accent/50 ${isSelected ? 'bg-blue-50' : ''}`} onClick={() => navigate(`/dashboard/vehicles/${v.id}`)}>
                      <TableCell className="w-12" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(v.id)}
                          className="w-4 h-4 cursor-pointer"
                          aria-label={tList('selectRowAria', { name: v.registrationNumber })}
                        />
                      </TableCell>
                      <TableCell className="font-mono font-medium">{v.registrationNumber}</TableCell>
                      {col('type')      && <TableCell className="text-sm">{typeLabel(v.type, tEnums)}</TableCell>}
                      {col('makeModel') && <TableCell>{v.make} {v.model}</TableCell>}
                      {col('year')      && <TableCell>{v.year ?? '—'}</TableCell>}
                      {col('status')    && <TableCell>{statusBadge(v.status, tEnums)}</TableCell>}
                      {col('driver')    && (
                        <TableCell className="text-sm">
                          {driver ? `${driver.firstName} ${driver.lastName}` : <span className="text-muted-foreground">{tList('unassigned')}</span>}
                        </TableCell>
                      )}
                      {col('mot')          && <TableCell><ExpiryBadge date={v.motExpiryDate}                  tList={tList} /></TableCell>}
                      {col('tax')          && <TableCell><ExpiryBadge date={v.taxExpiryDate}                  tList={tList} /></TableCell>}
                      {col('registration') && <TableCell><ExpiryBadge date={v.registrationExpiryDate}         tList={tList} /></TableCell>}
                      {col('insurance')    && <TableCell><ExpiryBadge date={v.insuranceExpiryDate}            tList={tList} /></TableCell>}
                      {col('tachograph')   && <TableCell><ExpiryBadge date={v.tachographCalibrationExpiry}    tList={tList} /></TableCell>}
                      {col('atp')          && <TableCell><ExpiryBadge date={v.atpCertificateExpiry}           tList={tList} /></TableCell>}
                      {col('pressureTest') && <TableCell><ExpiryBadge date={v.nextPressureTestDate}           tList={tList} /></TableCell>}
                      {col('lastService') && (
                        <TableCell className="text-sm">
                          {v.maintenanceRecords?.[0]?.completedDate
                            ? formatDate(v.maintenanceRecords[0].completedDate)
                            : <span className="text-muted-foreground">—</span>
                          }
                        </TableCell>
                      )}
                      {col('serviceType') && (
                        <TableCell className="text-sm">
                          {v.maintenanceRecords?.[0]?.maintenanceType?.name ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      )}
                      {col('workshop') && (
                        <TableCell className="text-sm">
                          {v.maintenanceRecords?.[0]?.workshop?.name ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      )}
                      {col('odometer') && (
                        <TableCell className="text-sm">
                          {v.currentMileage ? `${Number(v.currentMileage).toLocaleString()} km` : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      )}
                      {col('createdAt') && (
                        <TableCell className="text-sm whitespace-nowrap">
                          {v.createdAt ? new Date(v.createdAt).toLocaleDateString() : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      )}
                      <TableCell className="text-end" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => navigate(`/dashboard/vehicles/${v.id}`)}>
                            <Eye className="w-4 h-4" />
                          </Button>
                          {canWrite && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => navigate(`/dashboard/vehicles/${v.id}/edit`)}>
                                <Edit className="w-4 h-4" />
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => handleDelete(v.id)}>
                                <Trash2 className="w-4 h-4 text-destructive" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <span className="text-sm text-muted-foreground">
                {tList('paginationLabel', { page, totalPages, total })}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{tList('previous')}</Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>{tList('next')}</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
