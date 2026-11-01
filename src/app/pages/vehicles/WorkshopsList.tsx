import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Plus, Wrench, Pencil, Trash2, X, Save, ArrowLeft, RefreshCw,
  ArrowUp, ArrowDown, ArrowUpDown, Columns2, Check,
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { vehiclesApi, tenantsApi, getCurrentUser } from '../../services/api';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { usePermissions } from '../../hooks/usePermissions';

type Workshop = {
  id: string; name: string; contactName?: string; phone?: string; email?: string;
  address?: string; city?: string; country?: string; notes?: string; isActive: boolean;
  tenantId?: string | null;
};

type WForm = Omit<Workshop, 'id' | 'isActive'> & { tenantId?: string };
const EMPTY_FORM: WForm = { name: '', contactName: '', phone: '', email: '', address: '', city: '', country: '', notes: '', tenantId: '' };

type SortField = 'name' | 'contact' | 'phone' | 'email' | 'city' | 'country' | 'createdAt';
type SortOrder = 'asc' | 'desc';

function SortableHead({ label, field, sortBy, sortOrder, onSort, className }: {
  label: string; field: SortField; sortBy: SortField | null; sortOrder: SortOrder;
  onSort: (f: SortField) => void; className?: string;
}) {
  const active = sortBy === field;
  return (
    <TableHead className={className}>
      <button
        className="flex items-center gap-1 hover:text-foreground transition-colors"
        onClick={() => onSort(field)}
      >
        {label}
        {active ? (sortOrder === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />) : <ArrowUpDown className="w-3.5 h-3.5 opacity-40" />}
      </button>
    </TableHead>
  );
}

type ColKey = 'contact' | 'phone' | 'email' | 'city' | 'country' | 'createdAt';

const ALL_COLUMNS: { key: ColKey; labelKey: string; defaultLabel?: string }[] = [
  { key: 'contact',   labelKey: 'vehicles.workshops.list.cols.contact' },
  { key: 'phone',     labelKey: 'vehicles.workshops.list.cols.phone' },
  { key: 'email',     labelKey: 'vehicles.workshops.list.cols.email' },
  { key: 'city',      labelKey: 'vehicles.workshops.list.cols.city' },
  { key: 'country',   labelKey: 'vehicles.workshops.list.cols.country' },
  { key: 'createdAt', labelKey: 'vehicles.workshops.list.cols.createdAt', defaultLabel: 'Created' },
];

const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  contact: true, phone: true, email: true, city: true, country: true, createdAt: true,
};

const LS_KEY = 'workshops-table-columns';

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_VISIBLE, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_VISIBLE };
}

