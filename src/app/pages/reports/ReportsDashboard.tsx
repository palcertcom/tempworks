import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import {
  BarChart3, TrendingUp, Users, FileCheck, Plus, Play, Download,
  Trash2, Edit3, FileSpreadsheet, FileText, File, AlertTriangle,
  RefreshCw, Database, Filter, SortAsc, Layers, Link2, ChevronUp, ChevronDown,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Checkbox } from '../../components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { reportsApi, getCurrentUser } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { formatDate } from '../../../i18n/formatters';
import { ShareReportDialog } from '../../components/reports/ShareReportDialog';
import { Share2, User, Lock, Globe } from 'lucide-react';

const PALETTE = ['#2563EB', '#22C55E', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4', '#EC4899'];

const FORMAT_ICONS: Record<string, React.ReactNode> = {
  excel: <FileSpreadsheet className="w-4 h-4 text-[#22C55E]" />,
  pdf:   <FileText         className="w-4 h-4 text-[#EF4444]" />,
  word:  <File             className="w-4 h-4 text-[#2563EB]" />,
};

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const OPERATORS = [
  { value: 'eq',          label: 'Equals' },
  { value: 'ne',          label: 'Not Equals' },
  { value: 'gt',          label: 'Greater Than' },
  { value: 'gte',         label: 'Greater or Equal' },
  { value: 'lt',          label: 'Less Than' },
  { value: 'lte',         label: 'Less or Equal' },
  { value: 'like',        label: 'Contains' },
  { value: 'between',     label: 'Between' },
  { value: 'in',          label: 'In (comma-separated)' },
  { value: 'is_null',     label: 'Is Empty' },
  { value: 'is_not_null', label: 'Is Not Empty' },
];

const AGG_TYPES = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];

function emptyBuilder() {
  return { name: '', description: '', dataSource: '', filters: [] as any[], columns: [] as any[], sorting: [] as any[] };
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({ title, icon, value, sub, loading, color }: any) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <span style={{ color }}>{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold text-[#0F172A]" style={loading ? { color: '#CBD5E1' } : {}}>{loading ? '—' : value}</div>
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      </CardContent>
    </Card>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmtCell(value: any, type?: string): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (type === 'date' || value instanceof Date) {
    const d = value instanceof Date ? value : new Date(value);
    if (!isNaN(d.getTime())) {
      return formatDate(d);
    }
  }
  // Catch ISO date strings even without explicit type hint
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return formatDate(d);
    }
  }
  return String(value);
}

