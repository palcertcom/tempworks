import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Wrench, Pencil, Trash2, ArrowLeft, RefreshCw, Search, Filter, Download,
  FileSpreadsheet, FileText, ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { vehiclesApi } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { formatDate } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';

const MAINTENANCE_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: 'bg-blue-100 text-blue-800',
  IN_PROGRESS: 'bg-yellow-100 text-yellow-800',
  COMPLETED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-gray-100 text-gray-600',
};

function StatusBadge({ status, tEnums }: { status: string; tEnums: (k: string, opts?: any) => string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {tEnums(`maintenanceStatus.${status}`, { defaultValue: status.replace('_', ' ') })}
    </span>
  );
}

export function MaintenanceRecordsList() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { t: tEnums } = useTranslation('enums');
  const tMR = (key: string, opts?: any) => t(`vehicles.maintenanceRecords.${key}`, opts);
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenantVersion = useTenantSyncVersion();
  const tenant = useSuperUserTenantFilter();
  const canWrite = canCreate('vehicles');

  const [records, setRecords] = useState<any[]>([]);
  const [workshops, setWorkshops] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [workshopFilter, setWorkshopFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Selection for export
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = { page, limit: 20 };
      if (statusFilter)   params.status     = statusFilter;
      if (workshopFilter) params.workshopId = workshopFilter;
      if (dateFrom)       params.dateFrom   = dateFrom;
      if (dateTo)         params.dateTo     = dateTo;
      tenant.applyToParams(params);

      const [recordsRes, workshopsRes] = await Promise.all([
        vehiclesApi.listMaintenance(params),
        vehiclesApi.listWorkshops(tenant.applyToParams({})),
      ]);

      setRecords(recordsRes.data ?? []);
      setTotal(recordsRes.total ?? 0);
      setTotalPages(recordsRes.totalPages ?? 1);
      setWorkshops(workshopsRes ?? []);
    } catch {
      toast.error(tc('toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, workshopFilter, dateFrom, dateTo, tenantVersion, tenant.tenantFilter]);

  useEffect(() => { load(); }, [load]);

  const filteredRecords = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = !term ? [...records] : records.filter((r: any) =>
      r.vehicle?.registrationNumber?.toLowerCase().includes(term) ||
      r.vehicle?.make?.toLowerCase().includes(term) ||
      r.vehicle?.model?.toLowerCase().includes(term) ||
      r.maintenanceType?.name?.toLowerCase().includes(term) ||
      r.workshop?.name?.toLowerCase().includes(term) ||
      r.description?.toLowerCase().includes(term),
    );
    // Default sort: newest first by creation date.
    return filtered.sort((a: any, b: any) => {
      const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [records, search]);

  const handleDelete = async (id: string) => {
    if (!(await confirm({
      title: t('common:confirm.deleteMaintenanceRecordTitle'),
      description: t('common:confirm.deleteMaintenanceRecordBody'),
      confirmText: t('common:actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await vehiclesApi.deleteMaintenance(id);
      toast.success(tc('toast.deleted'));
      load();
    } catch {
      toast.error(tc('toast.deleteFailed'));
    }
  };

  const clearFilters = () => {
    setStatusFilter('');
    setWorkshopFilter('');
    setDateFrom('');
    setDateTo('');
    setSearch('');
    setPage(1);
  };

  const buildExportParams = (scope: 'selected' | 'all') => {
    const params: any = {};
    if (scope === 'selected') {
      params.recordIds = Array.from(selected);
    } else {
      if (statusFilter)   params.status     = statusFilter;
      if (workshopFilter) params.workshopId = workshopFilter;
      if (dateFrom)       params.dateFrom   = dateFrom;
      if (dateTo)         params.dateTo     = dateTo;
    }
    return params;
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportExcel = async (scope: 'selected' | 'all') => {
    setExporting(true);
    setExportOpen(false);
    try {
      const blob = await vehiclesApi.exportMaintenanceExcel(buildExportParams(scope));
      const date = new Date().toISOString().split('T')[0];
      downloadBlob(blob, `maintenance-records-${date}.xlsx`);
      toast.success(tc('toast.exportComplete_excel'));
    } catch {
      toast.error(tc('toast.exportFailed_excel'));
    } finally {
      setExporting(false);
    }
  };

  const handleExportPdf = async (scope: 'selected' | 'all') => {
    setExporting(true);
    setExportOpen(false);
    try {
      const blob = await vehiclesApi.exportMaintenancePdf(buildExportParams(scope));
      const date = new Date().toISOString().split('T')[0];
      downloadBlob(blob, `maintenance-records-${date}.pdf`);
      toast.success(tc('toast.exportComplete_pdf'));
    } catch {
      toast.error(tc('toast.exportFailed_pdf'));
    } finally {
      setExporting(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const allIds = filteredRecords.map((r: any) => r.id);
      const allSelected = allIds.every((id: string) => prev.has(id));
      if (allSelected) {
        const next = new Set(prev);
        allIds.forEach((id: string) => next.delete(id));
        return next;
      } else {
        const next = new Set(prev);
        allIds.forEach((id: string) => next.add(id));
        return next;
      }
    });
  };

  const fmtDate = (date: string | null | undefined) => {
    if (!date) return '—';
    return formatDate(date);
  };

  const formatCurrency = (amount: number | null | undefined) => {
    if (amount == null) return '—';
    return `£${amount.toFixed(2)}`;
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard/vehicles')}>
            <ArrowLeft className="w-4 h-4 me-1" /> {tMR('back')}
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Wrench className="w-6 h-6" /> {t('vehicles.maintenanceRecords.title')}
            </h1>
            <p className="text-sm text-muted-foreground">{t('vehicles.maintenanceRecords.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={load}>
            <RefreshCw className="w-4 h-4 me-2" /> {tMR('refresh')}
          </Button>

          {/* Export dropdown */}
          <div className="relative" ref={exportRef}>
            <Button
              variant="outline"
              onClick={() => setExportOpen((o) => !o)}
              disabled={exporting}
            >
              <Download className="w-4 h-4 me-2" />
              {exporting ? tMR('exporting') : tMR('export')}
              <ChevronDown className="w-4 h-4 ms-1" />
            </Button>
            {exportOpen && (
              <div className="absolute end-0 mt-1 w-64 bg-popover border rounded-md shadow-lg z-50 py-1">
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
                  {tMR('excelHeader')}
                </div>
                <button
                  className="w-full text-start px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                  onClick={() => handleExportExcel('all')}
                >
                  <FileSpreadsheet className="w-4 h-4 text-green-600" />
                  {tMR('allFiltered', { count: total })}
                </button>
                <button
                  className="w-full text-start px-3 py-2 text-sm hover:bg-accent flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => handleExportExcel('selected')}
                  disabled={selected.size === 0}
                >
                  <FileSpreadsheet className="w-4 h-4 text-green-600" />
                  {tMR('selectedOnly', { count: selected.size })}
                </button>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-t">
                  {tMR('pdfHeader')}
                </div>
                <button
                  className="w-full text-start px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                  onClick={() => handleExportPdf('all')}
                >
                  <FileText className="w-4 h-4 text-red-600" />
                  {tMR('allFiltered', { count: total })}
                </button>
                <button
                  className="w-full text-start px-3 py-2 text-sm hover:bg-accent flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => handleExportPdf('selected')}
                  disabled={selected.size === 0}
                >
                  <FileText className="w-4 h-4 text-red-600" />
                  {tMR('selectedOnly', { count: selected.size })}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">{tc('filters.filtersLabel')}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">{tc('actions.search')}</Label>
              <div className="relative">
                <Search className="absolute start-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={tMR('searchPh')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="ps-8"
                />
              </div>
            </div>
            {tenant.isPlatformSuper && (
              <div className="space-y-1">
                <Label className="text-xs">{tc('tenantFilter.tenant', { defaultValue: 'Tenant' })}</Label>
                <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">{tMR('statusLabel')}</Label>
              <Select value={statusFilter || 'all'} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setPage(1); }}>
                <SelectTrigger><SelectValue placeholder={tMR('statusFilterPh')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tMR('filterAllStatuses')}</SelectItem>
                  {MAINTENANCE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{tEnums(`maintenanceStatus.${s}`, { defaultValue: s.replace('_', ' ') })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{tMR('workshopLabel')}</Label>
              <Select value={workshopFilter || 'all'} onValueChange={(v) => { setWorkshopFilter(v === 'all' ? '' : v); setPage(1); }}>
                <SelectTrigger><SelectValue placeholder={tMR('workshopFilterPh')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tMR('filterAllWorkshops')}</SelectItem>
                  {workshops.map((w: any) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('vehicles.maintenanceRecords.dateFrom')}</Label>
              <DateInput value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('vehicles.maintenanceRecords.dateTo')}</Label>
              <DateInput value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {tMR('showing', { count: total, shown: filteredRecords.length, total })}
              {selected.size > 0 && (
                <span className="ms-2 font-medium text-foreground">
                  {tMR('selectedCount', { count: selected.size })}
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  {tMR('clearSelection')}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={clearFilters}>{tMR('clearFilters')}</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Records Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={filteredRecords.length > 0 && filteredRecords.every((r: any) => selected.has(r.id))}
                    onChange={toggleSelectAll}
                  />
                </TableHead>
                <TableHead>{tMR('cols.vehicle')}</TableHead>
                <TableHead>{tMR('cols.type')}</TableHead>
                <TableHead>{tMR('cols.workshop')}</TableHead>
                <TableHead>{tMR('cols.status')}</TableHead>
                <TableHead>{tMR('cols.scheduled')}</TableHead>
                <TableHead>{tMR('cols.completed')}</TableHead>
                <TableHead>{tMR('cols.mileage')}</TableHead>
                <TableHead className="text-end">{tMR('cols.cost')}</TableHead>
                <TableHead>{tMR('cols.createdAt', { defaultValue: 'Created' })}</TableHead>
                <TableHead className="text-end">{tMR('cols.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
              {loading ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    {tc('states.loading')}
                  </TableCell>
                </TableRow>
              ) : filteredRecords.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    {t('vehicles.maintenanceRecords.empty')}
                  </TableCell>
                </TableRow>
              ) : filteredRecords.map((rec: any) => (
                <TableRow
                  key={rec.id}
                  className={`cursor-pointer ${selected.has(rec.id) ? 'bg-accent/50' : ''}`}
                  onClick={() => navigate(`/dashboard/vehicles/${rec.vehicleId}`)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="cursor-pointer"
                      checked={selected.has(rec.id)}
                      onChange={() => toggleSelect(rec.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{rec.vehicle?.registrationNumber}</div>
                    <div className="text-xs text-muted-foreground">
                      {rec.vehicle?.make} {rec.vehicle?.model}
                    </div>
                  </TableCell>
                  <TableCell>{rec.maintenanceType?.name ?? '—'}</TableCell>
                  <TableCell>{rec.workshop?.name ?? '—'}</TableCell>
                  <TableCell><StatusBadge status={rec.status} tEnums={tEnums} /></TableCell>
                  <TableCell className="text-sm">{fmtDate(rec.scheduledDate)}</TableCell>
                  <TableCell className="text-sm">{fmtDate(rec.completedDate)}</TableCell>
                  <TableCell className="text-sm">{rec.mileageAtService ? tMR('kmSuffix', { count: rec.mileageAtService }) : '—'}</TableCell>
                  <TableCell className="text-end text-sm">{formatCurrency(rec.cost)}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{rec.createdAt ? new Date(rec.createdAt).toLocaleDateString() : '—'}</TableCell>
                  <TableCell className="text-end" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => { e.stopPropagation(); navigate(`/dashboard/vehicles/${rec.vehicleId}`); }}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    {canWrite && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => { e.stopPropagation(); handleDelete(rec.id); }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            {tMR('previous')}
          </Button>
          <span className="text-sm text-muted-foreground">{tMR('pageOf', { page, totalPages })}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            {tMR('next')}
          </Button>
        </div>
      )}
    </div>
  );
}
