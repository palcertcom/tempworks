import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, RefreshCw, RotateCcw, Eye, Trash2, Shield,
  ChevronLeft, ChevronRight, Users, FileText, Building2, Briefcase,
  DollarSign, Bell, BarChart3, FolderOpen, UserCheck, Truck, Wrench,
  ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { Label } from '../../components/ui/label';
import { recycleBinApi } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { toast } from 'sonner';
import { formatDateTime } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';


// ── Types ─────────────────────────────────────────────────────────────────────

interface DeletedRecord {
  entityType: string;
  id: string;
  displayName: string;
  businessId?: string;
  deletedAt: string;
  deletedBy?: string;
  deletedByName?: string;
  deletionReason?: string;
  canRestore: boolean;
  canRestoreWithRelated: boolean;
  canHardDelete: boolean;
  relatedDeletedCount: number;
  extra?: Record<string, any>;
}

interface RelatedData {
  relatedRecords: DeletedRecord[];
  summary: Record<string, number>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ENTITY_META: Record<string, { icon: any; color: string }> = {
  APPLICANT:        { icon: UserCheck,  color: 'bg-blue-100 text-blue-800' },
  EMPLOYEE:         { icon: Users,      color: 'bg-green-100 text-green-800' },
  USER:             { icon: Shield,     color: 'bg-purple-100 text-purple-800' },
  AGENCY:           { icon: Building2,  color: 'bg-orange-100 text-orange-800' },
  DOCUMENT:         { icon: FileText,   color: 'bg-cyan-100 text-cyan-800' },
  DOCUMENT_TYPE:    { icon: FolderOpen, color: 'bg-teal-100 text-teal-800' },
  JOB_AD:           { icon: Briefcase,  color: 'bg-yellow-100 text-yellow-800' },
  JOB_TYPE:         { icon: Briefcase,  color: 'bg-lime-100 text-lime-800' },
  FINANCIAL_RECORD: { icon: DollarSign, color: 'bg-emerald-100 text-emerald-800' },
  ROLE:             { icon: Shield,     color: 'bg-indigo-100 text-indigo-800' },
  NOTIFICATION:     { icon: Bell,       color: 'bg-gray-100 text-gray-800' },
  REPORT:           { icon: BarChart3,  color: 'bg-pink-100 text-pink-800' },
  VEHICLE:          { icon: Truck,      color: 'bg-sky-100 text-sky-800' },
  VEHICLE_DOCUMENT: { icon: FileText,   color: 'bg-blue-100 text-blue-800' },
  MAINTENANCE_RECORD: { icon: Wrench,   color: 'bg-amber-100 text-amber-800' },
  MAINTENANCE_TYPE: { icon: Wrench,     color: 'bg-orange-100 text-orange-800' },
  WORKSHOP:         { icon: Building2,  color: 'bg-slate-100 text-slate-800' },
};

const ENTITY_KEYS = Object.keys(ENTITY_META);

function formatDate(iso: string) {
  if (!iso) return '—';
  return formatDateTime(iso);
}

function EntityBadge({ entityType }: { entityType: string }) {
  const { t } = useTranslation('pages');
  const meta = ENTITY_META[entityType] ?? { icon: FileText, color: 'bg-gray-100 text-gray-800' };
  const label = t(`recycleBin.list.entityLabels.${entityType}`, { defaultValue: entityType });
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${meta.color}`}>
      <meta.icon className="w-3 h-3" />
      {label}
    </span>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

// Sortable column header — click to toggle ascending/descending on
// that field. Mirrors the pattern used by other list pages.
type SortableHeadProps<F extends string> = {
  label: string;
  field: F;
  sortField: F;
  sortOrder: 'asc' | 'desc';
  onClick: (f: F) => void;
};
function SortableHead<F extends string>({ label, field, sortField, sortOrder, onClick }: SortableHeadProps<F>) {
  const active = sortField === field;
  const Icon = !active ? ArrowUpDown : sortOrder === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className="px-4 py-3 text-start font-medium text-muted-foreground select-none">
      <button
        type="button"
        onClick={() => onClick(field)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        {label}
        <Icon className="w-3 h-3 opacity-70" />
      </button>
    </th>
  );
}

export function DeletedRecords() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canView } = usePermissions();

  if (!canView('recycle-bin')) {
    return (
      <div className="p-8 flex items-center justify-center min-h-64">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto text-red-500 mb-3 opacity-60" />
          <h2 className="text-lg font-semibold mb-1">{t('recycleBin.list.accessDenied')}</h2>
          <p className="text-muted-foreground text-sm">{t('recycleBin.list.accessDeniedBody')}</p>
        </div>
      </div>
    );
  }

  // ── State ──────────────────────────────────────────────────────────────────
  const [records, setRecords] = useState<DeletedRecord[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Filters
  const [search, setSearch] = useState('');
  const [entityType, setEntityType] = useState('__all__');
  const [deletedFrom, setDeletedFrom] = useState('');
  const [deletedTo, setDeletedTo] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  // Per-column sort applied client-side to the current page. Backend
  // still paginates by deletedAt (sortOrder above), so the visible
  // window is the same set of rows; the column sort just reorders
  // that window for easier scanning.
  type SortField = 'entityType' | 'displayName' | 'businessId' | 'deletedAt' | 'deletedBy' | 'deletionReason';
  const [sortField, setSortField] = useState<SortField>('deletedAt');
  const [colSortOrder, setColSortOrder] = useState<'asc' | 'desc'>('desc');
  const LIMIT = 20;

  // Dialogs
  const [selectedRecord, setSelectedRecord] = useState<DeletedRecord | null>(null);
  const [relatedData, setRelatedData] = useState<RelatedData | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [showRelatedDialog, setShowRelatedDialog] = useState(false);

  const [restoreTarget, setRestoreTarget] = useState<DeletedRecord | null>(null);
  const [restoreWithRelated, setRestoreWithRelated] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);

  const [hardDeleteTarget, setHardDeleteTarget] = useState<DeletedRecord | null>(null);
  const [hardDeleteLoading, setHardDeleteLoading] = useState(false);
  const [showHardDeleteDialog, setShowHardDeleteDialog] = useState(false);

  // Click a header to toggle the per-column sort: first click selects
  // it ascending, second click flips to descending.
  const toggleSort = (field: SortField) => {
    if (sortField === field) setColSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setColSortOrder('asc'); }
  };

  const displayRecords = useMemo(() => {
    const arr = [...records];
    arr.sort((a, b) => {
      const dir = colSortOrder === 'asc' ? 1 : -1;
      const av = ((): string | number => {
        switch (sortField) {
          case 'entityType':     return a.entityType ?? '';
          case 'displayName':    return (a.displayName ?? '').toLowerCase();
          case 'businessId':     return (a.businessId ?? '').toLowerCase();
          case 'deletedAt':      return new Date(a.deletedAt).getTime();
          case 'deletedBy':      return (a.deletedByName ?? a.deletedBy ?? '').toLowerCase();
          case 'deletionReason': return (a.deletionReason ?? '').toLowerCase();
        }
      })();
      const bv = ((): string | number => {
        switch (sortField) {
          case 'entityType':     return b.entityType ?? '';
          case 'displayName':    return (b.displayName ?? '').toLowerCase();
          case 'businessId':     return (b.businessId ?? '').toLowerCase();
          case 'deletedAt':      return new Date(b.deletedAt).getTime();
          case 'deletedBy':      return (b.deletedByName ?? b.deletedBy ?? '').toLowerCase();
          case 'deletionReason': return (b.deletionReason ?? '').toLowerCase();
        }
      })();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [records, sortField, colSortOrder]);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {
        page: String(page),
        limit: String(LIMIT),
        sortOrder,
      };
      if (entityType !== '__all__') params.entityType = entityType;
      if (search) params.search = search;
      if (deletedFrom) params.deletedFrom = deletedFrom;
      if (deletedTo) params.deletedTo = deletedTo;

      const res = await recycleBinApi.list(params);
      setRecords(res.data ?? []);
      setTotal(res.meta?.total ?? 0);
      setTotalPages(res.meta?.totalPages ?? 1);
    } catch {
      toast.error(tc('toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [page, sortOrder, entityType, search, deletedFrom, deletedTo]);

  const fetchCounts = useCallback(async () => {
    try {
      const c = await recycleBinApi.getCounts();
      setCounts(c);
    } catch {}
  }, []);

  useEffect(() => { fetchRecords(); fetchCounts(); }, [fetchRecords, fetchCounts]);

  // ── Related data dialog ────────────────────────────────────────────────────
  const openRelated = async (rec: DeletedRecord) => {
    setSelectedRecord(rec);
    setRelatedLoading(true);
    setShowRelatedDialog(true);
    try {
      const data = await recycleBinApi.getRelated(rec.entityType, rec.id);
      setRelatedData(data);
    } catch {
      toast.error(tc('toast.loadFailed'));
    } finally {
      setRelatedLoading(false);
    }
  };

  // ── Restore dialog ─────────────────────────────────────────────────────────
  const openRestore = (rec: DeletedRecord, withRelated = false) => {
    setRestoreTarget(rec);
    setRestoreWithRelated(withRelated);
    setShowRestoreDialog(true);
  };

  const executeRestore = async () => {
    if (!restoreTarget) return;
    setRestoreLoading(true);
    try {
      const result = await recycleBinApi.restore(restoreTarget.entityType, restoreTarget.id, {
        withRelated: restoreWithRelated,
      });
      toast.success(
        tc('toast.restoredEntityNamed', {
          entity: t(`recycleBin.list.entityLabels.${restoreTarget.entityType}`, { defaultValue: restoreTarget.entityType }),
          name: restoreTarget.displayName,
        }) +
        (result.restored ? ` (${Object.entries(result.restored).filter(([, v]) => (v as number) > 0).map(([k, v]) => `${v} ${k}`).join(', ')})` : '')
      );
      if (result.warnings?.length) {
        result.warnings.forEach((w: string) => toast.warning(w));
      }
      setShowRestoreDialog(false);
      setRestoreTarget(null);
      fetchRecords();
      fetchCounts();
    } catch (e: any) {
      toast.error(e?.message ?? t('recycleBin.list.restoreFailed'));
    } finally {
      setRestoreLoading(false);
    }
  };

  // ── Hard delete ────────────────────────────────────────────────────────────
  const executeHardDelete = async () => {
    if (!hardDeleteTarget) return;
    setHardDeleteLoading(true);
    try {
      await recycleBinApi.hardDelete(hardDeleteTarget.entityType, hardDeleteTarget.id, {});
      toast.success(tc('toast.permanentlyDeletedNamed', { name: hardDeleteTarget.displayName }));
      setShowHardDeleteDialog(false);
      setHardDeleteTarget(null);
      fetchRecords();
      fetchCounts();
    } catch (e: any) {
      toast.error(e?.message ?? t('recycleBin.list.deleteFailed'));
    } finally {
      setHardDeleteLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('recycleBin.list.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t('recycleBin.list.subtitle')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { fetchRecords(); fetchCounts(); }}>
          <RefreshCw className="w-4 h-4 me-2" />
          {t('recycleBin.list.refresh')}
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {ENTITY_KEYS.filter((key) => (counts[key] ?? 0) > 0 || counts.total > 0).map((key) => {
          const meta = ENTITY_META[key];
          return (
            <Card
              key={key}
              className={`cursor-pointer transition-all hover:shadow-md ${entityType === key ? 'ring-2 ring-primary' : ''}`}
              onClick={() => { setEntityType(entityType === key ? '__all__' : key); setPage(1); }}
            >
              <CardContent className="p-3 text-center">
                <meta.icon className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                <div className="text-xl font-bold">{counts[key] ?? 0}</div>
                <div className="text-xs text-muted-foreground">{t(`recycleBin.list.entityLabels.${key}`)}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <div className="flex-1 min-w-48">
              <div className="relative">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder={t('recycleBin.list.searchPh')}
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1); }}
                  className="ps-9"
                />
              </div>
            </div>
            <Select value={entityType} onValueChange={v => { setEntityType(v); setPage(1); }}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder={t('recycleBin.list.allTypes')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('recycleBin.list.allTypes')}</SelectItem>
                {ENTITY_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>{t(`recycleBin.list.entityLabels.${key}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={v => setSortOrder(v as 'asc' | 'desc')}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">{t('recycleBin.list.newestFirst')}</SelectItem>
                <SelectItem value="asc">{t('recycleBin.list.oldestFirst')}</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">{t('recycleBin.list.deletedFrom')}</Label>
              <DateInput value={deletedFrom} onChange={e => { setDeletedFrom(e.target.value); setPage(1); }} className="w-36" />
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">{t('recycleBin.list.deletedTo')}</Label>
              <DateInput value={deletedTo} onChange={e => { setDeletedTo(e.target.value); setPage(1); }} className="w-36" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {loading ? t('recycleBin.list.loading') : t('recycleBin.list.deletedRecord', { count: total })}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <SortableHead label={t('recycleBin.list.type')}                              field="entityType"     sortField={sortField} sortOrder={colSortOrder} onClick={toggleSort} />
                  <SortableHead label={t('recycleBin.list.nameOrId')}                          field="displayName"    sortField={sortField} sortOrder={colSortOrder} onClick={toggleSort} />
                  <SortableHead label={t('recycleBin.list.businessId')}                        field="businessId"     sortField={sortField} sortOrder={colSortOrder} onClick={toggleSort} />
                  <SortableHead label={t('recycleBin.list.deletedAt')}                         field="deletedAt"      sortField={sortField} sortOrder={colSortOrder} onClick={toggleSort} />
                  <SortableHead label={t('recycleBin.list.deletedBy', { defaultValue: 'Deleted By' })} field="deletedBy" sortField={sortField} sortOrder={colSortOrder} onClick={toggleSort} />
                  <SortableHead label={t('recycleBin.list.reason')}                            field="deletionReason" sortField={sortField} sortOrder={colSortOrder} onClick={toggleSort} />
                  <th className="px-4 py-3 text-start font-medium text-muted-foreground">{t('recycleBin.list.relatedHeader')}</th>
                  <th className="px-4 py-3 text-end font-medium text-muted-foreground">{t('recycleBin.list.actionsHeader')}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">{t('recycleBin.list.loading')}</td></tr>
                ) : displayRecords.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                    <RotateCcw className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    {t('recycleBin.list.noRecords')}
                  </td></tr>
                ) : displayRecords.map(rec => (
                  <tr key={`${rec.entityType}-${rec.id}`} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3"><EntityBadge entityType={rec.entityType} /></td>
                    <td className="px-4 py-3">
                      <div className="font-medium truncate max-w-48">{rec.displayName}</div>
                      <div className="text-xs text-muted-foreground font-mono">{rec.id.slice(0, 8)}…</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {rec.businessId ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                      {formatDate(rec.deletedAt)}
                    </td>
                    <td className="px-4 py-3 text-xs max-w-40 truncate">
                      {rec.deletedByName
                        ? <span>{rec.deletedByName}</span>
                        : rec.deletedBy
                          ? <span className="text-muted-foreground font-mono">{rec.deletedBy.slice(0, 8)}…</span>
                          : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs max-w-32 truncate">
                      {rec.deletionReason ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {rec.relatedDeletedCount > 0 ? (
                        <button
                          onClick={() => openRelated(rec)}
                          className="text-xs text-primary hover:underline"
                        >
                          {t('recycleBin.list.relatedCount', { count: rec.relatedDeletedCount })}
                        </button>
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {rec.relatedDeletedCount > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => openRelated(rec)} title={t('recycleBin.list.viewRelatedTooltip')}>
                            <Eye className="w-4 h-4" />
                          </Button>
                        )}
                        {rec.canRestore && (
                          <Button variant="ghost" size="sm" className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50" onClick={() => openRestore(rec, false)} title={t('recycleBin.list.restoreTooltip')}>
                            <RotateCcw className="w-4 h-4" />
                          </Button>
                        )}
                        {rec.canRestoreWithRelated && rec.relatedDeletedCount > 0 && (
                          <Button variant="ghost" size="sm" className="text-blue-600 hover:text-blue-700 hover:bg-blue-50" onClick={() => openRestore(rec, true)} title={t('recycleBin.list.restoreWithRelatedTooltip')}>
                            <RotateCcw className="w-4 h-4 me-1" />
                            <span className="text-xs">{t('recycleBin.list.related')}</span>
                          </Button>
                        )}
                        {rec.canHardDelete && (
                          <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => { setHardDeleteTarget(rec); setShowHardDeleteDialog(true); }} title={t('recycleBin.list.hardDeleteTooltip')}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <div className="text-sm text-muted-foreground">
                {t('recycleBin.list.pageOf', { page, totalPages, total })}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Related Data Dialog ───────────────────────────────────────────── */}
      <Dialog open={showRelatedDialog} onOpenChange={setShowRelatedDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('recycleBin.list.viewRelatedTitle')}</DialogTitle>
            <DialogDescription asChild>
              <span dangerouslySetInnerHTML={{ __html: t('recycleBin.list.viewRelatedSubtitle', { name: selectedRecord?.displayName ?? '' }) }} />
            </DialogDescription>
          </DialogHeader>
          {relatedLoading ? (
            <div className="py-8 text-center text-muted-foreground">{t('recycleBin.list.loading')}</div>
          ) : relatedData ? (
            <div className="space-y-4">
              {Object.entries(relatedData.summary).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between p-2 bg-muted/40 rounded">
                  <EntityBadge entityType={type.toUpperCase().replace('_COUNT', '')} />
                  <Badge variant="secondary">{count}</Badge>
                </div>
              ))}
              {relatedData.relatedRecords.length > 0 && (
                <div className="max-h-64 overflow-y-auto space-y-2">
                  {relatedData.relatedRecords.map(r => (
                    <div key={r.id} className="flex items-center justify-between p-2 border rounded text-sm">
                      <div>
                        <EntityBadge entityType={r.entityType} />
                        <span className="ms-2">{r.displayName}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{formatDate(r.deletedAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRelatedDialog(false)}>{t('recycleBin.list.close')}</Button>
            {selectedRecord?.canRestoreWithRelated && (
              <Button onClick={() => { setShowRelatedDialog(false); openRestore(selectedRecord!, true); }}>
                <RotateCcw className="w-4 h-4 me-2" />
                {t('recycleBin.list.restoreWithRelatedBtn')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Restore Dialog ───────────────────────────────────────────────── */}
      <Dialog open={showRestoreDialog} onOpenChange={setShowRestoreDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {restoreWithRelated ? t('recycleBin.list.restoreWithRelatedTitle') : t('recycleBin.list.restoreTitle')}
            </DialogTitle>
            <DialogDescription>
              {restoreWithRelated
                ? t('recycleBin.list.restoreWithRelatedSubtitle', { name: restoreTarget?.displayName ?? '' })
                : t('recycleBin.list.restoreSubtitle', { name: restoreTarget?.displayName ?? '' })}
            </DialogDescription>
          </DialogHeader>
          {restoreWithRelated && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-800"
              dangerouslySetInnerHTML={{ __html: t('recycleBin.list.restoreNote') }} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRestoreDialog(false)}>{tc('actions.cancel')}</Button>
            <Button onClick={executeRestore} disabled={restoreLoading}>
              {restoreLoading ? t('recycleBin.list.restoring') : (
                <><RotateCcw className="w-4 h-4 me-2" />{t('recycleBin.list.restoreBtn')}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Hard Delete Confirm Dialog ───────────────────────────────────── */}
      <Dialog open={showHardDeleteDialog} onOpenChange={open => { if (!open) { setShowHardDeleteDialog(false); setHardDeleteTarget(null); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              {t('recycleBin.list.hardDeleteHeader')}
            </DialogTitle>
            <DialogDescription asChild>
              <span dangerouslySetInnerHTML={{ __html: t('recycleBin.list.hardDeleteBody', { name: hardDeleteTarget?.displayName ?? '' }) }} />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowHardDeleteDialog(false); setHardDeleteTarget(null); }}>
              {t('recycleBin.list.cancel')}
            </Button>
            <Button variant="destructive" disabled={hardDeleteLoading} onClick={executeHardDelete}>
              {hardDeleteLoading ? t('recycleBin.list.deleting') : t('recycleBin.list.deletePermanently')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
