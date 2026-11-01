import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Plus, Settings, Pencil, Trash2, Save, ArrowLeft, Search,
  ArrowUp, ArrowDown, ArrowUpDown, Columns2, Check, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Badge } from '../../components/ui/badge';
import { vehiclesApi } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';

type MType = {
  id: string; name: string; description?: string;
  defaultIntervalDays?: number; defaultIntervalKm?: number; isActive: boolean;
};
type MForm = { name: string; description: string; defaultIntervalDays: string; defaultIntervalKm: string };
const EMPTY_FORM: MForm = { name: '', description: '', defaultIntervalDays: '', defaultIntervalKm: '' };

// ── Column visibility ───────────────────────────────────────────────────────
type ColKey = 'name' | 'description' | 'days' | 'km' | 'active';
const ALL_COLUMNS: { key: ColKey; labelKey: string }[] = [
  { key: 'name',        labelKey: 'vehicles.maintTypes.list.cols.name' },
  { key: 'description', labelKey: 'vehicles.maintTypes.list.cols.description' },
  { key: 'days',        labelKey: 'vehicles.maintTypes.list.cols.days' },
  { key: 'km',          labelKey: 'vehicles.maintTypes.list.cols.km' },
  { key: 'active',      labelKey: 'vehicles.maintTypes.list.cols.active' },
];
const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  name: true, description: true, days: true, km: true,
  active: false,
};
const STORAGE_KEY = 'maintenance-types-table-columns';

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...DEFAULT_VISIBLE, ...JSON.parse(saved) } : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

type SortField = ColKey;
type SortOrder = 'asc' | 'desc';

