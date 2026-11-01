import { useState, useEffect, useMemo, useRef } from 'react';
import { useColumnWidths, ResizeHandle } from '../../hooks/useColumnWidths';

const AGENCIES_COL_DEFAULTS = {
  name: 200, country: 130, contactPerson: 170, email: 200, phone: 140,
  status: 120, createdAt: 110, actions: 200,
};
import { Link } from 'react-router';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { useTranslation } from 'react-i18next';
import {
  Plus, Eye, Edit, Trash2, Search,
  ArrowUp, ArrowDown, ArrowUpDown, Columns2, Check, X,
} from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { agenciesApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { FilterSystem, Column, FilterRule, FilterPreset } from '../../components/filters/FilterSystem';
import { usePermissions } from '../../hooks/usePermissions';
import { formatDate } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';

const agencyColumns: Column[] = [
  { id: 'name', label: 'Agency Name', type: 'text' },
  { id: 'country', label: 'Country', type: 'text' },
  { id: 'contactPerson', label: 'Contact Person', type: 'text' },
  { id: 'email', label: 'Email', type: 'text' },
  { id: 'status', label: 'Status', type: 'enum', options: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] },
];

// ── Column visibility ───────────────────────────────────────────────────────
type ColKey = 'name' | 'country' | 'contactPerson' | 'email' | 'phone' | 'status' | 'createdAt';
const ALL_COLUMNS: { key: ColKey; labelKey: string; defaultLabel?: string }[] = [
  { key: 'name',          labelKey: 'agencies.list.cols.name' },
  { key: 'country',       labelKey: 'agencies.list.cols.country' },
  { key: 'contactPerson', labelKey: 'agencies.list.cols.contactPerson' },
  { key: 'email',         labelKey: 'agencies.list.cols.email' },
  { key: 'phone',         labelKey: 'agencies.list.cols.phone' },
  { key: 'status',        labelKey: 'agencies.list.cols.status' },
  { key: 'createdAt',     labelKey: 'agencies.list.cols.createdAt', defaultLabel: 'Created' },
];
const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  name: true, country: true, contactPerson: true, email: true, phone: true, status: true,
  createdAt: true,
};
const STORAGE_KEY = 'agencies-table-columns';

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