// ─── Preview Table ─────────────────────────────────────────────────────────────
function PreviewTable({ result, maxRows, startSerial = 1 }: { result: any; maxRows?: number; startSerial?: number }) {
  const { t } = useTranslation('pages');
  const cols: any[] = result.columns ?? [];
  const rows: any[] = (result.rows ?? []).slice(0, maxRows ?? 9999);
  if (!cols.length) return <p className="p-4 text-sm text-muted-foreground">{t('reports.dashboard.noColumnsSelected')}</p>;
  return (
    <table className="w-full text-sm">
      <thead className="bg-[#F8FAFC] border-b">
        <tr>
          <th className="text-center p-3 font-semibold text-xs whitespace-nowrap border-e w-10 text-muted-foreground">#</th>
          {cols.map((c: any) => (
            <th key={c.key} className="text-start p-3 font-semibold text-xs whitespace-nowrap border-e last:border-e-0">{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={cols.length + 1} className="p-6 text-center text-muted-foreground">{t('reports.dashboard.noDataReturned')}</td></tr>
        ) : rows.map((row: any, ri: number) => (
          <tr key={ri} className={`border-b ${ri % 2 === 1 ? 'bg-[#F8FAFC]' : ''} hover:bg-[#EFF6FF] transition-colors`}>
            <td className="p-3 border-e text-xs text-center text-muted-foreground tabular-nums w-10">{startSerial + ri}</td>
            {cols.map((c: any) => (
              <td key={c.key} className="p-3 border-e last:border-e-0 text-xs max-w-[180px] truncate">
                {fmtCell(row[c.key], c.type)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export function ReportsDashboard() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const tenantVersion = useTenantSyncVersion();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenant = useSuperUserTenantFilter();
  const { canEdit } = usePermissions();

  const [kpis, setKpis]           = useState<any>(null);
  const [kpiLoading, setKpiLoading] = useState(true);
  const [savedReports, setSavedReports]     = useState<any[]>([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [dataSources, setDataSources] = useState<any[]>([]);
  const [builder, setBuilder]         = useState(emptyBuilder());
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [saving, setSaving]           = useState(false);
  const [previewResult, setPreviewResult]   = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [runningId, setRunningId]       = useState<string | null>(null);
  const [runResult, setRunResult]       = useState<Record<string, any>>({});
  const [exporting, setExporting]       = useState<Record<string, boolean>>({});
  // Phase 3 Reports Hardening — Phase C (sharing UI).
  const [shareReportId, setShareReportId] = useState<string | null>(null);
  const currentUserId = getCurrentUser()?.id ?? null;
  // Phase 3 Reports Hardening — Phase D (#19): hide UUID columns from
  // the column picker by default. A small toggle exposes them when an
  // admin genuinely needs the technical identifier.
  const [showAdvancedColumns, setShowAdvancedColumns] = useState(false);
  const [activeTab, setActiveTab]       = useState('dashboard');

  useEffect(() => {
    reportsApi.getDashboard()
      .then(setKpis).catch(() => {}).finally(() => setKpiLoading(false));
    reportsApi.list(tenant.applyToParams({}))
      .then((res: any) => setSavedReports(Array.isArray(res) ? res : (res?.data ?? [])))
      .catch(() => {}).finally(() => setReportsLoading(false));
    reportsApi.getDataSources()
      .then((res: any) => setDataSources(Array.isArray(res) ? res : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantVersion, tenant.tenantFilter]);

  const sourceFields = dataSources.find((ds: any) => ds.key === builder.dataSource)?.fields ?? [];

  // ── Builder helpers ───────────────────────────────────────────────────────
  const addFilter = () => setBuilder(b => ({ ...b, filters: [...b.filters, { id: Date.now(), fieldName: sourceFields[0]?.key ?? '', operator: 'eq', value: '', value2: '', valueType: sourceFields[0]?.type ?? 'string' }] }));
  const removeFilter = (i: number) => setBuilder(b => ({ ...b, filters: b.filters.filter((_, j) => j !== i) }));
  const updateFilter = (i: number, patch: any) => setBuilder(b => { const f = [...b.filters]; f[i] = { ...f[i], ...patch }; return { ...b, filters: f }; });
  // Phase 3 Reports Hardening — Select All / Deselect All for the
  // column picker. Bulk selection adds every field of the current
  // source not already in the column list, preserving any per-column
  // configuration (group by, aggregation) the user had set.
  // Phase 3 Reports Hardening — Phase D: `hideByDefault` fields
  // (raw UUIDs) are skipped here so Select All never adds them. The
  // "Show advanced fields" toggle below exposes them individually
  // for callers who genuinely need the technical column.
  const selectAllColumns = () => setBuilder(b => {
    const present = new Set(b.columns.map((c: any) => c.columnName));
    const additions = sourceFields
      .filter((f: any) => !present.has(f.key) && (showAdvancedColumns || !f.hideByDefault))
      .map((f: any, i: number) => ({
        columnName: f.key, displayName: f.label, dataType: 'string',
        isGrouped: false, isAggregated: false, aggregationType: null,
        position: b.columns.length + i,
      }));
    return { ...b, columns: [...b.columns, ...additions] };
  });
  const deselectAllColumns = () => setBuilder(b => ({ ...b, columns: [] }));
  const toggleColumn = (key: string, label: string) => setBuilder(b => {
    const ex = b.columns.find((c: any) => c.columnName === key);
    if (ex) return { ...b, columns: b.columns.filter((c: any) => c.columnName !== key) };
    return { ...b, columns: [...b.columns, { columnName: key, displayName: label, dataType: 'string', isGrouped: false, isAggregated: false, aggregationType: null, position: b.columns.length }] };
  });
  const updateColumn = (key: string, patch: any) => setBuilder(b => ({ ...b, columns: b.columns.map((c: any) => c.columnName === key ? { ...c, ...patch } : c) }));
  const moveColumn = (key: string, dir: 'up' | 'down') => setBuilder(b => {
    const sorted = [...b.columns].sort((a: any, b: any) => a.position - b.position);
    const idx = sorted.findIndex((c: any) => c.columnName === key);
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return b;
    const posA = sorted[idx].position;
    sorted[idx] = { ...sorted[idx], position: sorted[swapIdx].position };
    sorted[swapIdx] = { ...sorted[swapIdx], position: posA };
    return { ...b, columns: sorted };
  });
  const addSort = (key: string) => setBuilder(b => {
    if (b.sorting.find((s: any) => s.columnName === key)) return b;
    return { ...b, sorting: [...b.sorting, { columnName: key, direction: 'ASC', position: b.sorting.length }] };
  });
  const removeSort = (i: number) => setBuilder(b => ({ ...b, sorting: b.sorting.filter((_, j) => j !== i) }));
  const updateSort = (i: number, patch: any) => setBuilder(b => { const s = [...b.sorting]; s[i] = { ...s[i], ...patch }; return { ...b, sorting: s }; });
  const loadIntoBuilder = (r: any) => { setBuilder({ name: r.name, description: r.description ?? '', dataSource: r.dataSource, filters: r.filters ?? [], columns: r.columns ?? [], sorting: r.sorting ?? [] }); setEditingId(r.id); setPreviewResult(null); setActiveTab('builder'); };
  const resetBuilder = () => { setBuilder(emptyBuilder()); setEditingId(null); setPreviewResult(null); };
  const buildPayload = () => ({ name: builder.name.trim(), description: builder.description.trim() || undefined, dataSource: builder.dataSource, filters: builder.filters.map(({ id: _id, ...f }: any) => f), columns: builder.columns, sorting: builder.sorting });
  const refreshList = async () => { const r: any = await reportsApi.list(tenant.applyToParams({})); setSavedReports(Array.isArray(r) ? r : (r?.data ?? [])); };

  const handleSave = async () => {
    if (!builder.name.trim()) { toast.error(tc('toast.reportNameRequired')); return; }
    if (!builder.dataSource)  { toast.error(tc('toast.selectDataSource'));    return; }
    if (builder.columns.length === 0) { toast.error(tc('toast.selectAtLeastOneColumn', { defaultValue: 'Select at least one column.' })); return; }
    setSaving(true);
    try {
      if (editingId) { await reportsApi.update(editingId, buildPayload()); toast.success(tc('toast.savedSuccessfully')); }
      else           { await reportsApi.create(buildPayload());             toast.success(tc('toast.savedSuccessfully'));   }
      await refreshList(); resetBuilder();
    } catch (err: any) { toast.error(apiError(err, tc('toast.saveFailed'))); }
    finally { setSaving(false); }
  };

  // Phase 3 Reports Hardening — Preview NO LONGER saves. It posts the
  // current builder state to /reports/preview which runs the query
  // against the same engine with a fixed 50-row cap, then throws the
  // definition away. The "Save Report" button is the only path that
  // persists. Fixes the "test → delete → recreate" name-conflict trail
  // and the "every Preview click leaves a saved report behind" trail.
  const handlePreview = async () => {
    if (!builder.dataSource)        { toast.error(tc('toast.selectDataSource'));          return; }
    if (builder.columns.length === 0) { toast.error(tc('toast.selectAtLeastOneColumn', { defaultValue: 'Select at least one column.' })); return; }
    setPreviewLoading(true);
    try {
      const pl = buildPayload();
      const result = await reportsApi.preview({
        dataSource: pl.dataSource,
        columns: pl.columns,
        filters: pl.filters,
        sorting: pl.sorting,
      });
      setPreviewResult(result);
    } catch (err: any) { toast.error(apiError(err, tc('toast.operationFailed'))); }
    finally { setPreviewLoading(false); }
  };

  const handleRunReport = async (id: string) => {
    setRunningId(id);
    try { const r = await reportsApi.run(id, { page: 1, limit: 100 }); setRunResult(p => ({ ...p, [id]: r })); }
    catch (err: any) { toast.error(apiError(err, tc('toast.operationFailed'))); }
    finally { setRunningId(null); }
  };

  const handleExport = async (id: string, format: 'excel' | 'pdf' | 'word', name: string) => {
    const key = `${id}-${format}`;
    setExporting(p => ({ ...p, [key]: true }));
    try {
      const blob = await reportsApi.export(id, format);
      const ext  = format === 'excel' ? 'xlsx' : format === 'word' ? 'docx' : 'pdf';
      triggerDownload(blob, `${name.replace(/\s+/g, '_')}_${Date.now()}.${ext}`);
      toast.success(tc('toast.downloadedAs', { format: ext.toUpperCase() }));
    } catch (err: any) { toast.error(apiError(err, tc('toast.exportFailed'))); }
    finally { setExporting(p => ({ ...p, [key]: false })); }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirm({
      title: t('common:confirm.deleteReportTitle'),
      description: t('common:confirm.deleteReportBody'),
      confirmText: t('common:actions.delete'), tone: 'destructive',
    }))) return;
    try { await reportsApi.delete(id); setSavedReports(p => p.filter(r => r.id !== id)); if (editingId === id) resetBuilder(); toast.success(tc('toast.deleted')); }
    catch (err: any) { toast.error(apiError(err, tc('toast.deleteFailed'))); }
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-[#0F172A]">{t('reports.dashboard.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('reports.dashboard.subtitle')}</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full grid grid-cols-3 mb-2">
          <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 me-2" />Dashboard</TabsTrigger>
          <TabsTrigger value="builder"><Plus className="w-4 h-4 me-2" />{t('reports.dashboard.reportBuilder')}</TabsTrigger>
          <TabsTrigger value="saved">
            <Database className="w-4 h-4 me-2" />Saved Reports
            {savedReports.length > 0 && <Badge className="ms-2 bg-[#2563EB] text-white text-xs px-1.5">{savedReports.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ── DASHBOARD ─────────────────────────────────────────────── */}
        <TabsContent value="dashboard" className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard title="Total Employees"     icon={<Users className="w-4 h-4" />}         value={kpis?.employees?.total ?? '—'}              sub={`${kpis?.employees?.active ?? 0} active`}                     loading={kpiLoading} color="#2563EB" />
            <KpiCard title="Total Applicants"    icon={<TrendingUp className="w-4 h-4" />}    value={kpis?.applicants?.total ?? '—'}             sub={`+${kpis?.applicants?.newThisMonth ?? 0} this month`}          loading={kpiLoading} color="#22C55E" />
            <KpiCard title="Open Alerts"         icon={<AlertTriangle className="w-4 h-4" />} value={kpis?.compliance?.openAlerts ?? '—'}        sub={`${kpis?.compliance?.criticalAlerts ?? 0} critical`}           loading={kpiLoading} color="#EF4444" />
            <KpiCard title="Docs Expiring (30d)" icon={<FileCheck className="w-4 h-4" />}     value={kpis?.compliance?.expiringDocuments ?? '—'} sub="within next 30 days"                                          loading={kpiLoading} color="#F59E0B" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-base">{t('reports.dashboard.employeesByStatus')}</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={kpis?.employees?.byStatus ?? []} barSize={40}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                    <XAxis dataKey="status" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {(kpis?.employees?.byStatus ?? []).map((_: any, i: number) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">{t('reports.dashboard.applicantsByStatus')}</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={kpis?.applicants?.byStatus ?? []} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={95} label={({ status, percent }: any) => `${status} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                      {(kpis?.applicants?.byStatus ?? []).map((_: any, i: number) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Pie>
                    <Tooltip /><Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── REPORT BUILDER ────────────────────────────────────────── */}
        <TabsContent value="builder" className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-lg">{editingId ? 'Edit Report' : 'New Report'}</h2>
              <p className="text-sm text-muted-foreground">{t('reports.dashboard.builderHelp')}</p>
            </div>
            {editingId && <Button variant="outline" size="sm" onClick={resetBuilder}>{t('reports.dashboard.newClear')}</Button>}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Config panel */}
            <div className="space-y-4">

              {/* Info */}
              <Card>
                <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Database className="w-4 h-4 text-[#2563EB]" />{t('reports.dashboard.reportInfo')}</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <Label>Name *</Label>
                    <Input className="mt-1" placeholder="Active Employees by Country" value={builder.name} onChange={e => setBuilder(b => ({ ...b, name: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Input className="mt-1" placeholder="Optional" value={builder.description} onChange={e => setBuilder(b => ({ ...b, description: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Data Source *</Label>
                    <Select value={builder.dataSource} onValueChange={v => setBuilder(b => {
                      // Phase 3 Reports Hardening — Phase D (#19):
                      // when the user picks a new source, pre-select
                      // the source's `defaultColumns` so the report
                      // starts on business-friendly identifiers
                      // instead of an empty column list.
                      const ds = dataSources.find((d: any) => d.key === v);
                      const defaults = Array.isArray(ds?.defaultColumns) ? ds.defaultColumns : [];
                      const seedColumns = defaults
                        .map((k: string, i: number) => {
                          const f = (ds?.fields ?? []).find((x: any) => x.key === k);
                          if (!f) return null;
                          return {
                            columnName: k,
                            displayName: f.label,
                            dataType: 'string',
                            isGrouped: false,
                            isAggregated: false,
                            aggregationType: null,
                            position: i,
                          };
                        })
                        .filter(Boolean);
                      return { ...emptyBuilder(), name: b.name, description: b.description, dataSource: v, columns: seedColumns as any };
                    })}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="Select…" /></SelectTrigger>
                      <SelectContent>
                        {dataSources.some((ds: any) => ds.group === 'single') && (
                          <>
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t('reports.dashboard.singleTable')}</div>
                            {dataSources.filter((ds: any) => ds.group === 'single').map((ds: any) => (
                              <SelectItem key={ds.key} value={ds.key}>
                                <div className="flex items-center gap-2">
                                  <Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                  {ds.label}
                                </div>
                              </SelectItem>
                            ))}
                          </>
                        )}
                        {dataSources.some((ds: any) => ds.group === 'combined') && (
                          <>
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide border-t mt-1 pt-2">{t('reports.dashboard.combinedMultiTable')}</div>
                            {dataSources.filter((ds: any) => ds.group === 'combined').map((ds: any) => (
                              <SelectItem key={ds.key} value={ds.key}>
                                <div className="flex items-center gap-2">
                                  <Link2 className="w-3.5 h-3.5 text-[#8B5CF6] shrink-0" />
                                  {ds.label}
                                </div>
                              </SelectItem>
                            ))}
                          </>
                        )}
                      </SelectContent>
                    </Select>
                    {/* Show join indicator when a combined source is selected */}
                    {(() => {
                      const sel = dataSources.find((ds: any) => ds.key === builder.dataSource);
                      if (!sel || sel.group !== 'combined') return null;
                      return (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-[#8B5CF6]">
                          <Link2 className="w-3 h-3" />
                          <span className="font-medium">{t('reports.dashboard.joining')}</span>
                          {(sel.tables as string[]).map((t: string, i: number) => (
                            <span key={t}>
                              {i > 0 && <span className="text-muted-foreground mx-0.5">+</span>}
                              <Badge variant="outline" className="text-xs px-1 py-0 border-[#8B5CF6] text-[#8B5CF6]">{t}</Badge>
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </CardContent>
              </Card>

              {/* Columns */}
              {builder.dataSource && (
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Layers className="w-4 h-4 text-[#8B5CF6]" />
                        Columns
                        <Badge variant="outline" className="ms-1 text-xs">
                          {builder.columns.length}/{sourceFields.filter((f: any) => showAdvancedColumns || !f.hideByDefault).length}
                        </Badge>
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        {/* Show-advanced toggle — unhides raw UUID columns. */}
                        {sourceFields.some((f: any) => f.hideByDefault) && (
                          <label className="flex items-center gap-1 text-xs cursor-pointer text-muted-foreground">
                            <Checkbox checked={showAdvancedColumns} onCheckedChange={(v) => setShowAdvancedColumns(!!v)} />
                            {tc('reports.showAdvancedColumns', { defaultValue: 'Show advanced fields' })}
                          </label>
                        )}
                        <Button
                          type="button" size="sm" variant="outline"
                          onClick={selectAllColumns}
                          disabled={builder.columns.length === sourceFields.filter((f: any) => showAdvancedColumns || !f.hideByDefault).length}
                        >
                          {tc('actions.selectAll', { defaultValue: 'Select all' })}
                        </Button>
                        <Button
                          type="button" size="sm" variant="outline"
                          onClick={deselectAllColumns}
                          disabled={builder.columns.length === 0}
                        >
                          {tc('actions.deselectAll', { defaultValue: 'Deselect all' })}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 max-h-80 overflow-y-auto pe-1">
                    {sourceFields
                      .filter((f: any) => showAdvancedColumns || !f.hideByDefault)
                      .map((f: any) => {
                      const col = builder.columns.find((c: any) => c.columnName === f.key);
                      return (
                        <div key={f.key} className={`border rounded-lg p-2.5 space-y-2 ${col ? 'bg-[#EFF6FF] border-[#BFDBFE]' : ''}`}>
                          <div className="flex items-center gap-2">
                            <Checkbox checked={!!col} onCheckedChange={() => toggleColumn(f.key, f.label)} />
                            <span className="text-sm flex-1 font-medium">{f.label}</span>
                            {f.hideByDefault && (
                              <Badge variant="outline" className="text-[10px] px-1 border-amber-400 text-amber-600">
                                {tc('reports.advancedColumnTag', { defaultValue: 'Advanced' })}
                              </Badge>
                            )}
                            <Badge variant="outline" className="text-xs px-1.5">{f.type}</Badge>
                          </div>
                          {col && (
                            <div className="ps-6 space-y-2">
                              <Input className="h-7 text-xs" placeholder="Display name" value={col.displayName} onChange={e => updateColumn(f.key, { displayName: e.target.value })} />
                              <div className="flex gap-3">
                                <label className="flex items-center gap-1 text-xs cursor-pointer">
                                  <Checkbox checked={col.isGrouped} onCheckedChange={v => updateColumn(f.key, { isGrouped: !!v })} />
                                  Group by
                                </label>
                                <label className="flex items-center gap-1 text-xs cursor-pointer">
                                  <Checkbox checked={col.isAggregated} onCheckedChange={v => updateColumn(f.key, { isAggregated: !!v, aggregationType: v ? 'COUNT' : null })} />
                                  Aggregate
                                </label>
                              </div>
                              {col.isAggregated && (
                                <Select value={col.aggregationType ?? 'COUNT'} onValueChange={v => updateColumn(f.key, { aggregationType: v })}>
                                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                  <SelectContent>{AGG_TYPES.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                                </Select>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {/* Column order panel — only visible when ≥2 columns selected */}
                    {builder.columns.length >= 2 && (
                      <div className="pt-3 border-t mt-1 space-y-1.5">
                        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                          <SortAsc className="w-3.5 h-3.5" />Column Order
                        </p>
                        {[...builder.columns]
                          .sort((a: any, b: any) => a.position - b.position)
                          .map((col: any, idx: number, arr: any[]) => (
                            <div key={col.columnName} className="flex items-center gap-1.5 bg-[#EFF6FF] border border-[#BFDBFE] rounded px-2 py-1 text-xs">
                              <span className="text-muted-foreground w-4 text-center font-mono">{idx + 1}</span>
                              <span className="flex-1 truncate font-medium">{col.displayName}</span>
                              <Button
                                size="icon" variant="ghost"
                                className="h-5 w-5 text-[#2563EB] disabled:opacity-30"
                                disabled={idx === 0}
                                onClick={() => moveColumn(col.columnName, 'up')}
                              >
                                <ChevronUp className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="icon" variant="ghost"
                                className="h-5 w-5 text-[#2563EB] disabled:opacity-30"
                                disabled={idx === arr.length - 1}
                                onClick={() => moveColumn(col.columnName, 'down')}
                              >
                                <ChevronDown className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Sorting */}
              {builder.dataSource && (
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm flex items-center gap-2"><SortAsc className="w-4 h-4 text-[#F59E0B]" />Sorting</CardTitle>
                    <Select onValueChange={addSort}>
                      <SelectTrigger className="h-7 w-36 text-xs"><SelectValue placeholder="+ Add field" /></SelectTrigger>
                      <SelectContent>{sourceFields.map((f: any) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {builder.sorting.length === 0 && <p className="text-xs text-muted-foreground">{t('reports.dashboard.noSortRules')}</p>}
                    {builder.sorting.map((s: any, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs flex-1 truncate font-medium">{s.columnName}</span>
                        <Select value={s.direction} onValueChange={v => updateSort(i, { direction: v })}>
                          <SelectTrigger className="h-7 w-20 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="ASC">ASC</SelectItem><SelectItem value="DESC">DESC</SelectItem></SelectContent>
                        </Select>
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-[#EF4444]" onClick={() => removeSort(i)}>×</Button>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Filters + Actions + Preview */}
            <div className="lg:col-span-2 space-y-4">
              {/* Filters */}
              {builder.dataSource && (
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2"><Filter className="w-4 h-4 text-[#06B6D4]" />Filters <Badge variant="outline">{builder.filters.length}</Badge></CardTitle>
                    <Button size="sm" variant="outline" onClick={addFilter}><Plus className="w-3.5 h-3.5 me-1" />{t('reports.dashboard.addFilter')}</Button>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {builder.filters.length === 0 && <p className="text-sm text-muted-foreground">{t('reports.dashboard.noFiltersBody')}</p>}
                    {builder.filters.map((f: any, i: number) => (
                      <div key={f.id ?? i} className="border rounded-lg p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                        <div>
                          <Label className="text-xs">Field</Label>
                          <Select value={f.fieldName} onValueChange={v => { const m = sourceFields.find((sf: any) => sf.key === v); updateFilter(i, { fieldName: v, valueType: m?.type ?? 'string', value: '', value2: '' }); }}>
                            <SelectTrigger className="h-8 text-xs mt-0.5"><SelectValue /></SelectTrigger>
                            <SelectContent>{sourceFields.map((sf: any) => <SelectItem key={sf.key} value={sf.key}>{sf.label}</SelectItem>)}</SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-xs">Operator</Label>
                          <Select value={f.operator} onValueChange={v => updateFilter(i, { operator: v })}>
                            <SelectTrigger className="h-8 text-xs mt-0.5"><SelectValue /></SelectTrigger>
                            <SelectContent>{OPERATORS.map(op => <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>)}</SelectContent>
                          </Select>
                        </div>
                        {!['is_null', 'is_not_null'].includes(f.operator) && (
                          <div>
                            <Label className="text-xs">Value{f.operator === 'between' ? ' (from)' : ''}</Label>
                            <Input className="h-8 text-xs mt-0.5" placeholder={f.operator === 'in' ? 'a,b,c' : 'value'} value={f.value} onChange={e => updateFilter(i, { value: e.target.value })} />
                          </div>
                        )}
                        {f.operator === 'between' ? (
                          <div>
                            <Label className="text-xs">{t('reports.dashboard.valueTo')}</Label>
                            <Input className="h-8 text-xs mt-0.5" placeholder="end" value={f.value2 ?? ''} onChange={e => updateFilter(i, { value2: e.target.value })} />
                          </div>
                        ) : (
                          <div className="flex items-end">
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-[#EF4444]" onClick={() => removeFilter(i)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        )}
                        {f.operator === 'between' && (
                          <div className="col-span-2 sm:col-span-4 flex justify-end">
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-[#EF4444]" onClick={() => removeFilter(i)}><Trash2 className="w-3.5 h-3.5" /></Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Phase 3 Reports Hardening — preview/save copy. */}
              <p className="text-xs text-muted-foreground">
                {tc('reports.previewHint', { defaultValue: 'Preview shows the first 50 rows and does not save the report. Use filters or Export for larger datasets.' })}
              </p>

              {/* Action buttons */}
              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={handlePreview}
                  disabled={previewLoading || !builder.dataSource || builder.columns.length === 0}
                  className="bg-[#2563EB] hover:bg-[#1D4ED8]"
                >
                  {previewLoading ? <RefreshCw className="w-4 h-4 me-2 animate-spin" /> : <Play className="w-4 h-4 me-2" />}
                  {previewLoading ? 'Running preview…' : 'Preview (50 rows)'}
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={saving || !builder.dataSource || builder.columns.length === 0}
                  variant="outline"
                >
                  {saving ? <RefreshCw className="w-4 h-4 me-2 animate-spin" /> : null}
                  {saving ? 'Saving…' : editingId ? 'Update Report' : 'Save Report'}
                </Button>
                {editingId && (['excel', 'pdf', 'word'] as const).map(fmt => (
                  <Button key={fmt} variant="outline" size="sm" className="flex items-center gap-1.5" disabled={!!exporting[`${editingId}-${fmt}`]} onClick={() => handleExport(editingId!, fmt, builder.name)}>
                    {FORMAT_ICONS[fmt]}
                    {exporting[`${editingId}-${fmt}`] ? 'Exporting…' : fmt.toUpperCase()}
                  </Button>
                ))}
              </div>

              {/* Preview table */}
              {previewResult && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Preview — {previewResult.rows?.length ?? 0} of {previewResult.total ?? 0} total rows</CardTitle></CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <PreviewTable result={previewResult} />
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ── SAVED REPORTS ─────────────────────────────────────────── */}
        <TabsContent value="saved" className="space-y-4">
          {tenant.isPlatformSuper && (
            <div className="flex justify-end">
              <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
            </div>
          )}
          {reportsLoading ? (
            <div className="p-8 text-center text-muted-foreground">{t('reports.dashboard.loadingSavedReports')}</div>
          ) : savedReports.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Database className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-40" />
                <h3 className="font-semibold mb-1">{t('reports.dashboard.noSavedReportsTitle')}</h3>
                <p className="text-sm text-muted-foreground">{t('reports.dashboard.noSavedReportsBody')}</p>
              </CardContent>
            </Card>
          ) : savedReports.map(report => {
            // Phase 3 Reports Hardening — Phase C: derive the actor's
            // relationship to this report so we can hide controls the
            // backend would 404 on anyway. Backend remains the final
            // authority; this is a UX hint.
            const isOwner = !!currentUserId && report.createdById === currentUserId;
            const myShare = (report.shares ?? []).find((s: any) => s.userId === currentUserId);
            const isPublic = report.visibility === 'PUBLIC_IN_TENANT';
            const isSharee = !!myShare;
            const sharePermissionRank: Record<string, number> = { VIEW: 1, RUN: 2, EDIT: 3, SHARE: 4 };
            const myRank = isOwner ? 999 : (myShare ? sharePermissionRank[myShare.permission] ?? 0 : (isPublic ? 2 : 0));
            const canRun = myRank >= 2;
            const canEditReport = myRank >= 3;
            const canShareReport = isOwner || myRank >= 4;
            const canDeleteReport = isOwner;

            const accessKey =
              isOwner ? 'reports.access.ownedByMe' :
              isPublic ? 'reports.access.publicInTenant' :
              isSharee ? 'reports.access.sharedWithMe' :
              null; // safety net — backend would have filtered this row already

            const visibilityKey =
              report.visibility === 'PRIVATE'          ? 'reports.visibility.private' :
              report.visibility === 'SHARED'           ? 'reports.visibility.shared' :
              report.visibility === 'PUBLIC_IN_TENANT' ? 'reports.visibility.publicInTenant' :
              'reports.visibility.private';

            const creatorName = report.createdBy
              ? `${report.createdBy.firstName ?? ''} ${report.createdBy.lastName ?? ''}`.trim() || report.createdBy.email
              : null;
            const sharedCount = (report.shares ?? []).length;

            return (
            <Card key={report.id} className="overflow-hidden">
              <div className="p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="font-semibold text-[#0F172A] truncate">{report.name}</h3>
                      {(() => {
                        const ds = dataSources.find((d: any) => d.key === report.dataSource);
                        const isCombined = ds?.group === 'combined';
                        return (
                          <Badge
                            variant="outline"
                            className={`text-xs shrink-0 flex items-center gap-1 ${isCombined ? 'border-[#8B5CF6] text-[#8B5CF6]' : ''}`}
                          >
                            {isCombined && <Link2 className="w-3 h-3" />}
                            {ds?.label ?? report.dataSource?.replace(/_/g, ' ')}
                          </Badge>
                        );
                      })()}
                      {/* Visibility badge */}
                      <Badge
                        variant="outline"
                        className={`text-xs shrink-0 flex items-center gap-1 ${
                          report.visibility === 'PRIVATE'          ? 'border-slate-300 text-slate-600' :
                          report.visibility === 'SHARED'           ? 'border-[#2563EB] text-[#2563EB]' :
                                                                     'border-[#16A34A] text-[#16A34A]'
                        }`}
                        title={t(visibilityKey)}
                      >
                        {report.visibility === 'PRIVATE'          && <Lock   className="w-3 h-3" />}
                        {report.visibility === 'SHARED'           && <Share2 className="w-3 h-3" />}
                        {report.visibility === 'PUBLIC_IN_TENANT' && <Globe  className="w-3 h-3" />}
                        {t(visibilityKey)}
                      </Badge>
                      {/* Why-can-I-see-it badge */}
                      {accessKey && (
                        <Badge variant="outline" className="text-xs shrink-0 border-slate-300 text-slate-600">
                          {t(accessKey)}
                        </Badge>
                      )}
                    </div>
                    {report.description && <p className="text-sm text-muted-foreground mb-2 truncate">{report.description}</p>}
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Layers className="w-3 h-3" />{report.columns?.length ?? 0} columns</span>
                      <span className="flex items-center gap-1"><Filter className="w-3 h-3" />{report.filters?.length ?? 0} filters</span>
                      <span className="flex items-center gap-1"><SortAsc className="w-3 h-3" />{report.sorting?.length ?? 0} sorts</span>
                      <span>Updated {formatDate(report.updatedAt)}</span>
                      {creatorName && (
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {t('reports.sharing.createdBy', { name: creatorName })}
                        </span>
                      )}
                      {sharedCount > 0 && (
                        <span className="flex items-center gap-1">
                          <Share2 className="w-3 h-3" />
                          {t('reports.sharing.sharedWithN', { count: sharedCount })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    {canRun && (
                      <Button size="sm" variant="outline" onClick={() => handleRunReport(report.id)} disabled={runningId === report.id}>
                        {runningId === report.id ? <RefreshCw className="w-3.5 h-3.5 me-1 animate-spin" /> : <Play className="w-3.5 h-3.5 me-1" />}
                        Run
                      </Button>
                    )}
                    {canEditReport && canEdit('reports') && (
                      <Button size="sm" variant="outline" onClick={() => loadIntoBuilder(report)}>
                        <Edit3 className="w-3.5 h-3.5 me-1" />Edit
                      </Button>
                    )}
                    {canRun && canEdit('reports') && (['excel', 'pdf', 'word'] as const).map(fmt => (
                      <Button key={fmt} size="sm" variant="ghost" title={`Export as ${fmt}`} disabled={!!exporting[`${report.id}-${fmt}`]} onClick={() => handleExport(report.id, fmt, report.name)}>
                        {FORMAT_ICONS[fmt]}
                      </Button>
                    ))}
                    {canShareReport && (
                      <Button size="sm" variant="ghost" title={t('reports.sharing.manageAccess')} onClick={() => setShareReportId(report.id)}>
                        <Share2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {canDeleteReport && (
                      <Button size="sm" variant="ghost" className="text-[#EF4444] hover:text-[#DC2626]" onClick={() => handleDelete(report.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              {runResult[report.id] && (
                <div className="border-t">
                  <div className="px-5 py-2 bg-[#F8FAFC] flex items-center justify-between text-xs text-muted-foreground">
                    <span>{runResult[report.id].rows?.length} of {runResult[report.id].total} rows (page 1, limit 100)</span>
                    <Button size="sm" variant="ghost" className="text-xs h-6" onClick={() => setRunResult(p => { const c = { ...p }; delete c[report.id]; return c; })}>Collapse</Button>
                  </div>
                  <div className="overflow-x-auto">
                    <PreviewTable result={runResult[report.id]} maxRows={20} />
                  </div>
                </div>
              )}
            </Card>
            );
          })}
        </TabsContent>
      </Tabs>

      {/* Phase 3 Reports Hardening — Phase C: share/manage-access modal. */}
      {shareReportId && (() => {
        const report = savedReports.find((r: any) => r.id === shareReportId);
        if (!report) return null;
        return (
          <ShareReportDialog
            open
            onClose={() => setShareReportId(null)}
            report={report}
            onChanged={async () => { await refreshList(); }}
          />
        );
      })()}
    </div>
  );
}