export function WorkshopsList() {
  const { canCreate } = usePermissions();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenantVersion = useTenantSyncVersion();
  const tenant = useSuperUserTenantFilter();
  const canWrite = canCreate('vehicles');
  const navigate = useNavigate();
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');

  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [loading, setLoading]     = useState(true);
  const [dialog, setDialog]       = useState(false);
  const [editing, setEditing]     = useState<Workshop | null>(null);
  const [form, setForm]           = useState<WForm>(EMPTY_FORM);
  const [saving, setSaving]       = useState(false);

  // Phase 3.19 — SUPER PlatformAdmin tenant reassignment for workshops.
  const me = getCurrentUser();
  const isSuper = me?.platformAdmin?.level === 'SUPER';
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  useEffect(() => {
    if (!isSuper) return;
    tenantsApi.list({ limit: 200 })
      .then((res) => setTenantOptions(res.data.map((t) => ({ id: t.id, name: t.name, slug: t.slug }))))
      .catch(() => setTenantOptions([]));
  }, [isSuper]);

  // filters
  const [search, setSearch]           = useState('');
  const [cityFilter, setCityFilter]   = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // sort
  const [sortBy, setSortBy]       = useState<SortField | null>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // column visibility
  const [visibleCols, setVisibleCols]   = useState<Record<ColKey, boolean>>(loadVisibleColumns);
  const [showColPicker, setShowColPicker] = useState(false);
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();
  const colPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (colPickerRef.current && !colPickerRef.current.contains(e.target as Node)) {
        setShowColPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggleColumn = (key: ColKey) => {
    setVisibleCols((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const col = (key: ColKey) => visibleCols[key];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ws = await vehiclesApi.listWorkshops(tenant.applyToParams({}));
      setWorkshops(ws);
    } catch {
      toast.error(tc('toast.loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.tenantFilter, tenantVersion]);

  useEffect(() => { load(); }, [load]);

  // derived filter options
  const cityOptions = useMemo(() => {
    const s = new Set(workshops.map((w) => w.city).filter(Boolean) as string[]);
    return Array.from(s).sort();
  }, [workshops]);

  const countryOptions = useMemo(() => {
    const s = new Set(workshops.map((w) => w.country).filter(Boolean) as string[]);
    return Array.from(s).sort();
  }, [workshops]);

  const displayWorkshops = useMemo(() => {
    let list = [...workshops];

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((w) =>
        w.name.toLowerCase().includes(q) ||
        (w.contactName ?? '').toLowerCase().includes(q) ||
        (w.phone ?? '').toLowerCase().includes(q) ||
        (w.email ?? '').toLowerCase().includes(q) ||
        (w.city ?? '').toLowerCase().includes(q) ||
        (w.country ?? '').toLowerCase().includes(q)
      );
    }
    if (cityFilter)    list = list.filter((w) => w.city === cityFilter);
    if (countryFilter) list = list.filter((w) => w.country === countryFilter);
    if (statusFilter === 'active')   list = list.filter((w) => w.isActive);
    if (statusFilter === 'inactive') list = list.filter((w) => !w.isActive);

    if (sortBy) {
      list.sort((a, b) => {
        let av = '', bv = '';
        if (sortBy === 'name')    { av = a.name;               bv = b.name; }
        if (sortBy === 'contact') { av = a.contactName ?? '';  bv = b.contactName ?? ''; }
        if (sortBy === 'phone')   { av = a.phone ?? '';        bv = b.phone ?? ''; }
        if (sortBy === 'email')   { av = a.email ?? '';        bv = b.email ?? ''; }
        if (sortBy === 'city')    { av = a.city ?? '';         bv = b.city ?? ''; }
        if (sortBy === 'country') { av = a.country ?? '';      bv = b.country ?? ''; }
        if (sortBy === 'createdAt') { av = (a as any).createdAt ?? ''; bv = (b as any).createdAt ?? ''; }
        return sortOrder === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return list;
  }, [workshops, search, cityFilter, countryFilter, statusFilter, sortBy, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortBy === field) setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortOrder('asc'); }
  };

  const clearFilters = () => {
    setSearch(''); setCityFilter(''); setCountryFilter(''); setStatusFilter('');
  };

  const hasFilters = search || cityFilter || countryFilter || statusFilter;

  const visibleCount = ALL_COLUMNS.filter((c) => col(c.key)).length + 1 + (canWrite ? 1 : 0); // +1 name, +1 actions

  const openNew = () => { setEditing(null); setForm(EMPTY_FORM); setDialog(true); };
  const openEdit = (w: Workshop) => {
    setEditing(w);
    setForm({ name: w.name, contactName: w.contactName ?? '', phone: w.phone ?? '', email: w.email ?? '', address: w.address ?? '', city: w.city ?? '', country: w.country ?? '', notes: w.notes ?? '', tenantId: w.tenantId ?? '' });
    setDialog(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error(tc('toast.nameRequired')); return; }
    clearFieldErrors();
    setSaving(true);
    try {
      // Strip tenantId from the wire payload when the viewer isn't
      // SUPER — the backend already enforces this; this just keeps the
      // outgoing request tidy.
      const payload: any = { ...form };
      if (!isSuper) delete payload.tenantId;
      if (editing) {
        await vehiclesApi.updateWorkshop(editing.id, payload);
        toast.success(tc('toast.savedSuccessfully'));
      } else {
        await vehiclesApi.createWorkshop(payload);
        toast.success(tc('toast.savedSuccessfully'));
      }
      setDialog(false);
      load();
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirm({
      title: t('common:confirm.deleteWorkshopTitle'),
      description: t('common:confirm.deleteWorkshopBody'),
      confirmText: t('common:actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await vehiclesApi.deleteWorkshop(id);
      toast.success(tc('toast.deleted'));
      load();
    } catch {
      toast.error(tc('toast.deleteFailed'));
    }
  };

  const setField = (key: keyof WForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (fieldErrs[key as string]) clearError(key as string);
  };

  return (
    <div className="p-6 space-y-6">
      {/* header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Wrench className="w-6 h-6 text-primary" />
              {t('vehicles.workshops.title')}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{t('vehicles.workshops.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 me-2 ${loading ? 'animate-spin' : ''}`} /> {t('vehicles.workshops.refresh')}
          </Button>
          {canWrite && (
            <Button size="sm" onClick={openNew}>
              <Plus className="w-4 h-4 me-2" /> {t('vehicles.workshops.addButton')}
            </Button>
          )}
        </div>
      </div>

      {/* filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <Input
          placeholder={t('vehicles.workshops.searchPh')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
        {tenant.isPlatformSuper && (
          <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
        )}
        <Select value={cityFilter || '__all__'} onValueChange={(v) => setCityFilter(v === '__all__' ? '' : v)}>
          <SelectTrigger className="w-36"><SelectValue placeholder={t('vehicles.workshops.cityPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('vehicles.workshops.filterAllCities')}</SelectItem>
            {cityOptions.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={countryFilter || '__all__'} onValueChange={(v) => setCountryFilter(v === '__all__' ? '' : v)}>
          <SelectTrigger className="w-36"><SelectValue placeholder={t('vehicles.workshops.countryPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('vehicles.workshops.filterAllCountries')}</SelectItem>
            {countryOptions.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter || '__all__'} onValueChange={(v) => setStatusFilter(v === '__all__' ? '' : v)}>
          <SelectTrigger className="w-32"><SelectValue placeholder={t('vehicles.workshops.statusPlaceholder')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('vehicles.workshops.filterAllStatuses')}</SelectItem>
            <SelectItem value="active">{t('vehicles.workshops.statusActive')}</SelectItem>
            <SelectItem value="inactive">{t('vehicles.workshops.statusInactive')}</SelectItem>
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="w-3.5 h-3.5 me-1" /> {t('vehicles.workshops.clear')}
          </Button>
        )}

        {/* column picker */}
        <div className="relative ms-auto" ref={colPickerRef}>
          <Button variant="outline" size="sm" onClick={() => setShowColPicker((v) => !v)}>
            <Columns2 className="w-4 h-4 me-2" /> {t('vehicles.workshops.columnsButton')}
          </Button>
          {showColPicker && (
            <div className="absolute end-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-md p-2 w-44">
              {ALL_COLUMNS.map(({ key, labelKey, defaultLabel }) => (
                <button
                  key={key}
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-muted"
                  onClick={() => toggleColumn(key)}
                >
                  <span className={`w-4 h-4 border rounded flex items-center justify-center ${col(key) ? 'bg-primary border-primary' : 'border-input'}`}>
                    {col(key) && <Check className="w-3 h-3 text-primary-foreground" />}
                  </span>
                  {t(labelKey, { defaultValue: defaultLabel ?? labelKey })}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead label={t('vehicles.workshops.nameHeader')}     field="name"    sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                {col('contact') && <SortableHead label={t('vehicles.workshops.list.cols.contact')} field="contact" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                {col('phone')   && <SortableHead label={t('vehicles.workshops.list.cols.phone')}   field="phone"   sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                {col('email')   && <SortableHead label={t('vehicles.workshops.list.cols.email')}   field="email"   sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                {col('city')    && <SortableHead label={t('vehicles.workshops.list.cols.city')}    field="city"    sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                {col('country') && <SortableHead label={t('vehicles.workshops.list.cols.country')} field="country" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                {col('createdAt') && <SortableHead label={t('vehicles.workshops.list.cols.createdAt', { defaultValue: 'Created' })} field="createdAt" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                {canWrite && <TableHead className="text-end">{t('vehicles.workshops.actionsHeader')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
              {loading ? (
                <TableRow><TableCell colSpan={visibleCount} className="text-center py-8 text-muted-foreground">{tc('states.loading')}</TableCell></TableRow>
              ) : displayWorkshops.length === 0 ? (
                <TableRow><TableCell colSpan={visibleCount} className="text-center py-8 text-muted-foreground">
                  {hasFilters ? t('vehicles.workshops.emptyFiltered') : t('vehicles.workshops.empty')}
                </TableCell></TableRow>
              ) : displayWorkshops.map((w) => (
                <TableRow key={w.id} className={!w.isActive ? 'opacity-60' : ''}>
                  <TableCell className="font-medium">
                    {w.name}
                    {!w.isActive && <span className="ms-2 text-xs text-muted-foreground">{t('vehicles.workshops.inactive')}</span>}
                  </TableCell>
                  {col('contact') && <TableCell className="text-sm">{w.contactName ?? '—'}</TableCell>}
                  {col('phone')   && <TableCell className="text-sm">{w.phone ?? '—'}</TableCell>}
                  {col('email')   && <TableCell className="text-sm">{w.email ?? '—'}</TableCell>}
                  {col('city')    && <TableCell className="text-sm">{w.city ?? '—'}</TableCell>}
                  {col('country') && <TableCell className="text-sm">{w.country ?? '—'}</TableCell>}
                  {col('createdAt') && (
                    <TableCell className="text-sm whitespace-nowrap">
                      {(w as any).createdAt ? new Date((w as any).createdAt).toLocaleDateString() : '—'}
                    </TableCell>
                  )}
                  {canWrite && (
                    <TableCell className="text-end space-x-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(w)}><Pencil className="w-4 h-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => handleDelete(w.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? t('vehicles.workshops.dialog.editTitle') : t('vehicles.workshops.dialog.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <ValidationSummary errors={fieldErrs} />
            <div className="space-y-1">
              <Label>{t('vehicles.workshops.form.name')}</Label>
              <Input value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder={t('vehicles.workshops.form.namePh')}
                aria-invalid={!!fieldErrs.name}
                className={fieldErrs.name ? 'border-red-500 focus-visible:ring-red-500' : ''} />
              <FieldError errors={fieldErrs} name="name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('vehicles.workshops.form.contact')}</Label>
                <Input value={form.contactName} onChange={(e) => setField('contactName', e.target.value)} placeholder={t('vehicles.workshops.form.contactPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('vehicles.workshops.form.phone')}</Label>
                <Input value={form.phone} onChange={(e) => setField('phone', e.target.value)} placeholder={t('vehicles.workshops.form.phonePh')} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>{t('vehicles.workshops.form.email')}</Label>
                <Input type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} placeholder={t('vehicles.workshops.form.emailPh')} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>{t('vehicles.workshops.form.address')}</Label>
                <Input value={form.address} onChange={(e) => setField('address', e.target.value)} placeholder={t('vehicles.workshops.form.addressPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('vehicles.workshops.form.city')}</Label>
                <Input value={form.city} onChange={(e) => setField('city', e.target.value)} placeholder={t('vehicles.workshops.form.cityPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('vehicles.workshops.form.country')}</Label>
                <Input value={form.country} onChange={(e) => setField('country', e.target.value)} placeholder={t('vehicles.workshops.form.countryPh')} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>{t('vehicles.workshops.form.notes')}</Label>
                <Input value={form.notes} onChange={(e) => setField('notes', e.target.value)} placeholder={t('vehicles.workshops.form.notesPh')} />
              </div>
              {/* Phase 3.19 — SUPER PlatformAdmin only: assign workshop
                  to a specific tenant. "No tenant (global)" keeps the
                  legacy shared-catalogue behaviour. */}
              {isSuper && (
                <div className="col-span-2 space-y-1">
                  <Label>Tenant</Label>
                  <Select
                    value={form.tenantId || '__none__'}
                    onValueChange={(v) => setField('tenantId', v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger><SelectValue placeholder="Select tenant" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No tenant (global)</SelectItem>
                      {tenantOptions.map((tn) => (
                        <SelectItem key={tn.id} value={tn.id}>{tn.name} <span className="text-xs text-muted-foreground">/{tn.slug}</span></SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">SUPER PlatformAdmin only.</p>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(false)}>{tc('actions.cancel')}</Button>
            <Button onClick={handleSave} disabled={saving}>
              <Save className="w-4 h-4 me-2" />
              {saving ? tc('states.saving') : editing ? tc('actions.saveChanges') : tc('actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