const useStatusBadge = () => {
  const { t: tc } = useTranslation('common');
  const { t } = useTranslation('pages');
  return (status: string) => {
    switch (status) {
      case 'ACTIVE': return <Badge className="bg-[#22C55E]">{tc('filters.active')}</Badge>;
      case 'INACTIVE': return <Badge className="bg-gray-500">{tc('filters.inactive')}</Badge>;
      case 'SUSPENDED': return <Badge className="bg-[#EF4444]">{t('agencies.add.suspended', { defaultValue: 'Suspended' })}</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };
};

export function AgenciesList() {
  const { canCreate, canEdit, canDelete } = usePermissions();
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const getStatusBadge = useStatusBadge();
  const [agencies, setAgencies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const tenantVersion = useTenantSyncVersion();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenant = useSuperUserTenantFilter();
  const { headStyle, startResize } = useColumnWidths('agencies-col-widths-v1', AGENCIES_COL_DEFAULTS);
  // SUPER-only "Assign all unassigned to tenant" bulk action.
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [assignTenantId, setAssignTenantId] = useState<string>('');
  const [assigning, setAssigning] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [contactFilter, setContactFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [phoneFilter, setPhoneFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [activeFilters, setActiveFilters] = useState<FilterRule[]>([]);
  const [filterLogic, setFilterLogic] = useState<'AND' | 'OR'>('AND');
  const [savedPresets, setSavedPresets] = useState<FilterPreset[]>([]);

  // Sort state
  const [sortBy, setSortBy] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const handleSort = (f: SortField) => {
    if (sortBy === f) setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSortBy(f); setSortOrder('asc'); }
  };

  // Column visibility
  const [visibleColumns, setVisibleColumns] = useState<Record<ColKey, boolean>>(loadVisibleColumns);
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const col = (key: ColKey) => visibleColumns[key];
  const hiddenCount  = ALL_COLUMNS.filter(c => !visibleColumns[c.key]).length;
  const visibleCount = ALL_COLUMNS.filter(c =>  visibleColumns[c.key]).length;

  const handleDelete = async (agency: any) => {
    if (!(await confirm({
      title: t('agencies.list.deleteTitle'),
      description: t('agencies.list.deleteBody', { name: agency.name }),
      confirmText: tc('actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await agenciesApi.delete(agency.id);
      setAgencies(prev => prev.filter(a => a.id !== agency.id));
      toast.success(t('agencies.list.deleteSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('agencies.list.deleteFailed')));
    }
  };

  const reload = () => {
    setLoading(true);
    const params = tenant.applyToParams({ limit: 100 });
    agenciesApi.list(params)
      .then((res: any) => setAgencies(res?.data ?? res ?? []))
      .catch(() => setAgencies([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantVersion, tenant.tenantFilter]);

  const applyFilters = (agency: any) => {
    if (activeFilters.length === 0) return true;
    const results = activeFilters.map(filter => {
      const value = (agency[filter.columnId] ?? '').toString();
      switch (filter.operator) {
        case 'contains': return value.toLowerCase().includes(filter.value.toLowerCase());
        case 'equals': return value.toLowerCase() === filter.value.toLowerCase();
        case 'startsWith': return value.toLowerCase().startsWith(filter.value.toLowerCase());
        case 'endsWith': return value.toLowerCase().endsWith(filter.value.toLowerCase());
        default: return true;
      }
    });
    return filterLogic === 'AND' ? results.every(r => r) : results.some(r => r);
  };

  const countryOptions = useMemo(
    () => Array.from(new Set(agencies.map(a => a.country).filter(Boolean))).sort() as string[],
    [agencies]
  );

  const displayAgencies = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const filtered = agencies.filter(agency => {
      const matchesSearch = !q
        || (agency.name ?? '').toLowerCase().includes(q)
        || (agency.country ?? '').toLowerCase().includes(q);
      const matchesStatus = statusFilter === 'all' || agency.status === statusFilter;
      const matchesCountry = countryFilter === 'all' || agency.country === countryFilter;
      const matchesContact = !contactFilter || (agency.contactPerson ?? '').toLowerCase().includes(contactFilter.toLowerCase());
      const matchesEmail = !emailFilter || (agency.email ?? '').toLowerCase().includes(emailFilter.toLowerCase());
      const matchesPhone = !phoneFilter || (agency.phone ?? '').toLowerCase().includes(phoneFilter.toLowerCase());
      let matchesDate = true;
      if (dateFrom || dateTo) {
        const from = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
        const to   = dateTo   ? new Date(dateTo + 'T23:59:59').getTime() : Infinity;
        const t = agency.createdAt ? new Date(agency.createdAt).getTime() : 0;
        matchesDate = t >= from && t <= to;
      }
      return matchesSearch && matchesStatus && matchesCountry && matchesContact
        && matchesEmail && matchesPhone && matchesDate && applyFilters(agency);
    });

    return [...filtered].sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortBy) {
        case 'name':          aVal = (a.name ?? '').toLowerCase();          bVal = (b.name ?? '').toLowerCase(); break;
        case 'country':       aVal = (a.country ?? '').toLowerCase();       bVal = (b.country ?? '').toLowerCase(); break;
        case 'contactPerson': aVal = (a.contactPerson ?? '').toLowerCase(); bVal = (b.contactPerson ?? '').toLowerCase(); break;
        case 'email':         aVal = (a.email ?? '').toLowerCase();         bVal = (b.email ?? '').toLowerCase(); break;
        case 'phone':         aVal = (a.phone ?? '').toLowerCase();         bVal = (b.phone ?? '').toLowerCase(); break;
        case 'status':        aVal = a.status ?? '';                         bVal = b.status ?? ''; break;
        case 'createdAt':     aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                              bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0; break;
        default:              aVal = ''; bVal = '';
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [agencies, searchQuery, statusFilter, countryFilter, contactFilter,
      emailFilter, phoneFilter, dateFrom, dateTo,
      activeFilters, filterLogic, sortBy, sortOrder]);

  const hasExtraFilters = countryFilter !== 'all' || contactFilter || emailFilter || phoneFilter || dateFrom || dateTo;
  const clearExtraFilters = () => {
    setCountryFilter('all'); setContactFilter(''); setEmailFilter('');
    setPhoneFilter(''); setDateFrom(''); setDateTo('');
  };

  const SortableHead = ({ label, field, colKey }: { label: string; field: SortField; colKey?: string }) => {
    const active = sortBy === field;
    return (
      <TableHead className="relative whitespace-normal align-top" style={colKey ? headStyle(colKey) : undefined}>
        <button onClick={() => handleSort(field)} className="flex items-center gap-1 hover:text-foreground font-medium group text-start break-words">
          <span className="break-words">{label}</span>
          {active
            ? sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-primary shrink-0" /> : <ArrowDown className="w-3 h-3 text-primary shrink-0" />
            : <ArrowUpDown className="w-3 h-3 opacity-30 group-hover:opacity-60 shrink-0" />}
        </button>
        {colKey && <ResizeHandle onMouseDown={(e) => startResize(colKey, e)} />}
      </TableHead>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('agencies.list.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('agencies.list.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {tenant.isPlatformSuper && (() => {
            const unassignedCount = agencies.filter(a => !a.tenantId).length;
            if (unassignedCount === 0) return null;
            return (
              <Button
                variant="outline"
                onClick={() => {
                  setAssignTenantId(tenant.tenantFilter || '');
                  setShowAssignDialog(true);
                }}
              >
                Assign {unassignedCount} unassigned to tenant…
              </Button>
            );
          })()}
          {canCreate('agencies') && (
            <Button asChild>
              <Link to="/dashboard/agencies/add">
                <Plus className="w-4 h-4 me-2" />
                {t('agencies.list.addButton')}
              </Link>
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={t('agencies.list.search')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ps-9"
              />
            </div>
            {tenant.isPlatformSuper && (
              <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
            )}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder={t('agencies.list.allStatus')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('agencies.list.allStatus')}</SelectItem>
                <SelectItem value="ACTIVE">{tc('filters.active')}</SelectItem>
                <SelectItem value="INACTIVE">{tc('filters.inactive')}</SelectItem>
                <SelectItem value="SUSPENDED">{t('agencies.add.suspended', { defaultValue: 'Suspended' })}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={countryFilter} onValueChange={setCountryFilter}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder={t('agencies.list.allCountries')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('agencies.list.allCountries')}</SelectItem>
                {countryOptions.map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FilterSystem
              columns={agencyColumns}
              activeFilters={activeFilters}
              onFiltersChange={setActiveFilters}
              filterLogic={filterLogic}
              onLogicChange={setFilterLogic}
              savedPresets={savedPresets}
              onSavePreset={(name, rules, logic) => setSavedPresets(prev => [...prev, { id: Date.now().toString(), name, rules, logic }])}
              onLoadPreset={(preset) => { setActiveFilters(preset.rules); setFilterLogic(preset.logic); }}
              onDeletePreset={(id) => setSavedPresets(prev => prev.filter(p => p.id !== id))}
            />
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Input
              placeholder={t('agencies.list.contactContains')}
              value={contactFilter}
              onChange={e => setContactFilter(e.target.value)}
              className="w-52"
            />
            <Input
              placeholder={t('agencies.list.emailContains')}
              value={emailFilter}
              onChange={e => setEmailFilter(e.target.value)}
              className="w-48"
            />
            <Input
              placeholder={t('agencies.list.phoneContains')}
              value={phoneFilter}
              onChange={e => setPhoneFilter(e.target.value)}
              className="w-44"
            />
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{t('agencies.list.createdFrom')}</span>
              <DateInput value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36" />
              <span className="text-xs text-muted-foreground">{t('agencies.list.createdTo')}</span>
              <DateInput value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36" />
            </div>
            {hasExtraFilters && (
              <Button variant="ghost" size="sm" onClick={clearExtraFilters}>
                <X className="w-3 h-3 me-1" />{tc('actions.clearAll')}
              </Button>
            )}
            <div className="ms-auto relative" ref={colPickerRef}>
              <Button
                variant="outline" size="sm"
                onClick={() => setShowColPicker(v => !v)}
                className={showColPicker ? 'border-primary text-primary' : ''}
              >
                <Columns2 className="w-4 h-4 me-1.5" />{t('agencies.list.columns')}
                {hiddenCount > 0 && (
                  <span className="ms-1.5 bg-primary text-primary-foreground text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                    {hiddenCount}
                  </span>
                )}
              </Button>
              {showColPicker && (
                <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[200px]">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{t('agencies.list.toggleColumns')}</p>
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
                        {t(c.labelKey, { defaultValue: c.defaultLabel ?? c.labelKey })}
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
                    >{t('agencies.list.showAll')}</button>
                    <span className="text-gray-300">|</span>
                    <button
                      onClick={() => {
                        setVisibleColumns(DEFAULT_VISIBLE);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_VISIBLE));
                      }}
                      className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5"
                    >{t('agencies.list.reset')}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="border rounded-lg overflow-x-auto">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  {col('name')          && <SortableHead colKey="name"          label={t('agencies.list.tableHeaders.agency')}    field="name" />}
                  {col('country')       && <SortableHead colKey="country"       label={t('agencies.list.tableHeaders.country')}   field="country" />}
                  {col('contactPerson') && <SortableHead colKey="contactPerson" label={t('agencies.list.tableHeaders.contact')}   field="contactPerson" />}
                  {col('email')         && <SortableHead colKey="email"         label={t('agencies.list.tableHeaders.email')}     field="email" />}
                  {col('phone')         && <SortableHead colKey="phone"         label={t('agencies.list.tableHeaders.phone')}     field="phone" />}
                  {col('status')        && <SortableHead colKey="status"        label={t('agencies.list.tableHeaders.status')}    field="status" />}
                  {col('createdAt')     && <SortableHead colKey="createdAt"     label={t('agencies.list.tableHeaders.created')}   field="createdAt" />}
                  <TableHead className="text-end relative whitespace-normal align-top" style={headStyle('actions')}>{t('agencies.list.tableHeaders.actions')}<ResizeHandle onMouseDown={(e) => startResize('actions', e)} /></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
                {loading ? (
                  <TableRow><TableCell colSpan={visibleCount + 1} className="text-center py-8 text-muted-foreground">{t('agencies.list.loading')}</TableCell></TableRow>
                ) : displayAgencies.length === 0 ? (
                  <TableRow><TableCell colSpan={visibleCount + 1} className="text-center py-8 text-muted-foreground">{t('agencies.list.emptyShort')}</TableCell></TableRow>
                ) : displayAgencies.map((agency) => (
                  <TableRow key={agency.id}>
                    {col('name')          && <TableCell className="font-medium">{agency.name}</TableCell>}
                    {col('country')       && <TableCell>{agency.country ?? '—'}</TableCell>}
                    {col('contactPerson') && <TableCell>{agency.contactPerson ?? '—'}</TableCell>}
                    {col('email')         && <TableCell className="text-sm">{agency.email ?? '—'}</TableCell>}
                    {col('phone')         && <TableCell className="text-sm text-muted-foreground">{agency.phone ?? '—'}</TableCell>}
                    {col('status')        && <TableCell>{getStatusBadge(agency.status)}</TableCell>}
                    {col('createdAt')     && <TableCell className="text-sm text-muted-foreground">{agency.createdAt ? formatDate(agency.createdAt) : '—'}</TableCell>}
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/dashboard/agencies/${agency.id}`}>
                            <Eye className="w-4 h-4 me-1" />
                            {tc('actions.view')}
                          </Link>
                        </Button>
                        {canEdit('agencies') && (
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/dashboard/agencies/${agency.id}/edit`}>
                              <Edit className="w-4 h-4" />
                            </Link>
                          </Button>
                        )}
                        {canDelete('agencies') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(agency)}
                            className="text-[#EF4444] hover:text-[#EF4444] hover:bg-[#FEF2F2]"
                          >
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
        </CardContent>
      </Card>

      {/* SUPER bulk action — pin every tenantId=null agency to the chosen tenant. */}
      <Dialog open={showAssignDialog} onOpenChange={(o) => { if (!o) setShowAssignDialog(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign unassigned agencies to a tenant</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <p className="text-muted-foreground">
              Every agency with no tenant (<strong>{agencies.filter(a => !a.tenantId).length}</strong> shown)
              will be stamped with the tenant you pick. Agencies that already have a tenant aren't touched.
            </p>
            <div className="space-y-1.5">
              <Label>Target tenant</Label>
              <Select value={assignTenantId || '__none__'} onValueChange={(v) => setAssignTenantId(v === '__none__' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Pick a tenant" /></SelectTrigger>
                <SelectContent>
                  {tenant.tenantOptions.map((to) => (
                    <SelectItem key={to.id} value={to.id}>{to.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAssignDialog(false)} disabled={assigning}>Cancel</Button>
            <Button
              onClick={async () => {
                if (!assignTenantId) { toast.error('Pick a target tenant'); return; }
                setAssigning(true);
                try {
                  const res = await agenciesApi.bulkAssignUnassignedTenant(assignTenantId);
                  toast.success(`Updated ${res.updated} ${res.updated === 1 ? 'agency' : 'agencies'}`);
                  setShowAssignDialog(false);
                  reload();
                } catch (err: any) {
                  toast.error(apiError(err, 'Bulk assign failed'));
                } finally {
                  setAssigning(false);
                }
              }}
              disabled={assigning || !assignTenantId}
            >
              {assigning ? 'Assigning…' : 'Assign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