export function MaintenanceTypesList() {
  const { t } = useTranslation('common');
  const { t: tp } = useTranslation('pages');
  const { canCreate } = usePermissions();
  const canWrite = canCreate('vehicles');
  const navigate = useNavigate();

  const [types, setTypes]     = useState<MType[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog]   = useState(false);
  const [editing, setEditing] = useState<MType | null>(null);
  const [form, setForm]       = useState<MForm>(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);

  // Filters
  const [search, setSearch]             = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [minDays, setMinDays]           = useState('');
  const [maxDays, setMaxDays]           = useState('');
  const [minKm, setMinKm]               = useState('');
  const [maxKm, setMaxKm]               = useState('');

  // Sort
  const [sortBy, setSortBy]       = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
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

  const load = useCallback(async () => {
    setLoading(true);
    try { setTypes(await vehiclesApi.listMaintenanceTypes()); }
    catch { toast.error(t('toast.loadFailed')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew  = () => { setEditing(null); setForm(EMPTY_FORM); setDialog(true); };
  const openEdit = (t: MType) => {
    setEditing(t);
    setForm({
      name: t.name,
      description: t.description ?? '',
      defaultIntervalDays: t.defaultIntervalDays ? String(t.defaultIntervalDays) : '',
      defaultIntervalKm:   t.defaultIntervalKm   ? String(t.defaultIntervalKm)   : '',
    });
    setDialog(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error(t('toast.nameRequired')); return; }
    clearFieldErrors();
    setSaving(true);
    try {
      const data: any = {
        name: form.name.trim(),
        description: form.description || undefined,
        defaultIntervalDays: form.defaultIntervalDays ? parseInt(form.defaultIntervalDays) : undefined,
        defaultIntervalKm:   form.defaultIntervalKm   ? parseInt(form.defaultIntervalKm)   : undefined,
      };
      if (editing) {
        await vehiclesApi.updateMaintenanceType(editing.id, data);
        toast.success(t('toast.updated'));
      } else {
        await vehiclesApi.createMaintenanceType(data);
        toast.success(t('toast.created'));
      }
      setDialog(false);
      load();
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('toast.saveFailed')));
    }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirm({
      title: t('confirm.deactivateMaintenanceTypeTitle'),
      description: t('confirm.deactivateMaintenanceTypeBody'),
      confirmText: t('confirm.deactivateConfirm'),
      tone: 'destructive',
    }))) return;
    try { await vehiclesApi.deleteMaintenanceType(id); toast.success(t('toast.deleted')); load(); }
    catch { toast.error(t('toast.deleteFailed')); }
  };

  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();
  const set = (k: keyof MForm, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (fieldErrs[k as string]) clearError(k as string);
  };

  const displayTypes = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = types.filter(t => {
      const matchesSearch = !q
        || t.name.toLowerCase().includes(q)
        || (t.description ?? '').toLowerCase().includes(q);
      const matchesActive =
        activeFilter === 'all'
        || (activeFilter === 'active' && t.isActive)
        || (activeFilter === 'inactive' && !t.isActive);
      const days = t.defaultIntervalDays ?? null;
      const matchesMinDays = !minDays || (days != null && days >= Number(minDays));
      const matchesMaxDays = !maxDays || (days != null && days <= Number(maxDays));
      const km = t.defaultIntervalKm ?? null;
      const matchesMinKm = !minKm || (km != null && km >= Number(minKm));
      const matchesMaxKm = !maxKm || (km != null && km <= Number(maxKm));
      return matchesSearch && matchesActive && matchesMinDays && matchesMaxDays && matchesMinKm && matchesMaxKm;
    });
    return [...filtered].sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortBy) {
        case 'name':        aVal = a.name.toLowerCase();                  bVal = b.name.toLowerCase(); break;
        case 'description': aVal = (a.description ?? '').toLowerCase();   bVal = (b.description ?? '').toLowerCase(); break;
        case 'days':        aVal = a.defaultIntervalDays ?? -Infinity;    bVal = b.defaultIntervalDays ?? -Infinity; break;
        case 'km':          aVal = a.defaultIntervalKm ?? -Infinity;      bVal = b.defaultIntervalKm ?? -Infinity; break;
        case 'active':      aVal = a.isActive ? 1 : 0;                    bVal = b.isActive ? 1 : 0; break;
        default:            aVal = ''; bVal = '';
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [types, search, activeFilter, minDays, maxDays, minKm, maxKm, sortBy, sortOrder]);

  const hasFilters = !!(search || activeFilter !== 'all' || minDays || maxDays || minKm || maxKm);
  const clearFilters = () => {
    setSearch(''); setActiveFilter('all'); setMinDays(''); setMaxDays(''); setMinKm(''); setMaxKm('');
  };

  const SortableHead = ({ label, field, className }: { label: string; field: SortField; className?: string }) => {
    const active = sortBy === field;
    return (
      <TableHead className={className}>
        <button onClick={() => handleSort(field)} className="flex items-center gap-1 hover:text-foreground font-medium group">
          {label}
          {active
            ? sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-primary" /> : <ArrowDown className="w-3 h-3 text-primary" />
            : <ArrowUpDown className="w-3 h-3 opacity-30 group-hover:opacity-60" />}
        </button>
      </TableHead>
    );
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Settings className="w-6 h-6 text-primary" />
              Maintenance Types
            </h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{tp('vehicles.maintTypes.subtitle')}</p>
        </div>
        {canWrite && (
          <Button size="sm" onClick={openNew}>
            <Plus className="w-4 h-4 me-2" /> Add Type
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search name or description…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="ps-9"
              />
            </div>
            <Select value={activeFilter} onValueChange={v => setActiveFilter(v as any)}>
              <SelectTrigger className="w-40"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tp('vehicles.maintTypes.filterAllStatuses')}</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>

            {/* Column picker */}
            <div className="relative ms-auto" ref={colPickerRef}>
              <Button
                variant="outline" size="sm"
                onClick={() => setShowColPicker(v => !v)}
                className={showColPicker ? 'border-primary text-primary' : ''}
              >
                <Columns2 className="w-4 h-4 me-1.5" />Columns
                {hiddenCount > 0 && (
                  <span className="ms-1.5 bg-primary text-primary-foreground text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                    {hiddenCount}
                  </span>
                )}
              </Button>
              {showColPicker && (
                <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[200px]">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{tp('vehicles.maintTypes.toggleCols')}</p>
                  <div className="space-y-0.5 max-h-72 overflow-y-auto">
                    {ALL_COLUMNS.map(c => (
                      <button
                        key={c.key}
                        onClick={() => toggleColumn(c.key)}
                        className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 text-sm text-start"
                      >
                        <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${visibleColumns[c.key] ? 'bg-primary border-primary' : 'border-gray-300'}`}>
                          {visibleColumns[c.key] && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                        </span>
                        {tp(c.labelKey)}
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
                    >{tp('vehicles.maintTypes.showAll')}</button>
                    <span className="text-gray-300">|</span>
                    <button
                      onClick={() => {
                        setVisibleColumns(DEFAULT_VISIBLE);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_VISIBLE));
                      }}
                      className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5"
                    >Reset</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Days</span>
              <Input type="number" min={0} placeholder="min" value={minDays} onChange={e => setMinDays(e.target.value)} className="w-24" />
              <span className="text-xs text-muted-foreground">–</span>
              <Input type="number" min={0} placeholder="max" value={maxDays} onChange={e => setMaxDays(e.target.value)} className="w-24" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground whitespace-nowrap">km</span>
              <Input type="number" min={0} placeholder="min" value={minKm} onChange={e => setMinKm(e.target.value)} className="w-28" />
              <span className="text-xs text-muted-foreground">–</span>
              <Input type="number" min={0} placeholder="max" value={maxKm} onChange={e => setMaxKm(e.target.value)} className="w-28" />
            </div>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="w-3 h-3 me-1" />Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {col('name')        && <SortableHead label="Name"            field="name" />}
                {col('description') && <SortableHead label="Description"     field="description" />}
                {col('days')        && <SortableHead label="Interval (Days)" field="days" />}
                {col('km')          && <SortableHead label="Interval (km)"   field="km" />}
                {col('active')      && <SortableHead label="Status"          field="active" />}
                {canWrite && <TableHead className="text-end">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
              {loading ? (
                <TableRow><TableCell colSpan={visibleCount + (canWrite ? 1 : 0)} className="text-center py-8 text-muted-foreground">{t('states.loading')}</TableCell></TableRow>
              ) : displayTypes.length === 0 ? (
                <TableRow><TableCell colSpan={visibleCount + (canWrite ? 1 : 0)} className="text-center py-8 text-muted-foreground">{tp('vehicles.maintTypes.empty')}</TableCell></TableRow>
              ) : displayTypes.map((t) => (
                <TableRow key={t.id}>
                  {col('name')        && <TableCell className="font-medium">{t.name}</TableCell>}
                  {col('description') && <TableCell className="text-sm text-muted-foreground">{t.description ?? '—'}</TableCell>}
                  {col('days')        && <TableCell className="text-sm">{t.defaultIntervalDays ? `${t.defaultIntervalDays} days` : '—'}</TableCell>}
                  {col('km')          && <TableCell className="text-sm">{t.defaultIntervalKm ? `${t.defaultIntervalKm.toLocaleString()} km` : '—'}</TableCell>}
                  {col('active') && (
                    <TableCell>
                      {t.isActive
                        ? <Badge className="bg-emerald-500 text-white">Active</Badge>
                        : <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>}
                    </TableCell>
                  )}
                  {canWrite && (
                    <TableCell className="text-end space-x-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(t)}><Pencil className="w-4 h-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => handleDelete(t.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Edit Maintenance Type' : 'Add Maintenance Type'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <ValidationSummary errors={fieldErrs} />
            <div className="space-y-1">
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Oil Change"
                aria-invalid={!!fieldErrs.name}
                className={fieldErrs.name ? 'border-red-500 focus-visible:ring-red-500' : ''} />
              <FieldError errors={fieldErrs} name="name" />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Optional description" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Default Interval (days)</Label>
                <Input type="number" value={form.defaultIntervalDays} onChange={(e) => set('defaultIntervalDays', e.target.value)} placeholder="e.g. 365" min={1} />
              </div>
              <div className="space-y-1">
                <Label>Default Interval (km)</Label>
                <Input type="number" value={form.defaultIntervalKm} onChange={(e) => set('defaultIntervalKm', e.target.value)} placeholder="e.g. 10000" min={1} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(false)}>{t('actions.cancel')}</Button>
            <Button onClick={handleSave} disabled={saving}>
              <Save className="w-4 h-4 me-2" />
              {saving ? t('states.saving') : editing ? t('actions.saveChanges') : t('actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
