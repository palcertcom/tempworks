import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useColumnWidths, ResizeHandle } from '../../hooks/useColumnWidths';

const CANDIDATES_COL_DEFAULTS = {
  select: 40, candidate: 220, tenant: 140, contact: 220, nationality: 130,
  appliedPosition: 180, passportNumber: 150, birthDate: 110, age: 80,
  gender: 100, agency: 160, applied: 110, source: 130, status: 130, actions: 200,
};
import { useTranslation } from 'react-i18next';
import { applicantsApi, agenciesApi, settingsApi, documentsApi, workflowApi, resolveAssetUrl } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { getCurrentUser, getAccessToken } from '../../services/api';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { Link } from 'react-router';
import { Search, Plus, Eye, Edit, Download, Trash2, RefreshCw, ArrowUp, ArrowDown, ArrowUpDown, X, Columns2, Check, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { exportRecordsAsPdfZip, safeFilename } from '../../utils/bulkPdfExport';
import { buildApplicantPdfBlob } from '../../components/applicants/ApplicantPdfExport';
import { WhatsAppButton } from '../../components/WhatsAppButton';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { formatDate } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';
import { formatPhoneDisplay } from '../../data/phoneCodes';

const getStatusColor = (status: string) => {
  switch (status?.toUpperCase()) {
    case 'NEW': return 'bg-blue-100 text-blue-800';
    case 'SCREENING': return 'bg-yellow-100 text-yellow-800';
    case 'INTERVIEW': return 'bg-purple-100 text-purple-800';
    case 'OFFER': case 'ONBOARDING': case 'ACCEPTED': return 'bg-green-100 text-green-800';
    case 'REJECTED': case 'WITHDRAWN': return 'bg-red-100 text-red-800';
    default: return 'bg-gray-100 text-gray-800';
  }
};

const getTierColor = (tier: string) => {
  if (tier === 'CANDIDATE') return 'bg-emerald-100 text-emerald-800 border border-emerald-200';
  return 'bg-amber-100 text-amber-800 border border-amber-200';
};

const STATUSES = ['NEW', 'SCREENING', 'INTERVIEW', 'OFFER', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'ONBOARDING'];

type SortField = 'firstName' | 'email' | 'nationality' | 'jobType' | 'agency' | 'tier' | 'createdAt' | 'status' | 'tenant' | 'appliedPosition' | 'passportNumber' | 'gender' | 'source' | 'birthDate' | 'age';
type SortOrder = 'asc' | 'desc';

// ── Column visibility ────────────────────────────────────────────────────────
type ColKey =
  | 'contact' | 'nationality' | 'appliedPosition' | 'passportNumber'
  | 'birthDate' | 'age' | 'gender' | 'agency' | 'tier' | 'applied' | 'status' | 'source';

const ALL_COLUMNS: { key: ColKey; labelKey: string }[] = [
  { key: 'contact',         labelKey: 'applicants.list.cols.contact' },
  { key: 'nationality',     labelKey: 'applicants.list.cols.nationality' },
  { key: 'appliedPosition', labelKey: 'applicants.list.cols.appliedPosition' },
  { key: 'passportNumber',  labelKey: 'applicants.list.cols.passportNumber' },
  { key: 'birthDate',       labelKey: 'applicants.list.cols.birthDate' },
  { key: 'age',             labelKey: 'applicants.list.cols.age' },
  { key: 'gender',          labelKey: 'applicants.list.cols.gender' },
  { key: 'agency',          labelKey: 'applicants.list.cols.agency' },
  { key: 'tier',            labelKey: 'applicants.list.cols.tier' },
  { key: 'applied',         labelKey: 'applicants.list.cols.applied' },
  { key: 'source',          labelKey: 'applicants.list.cols.source' },
  { key: 'status',          labelKey: 'applicants.list.cols.status' },
];

const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  contact: true, nationality: true, appliedPosition: true,
  passportNumber: true, birthDate: false, age: false, gender: true,
  agency: true, tier: false, applied: true, source: true, status: true,
};

/** Age in whole years from a DOB string/Date. Returns null for missing /
 *  unparseable dates so the cell can show a '—' rather than an NaN. */
function calcAge(dob: string | Date | null | undefined): number | null {
  if (!dob) return null;
  const birth = typeof dob === 'string' ? new Date(dob) : dob;
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/** Passport number lives inside the applicationData JSON. */
function readPassportNumber(a: any): string {
  const raw = a?.applicationData?.passportNumber ?? a?.passportNumber ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function formatGender(g: string | null | undefined, tEnums: (k: string, opts?: any) => string): string {
  if (!g) return '';
  return tEnums(`gender.${g}`, { defaultValue: g });
}

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const saved = localStorage.getItem('candidates-table-columns-v3');
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

export function CandidatesList() {
  const { canCreate, canEdit, canDelete } = usePermissions();
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { t: tEnums } = useTranslation('enums');
  const currentUser = getCurrentUser();
  const isAgencyUser = currentUser?.role === 'Agency User' || currentUser?.role === 'Agency Manager';

  // ── Column visibility ──────────────────────────────────────────────────────
  const [visibleColumns, setVisibleColumns] = useState<Record<ColKey, boolean>>(loadVisibleColumns);
  const { headStyle, startResize } = useColumnWidths('candidates-col-widths-v1', CANDIDATES_COL_DEFAULTS);
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
      localStorage.setItem('candidates-table-columns-v3', JSON.stringify(next));
      return next;
    });
  };

  const col = (key: ColKey) => visibleColumns[key];

  // ── Filters ────────────────────────────────────────────────────────────────
  const [searchTerm, setSearchTerm]               = useState('');
  const [tierFilter]                              = useState<string>('CANDIDATE');
  const [statusFilter, setStatusFilter]           = useState<string>('');
  const [agencyFilter, setAgencyFilter]           = useState<string>('');
  const [nationalityFilter, setNationalityFilter] = useState<string>('');
  const [jobTypeFilter, setJobTypeFilter]         = useState<string>('');
  const [dateFrom, setDateFrom]                   = useState<string>('');
  const [dateTo, setDateTo]                       = useState<string>('');
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
  const [candidatesData, setCandidatesData] = useState<any[]>([]);
  const [totalCandidates, setTotalCandidates] = useState(0);
  const [loading, setLoading] = useState(true);
  const [agencies, setAgencies] = useState<any[]>([]);
  const [jobTypes, setJobTypes] = useState<any[]>([]);

  // ── Bulk actions ───────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkActionInProgress, setBulkActionInProgress] = useState(false);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string>('');

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = { page: 1, limit: 500 };
      if (searchTerm) params.search = searchTerm;
      if (tierFilter) params.tier = tierFilter;
      if (statusFilter) params.status = statusFilter;
      if (agencyFilter) params.agencyId = agencyFilter;
      if (nationalityFilter) params.nationality = nationalityFilter;
      if (jobTypeFilter) params.jobTypeId = jobTypeFilter;
      tenant.applyToParams(params);
      const result = await applicantsApi.list(params);
      setCandidatesData(result.data || []);
      setTotalCandidates(result.meta?.total || 0);
    } catch {
      setCandidatesData([]);
    } finally {
      setLoading(false);
    }
  }, [searchTerm, tierFilter, statusFilter, agencyFilter, nationalityFilter, jobTypeFilter, tenant.tenantFilter, tenant.isPlatformSuper, tenantVersion]);

  useEffect(() => {
    const timer = setTimeout(fetchCandidates, 300);
    return () => clearTimeout(timer);
  }, [fetchCandidates]);

  useEffect(() => {
    agenciesApi.list({ limit: 200 }).then((r: any) => setAgencies(r?.data ?? [])).catch(() => {});
    settingsApi.getJobTypes?.().then((jt: any) => setJobTypes(Array.isArray(jt) ? jt : [])).catch(() => {});
  }, []);

  // ── Sorted + date-filtered data ────────────────────────────────────────────
  const displayData = useMemo(() => {
    let data = candidatesData;
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
        case 'firstName':   aVal = `${a.firstName ?? ''} ${a.lastName ?? ''}`.toLowerCase(); bVal = `${b.firstName ?? ''} ${b.lastName ?? ''}`.toLowerCase(); break;
        case 'email':       aVal = a.email?.toLowerCase() ?? ''; bVal = b.email?.toLowerCase() ?? ''; break;
        case 'nationality': aVal = a.nationality?.toLowerCase() ?? ''; bVal = b.nationality?.toLowerCase() ?? ''; break;
        case 'jobType':     aVal = (typeof a.jobType === 'object' ? a.jobType?.name : a.jobType)?.toLowerCase() ?? ''; bVal = (typeof b.jobType === 'object' ? b.jobType?.name : b.jobType)?.toLowerCase() ?? ''; break;
        case 'agency':      aVal = a.agency?.name?.toLowerCase() ?? ''; bVal = b.agency?.name?.toLowerCase() ?? ''; break;
        case 'tier':        aVal = a.tier ?? ''; bVal = b.tier ?? ''; break;
        case 'createdAt':   aVal = a.createdAt ?? ''; bVal = b.createdAt ?? ''; break;
        case 'status':      aVal = a.status ?? ''; bVal = b.status ?? ''; break;
        case 'tenant':      aVal = tenant.resolveTenantName(a).toLowerCase(); bVal = tenant.resolveTenantName(b).toLowerCase(); break;
        case 'appliedPosition': aVal = (a.jobAd?.title ?? '').toLowerCase(); bVal = (b.jobAd?.title ?? '').toLowerCase(); break;
        case 'passportNumber':  aVal = (readPassportNumber(a) ?? '').toLowerCase(); bVal = (readPassportNumber(b) ?? '').toLowerCase(); break;
        case 'gender':      aVal = (a.gender ?? '').toLowerCase(); bVal = (b.gender ?? '').toLowerCase(); break;
        case 'source':      aVal = (a.applicationSource ?? '').toLowerCase(); bVal = (b.applicationSource ?? '').toLowerCase(); break;
        case 'birthDate':   aVal = a.dateOfBirth ?? ''; bVal = b.dateOfBirth ?? ''; break;
        case 'age':         aVal = calcAge(a.dateOfBirth) ?? -1; bVal = calcAge(b.dateOfBirth) ?? -1; break;
        default:            aVal = ''; bVal = '';
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatesData, sortBy, sortOrder, dateFrom, dateTo, tenant.tenantNameById]);

  const nationalityOptions = useMemo(() => {
    const all = candidatesData.map(a => a.nationality).filter(Boolean) as string[];
    return [...new Set(all)].sort();
  }, [candidatesData]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = async (applicant: any) => {
    if (!(await confirm({
      title: t('applicants.candidates.deleteTitle'),
      description: t('applicants.candidates.deleteBody', { name: `${applicant.firstName} ${applicant.lastName}` }),
      confirmText: tc('actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await applicantsApi.delete(applicant.id);
      setCandidatesData(prev => prev.filter(a => a.id !== applicant.id));
      setTotalCandidates(prev => prev - 1);
      setSelected(prev => { const n = new Set(prev); n.delete(applicant.id); return n; });
      toast.success(t('applicants.candidates.deleteSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('applicants.candidates.deleteFailed')));
    }
  };

  // ── Bulk selection ─────────────────────────────────────────────────────────
  const toggleSelect = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSelectAll = () => {
    if (selected.size === displayData.length) setSelected(new Set());
    else setSelected(new Set(displayData.map(a => a.id)));
  };

  // ── Bulk actions ───────────────────────────────────────────────────────────
  const handleBulkAction = async (action: string, value?: string, agencyId?: string) => {
    if (selected.size === 0) { toast.error(t('applicants.candidates.selectAtLeastOne')); return; }
    setBulkActionInProgress(true);
    try {
      const result = await applicantsApi.bulkAction({ ids: [...selected], action, value, agencyId });
      const failed = result.results?.filter((r: any) => !r.success) ?? [];
      if (failed.length === 0) toast.success(t('applicants.candidates.bulkAppliedCount', { count: selected.size }));
      else toast.warning(
        `Applied to ${selected.size - failed.length}, failed for ${failed.length}` +
          (failed[0]?.error ? ` (first error: ${failed[0].error})` : ''),
      );
      setSelected(new Set());
      await fetchCandidates();
    } catch (err: any) {
      toast.error(apiError(err, t('applicants.candidates.bulkActionFailed')));
    } finally {
      setBulkActionInProgress(false);
    }
  };

  // ── Bulk Convert to Employee dialog state ─────────────────────────────────
  // The backend derives address / licence / emergency contact from each
  // candidate's applicationData; the operator just picks the optional
  // responsible agency (or leaves it as-is) and confirms.
  const [showBulkConvertDialog, setShowBulkConvertDialog] = useState(false);
  const [bulkConvertAgencyId, setBulkConvertAgencyId] = useState<string>('');

  // Bulk "Connect to Workflow" — one shared dialog picks the
  // workflow and applies it to every selected candidate. Respects
  // the existing single-active-workflow and admin-only reassignment
  // rules per-candidate on the backend.
  const [showBulkWorkflowDialog, setShowBulkWorkflowDialog] = useState(false);
  const [bulkWorkflowId, setBulkWorkflowId] = useState<string>('');
  const [bulkWorkflowNotes, setBulkWorkflowNotes] = useState('');
  const [allWorkflows, setAllWorkflows] = useState<any[]>([]);
  const [bulkWorkflowInFlight, setBulkWorkflowInFlight] = useState(false);

  const handleBulkAssignWorkflow = async () => {
    if (!bulkWorkflowId) { toast.error(t('applicants.candidates.pickWorkflow')); return; }
    if (selected.size === 0) { toast.error(t('applicants.candidates.selectAtLeastOne')); return; }
    setBulkWorkflowInFlight(true);
    try {
      const res = await workflowApi.assignCandidatesBulk({
        candidateIds: [...selected],
        workflowId: bulkWorkflowId,
        notes: bulkWorkflowNotes.trim() || undefined,
      });
      const s = res?.summary ?? ({} as any);
      const bits = [
        `${s.assigned ?? 0} assigned`,
        s.reassigned ? `${s.reassigned} reassigned` : null,
        s.skipped_same_workflow ? `${s.skipped_same_workflow} already on this workflow` : null,
        s.forbidden ? `${s.forbidden} blocked (admin only)` : null,
        s.errors ? `${s.errors} errors` : null,
      ].filter(Boolean).join(' · ');
      if ((s.errors ?? 0) > 0 || (s.forbidden ?? 0) > 0) toast.warning(bits);
      else toast.success(bits || t('applicants.candidates.done'));
      setShowBulkWorkflowDialog(false);
      setBulkWorkflowId('');
      setBulkWorkflowNotes('');
      setSelected(new Set());
      await fetchCandidates();
    } catch (err: any) {
      toast.error(err?.message || 'Bulk assignment failed');
    } finally {
      setBulkWorkflowInFlight(false);
    }
  };

  // ── Bulk PDF Export ────────────────────────────────────────────────────────
  const [pdfExporting, setPdfExporting] = useState(false);
  const handleBulkPdfExport = async () => {
    if (selected.size === 0) {
      toast.error(t('applicants.toast.selectAtLeastOneCandidate'));
      return;
    }
    setPdfExporting(true);
    const tid = toast.loading(`Preparing ${selected.size} PDF${selected.size > 1 ? 's' : ''}...`);
    try {
      const ids = [...selected];
      const full = await Promise.all(ids.map(id => applicantsApi.get(id).catch(() => null)));
      const records = full.filter(Boolean) as any[];
      if (records.length === 0) {
        toast.error(t('applicants.toast.loadSelectedFailed'), { id: tid });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      await exportRecordsAsPdfZip({
        records,
        zipName: `Candidates_Profiles_${today}`,
        // Merge each candidate's uploaded documents into their PDF so
        // the bulk ZIP matches the single-profile download.
        buildBlob: async (rec) => {
          // The endpoint returns either an array or a PaginatedResponse
          // shape — handle both so the merge doesn't silently drop docs.
          const docsRes: any = await documentsApi.getByEntity('APPLICANT', rec.id).catch(() => []);
          const docs = Array.isArray(docsRes) ? docsRes : Array.isArray(docsRes?.data) ? docsRes.data : [];
          return buildApplicantPdfBlob(rec, docs);
        },
        filename: (rec) => {
          const name = safeFilename([rec.firstName, rec.lastName].filter(Boolean).join('_') || 'Candidate');
          const num = rec.candidateNumber || rec.leadNumber || rec.applicationNumber || rec.id;
          return `Candidate_${name}_${num}.pdf`;
        },
        onProgress: (done, total) => {
          toast.loading(`Generating PDFs... ${done}/${total}`, { id: tid });
        },
      });
      toast.success(tc('toast.exportedCount', { count: records.length }), { id: tid });
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.exportFailed_pdf')), { id: tid });
    } finally {
      setPdfExporting(false);
    }
  };

  // ── Excel Export ───────────────────────────────────────────────────────────
  // Streams the backend's .xlsx for the currently selected rows only.
  const handleExportExcel = () => {
    if (selected.size === 0) {
      toast.error(tc('toast.selectOneOrMoreToExport'));
      return;
    }
    const token = getAccessToken();
    const url = applicantsApi.exportExcel({ ids: Array.from(selected) });
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `candidates-selected-${Date.now()}.xlsx`;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(objectUrl);
      })
      .catch(() => toast.error(tc('toast.exportFailed')));
  };

  // ── Filters ────────────────────────────────────────────────────────────────
  const hasActiveFilters = searchTerm || statusFilter || agencyFilter || nationalityFilter || jobTypeFilter || dateFrom || dateTo;
  const clearFilters = () => { setSearchTerm(''); setStatusFilter(''); setAgencyFilter(''); setNationalityFilter(''); setJobTypeFilter(''); setDateFrom(''); setDateTo(''); };

  // ── Stats ──────────────────────────────────────────────────────────────────
  const candidates    = candidatesData.filter(a => a.tier === 'CANDIDATE');
  const acceptedCount = candidatesData.filter(a => a.status === 'ACCEPTED' || a.status === 'ONBOARDING').length;

  const colSpan = 2
    + ALL_COLUMNS.filter(c => {
        if (c.key === 'tier' && isAgencyUser) return false;
        return visibleColumns[c.key];
      }).length
    + (tenant.isPlatformSuper ? 1 : 0)
    + 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('applicants.candidates.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('applicants.candidates.subtitle')}</p>
        </div>
        {canCreate('applicants') && (
          <Button asChild>
            <Link to="/dashboard/applicants/add">
              <Plus className="w-4 h-4 me-2" />{t('applicants.list.addButton')}
            </Link>
          </Button>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{t('applicants.candidates.total')}</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-[#0F172A]">{totalCandidates}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{t('applicants.candidates.candidatesCard')}</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-emerald-600">{candidates.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{t('applicants.candidates.acceptedOnboarding')}</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-green-600">{acceptedCount}</div></CardContent>
        </Card>
      </div>

      {/* Bulk action toolbar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
          <span className="text-sm font-medium text-blue-800">{t('applicants.candidates.selected', { count: selected.size })}</span>
          <div className="flex gap-2 ms-auto">
            {!isAgencyUser && (
              <>
                <Button variant="outline" size="sm" disabled={bulkActionInProgress} onClick={() => handleBulkAction('STATUS_CHANGE', 'ACCEPTED')}>{t('applicants.candidates.markAccepted')}</Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkActionInProgress}
                  onClick={() => {
                    if (selected.size === 0) {
                      toast.error(t('applicants.toast.selectAtLeastOneCandidate'));
                      return;
                    }
                    setPendingStatus('');
                    setStatusModalOpen(true);
                  }}
                >{t('applicants.candidates.changeStatus')}</Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkActionInProgress}
                  onClick={async () => {
                    if (selected.size === 0) {
                      toast.error(t('applicants.toast.selectAtLeastOneCandidate'));
                      return;
                    }
                    // Lazy-load the workflows list the first time
                    // the dialog opens — the CandidatesList doesn't
                    // otherwise need it.
                    if (allWorkflows.length === 0) {
                      try {
                        const list = await workflowApi.list();
                        setAllWorkflows(Array.isArray(list) ? list : []);
                      } catch { /* toast handled below on save */ }
                    }
                    setBulkWorkflowId('');
                    setBulkWorkflowNotes('');
                    setShowBulkWorkflowDialog(true);
                  }}
                >{t('applicants.candidates.connectToWorkflow')}</Button>
                <Button
                  size="sm"
                  className="bg-[#22C55E] hover:bg-[#16a34a] text-white"
                  disabled={bulkActionInProgress}
                  onClick={() => {
                    if (selected.size === 0) {
                      toast.error(t('applicants.toast.selectAtLeastOneCandidate'));
                      return;
                    }
                    setBulkConvertAgencyId('');
                    setShowBulkConvertDialog(true);
                  }}
                >{t('applicants.candidates.convertToEmployees')}</Button>
              </>
            )}
            <Button variant="outline" size="sm" className="text-red-600" disabled={bulkActionInProgress} onClick={async () => {
              if (selected.size === 0) return;
              if (await confirm({
                title: t('applicants.candidates.deleteSelectedTitle'),
                description: t('applicants.candidates.deleteSelectedBody', { count: selected.size }),
                confirmText: tc('actions.delete'), tone: 'destructive',
              })) handleBulkAction('DELETE');
            }}>
              <Trash2 className="w-3 h-3 me-1" />{t('applicants.candidates.deleteSelected')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('applicants.candidates.clear')}</Button>
          </div>
        </div>
      )}

      {/* Table card */}
      <Card>
        <CardContent className="p-6">
          {/* Filter rows */}
          <div className="space-y-3 mb-6">
            {/* Row 1 */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-48 relative">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder={t('applicants.candidates.searchPh')} value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="ps-10" />
              </div>

              <Select value={statusFilter || '__all__'} onValueChange={v => setStatusFilter(v === '__all__' ? '' : v)}>
                <SelectTrigger className="w-40"><SelectValue placeholder={t('applicants.candidates.allStatuses')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('applicants.candidates.allStatuses')}</SelectItem>
                  {STATUSES.map(s => <SelectItem key={s} value={s}>{tEnums(`applicantStatus.${s}`, { defaultValue: s.replace(/_/g, ' ') })}</SelectItem>)}
                </SelectContent>
              </Select>

              {tenant.isPlatformSuper && (
                <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
              )}

              {!isAgencyUser && agencies.length > 0 && (
                <Select value={agencyFilter || '__all__'} onValueChange={v => setAgencyFilter(v === '__all__' ? '' : v)}>
                  <SelectTrigger className="w-44"><SelectValue placeholder={t('applicants.candidates.allAgencies')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">{t('applicants.candidates.allAgencies')}</SelectItem>
                    {agencies.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}

              <Button variant="outline" size="sm" onClick={fetchCandidates} disabled={loading}>
                <RefreshCw className={`w-4 h-4 me-1 ${loading ? 'animate-spin' : ''}`} />{tc('actions.refresh')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportExcel}
                disabled={selected.size === 0}
                title={selected.size === 0 ? t('applicants.candidates.exportExcelTitle') : undefined}
              >
                <Download className="w-4 h-4 me-2" />{t('applicants.candidates.exportToExcel')} ({selected.size})
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkPdfExport}
                disabled={selected.size === 0 || pdfExporting}
                title={selected.size === 0 ? t('applicants.candidates.exportPdfsTitle') : undefined}
              >
                {pdfExporting
                  ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  : <FileText className="w-4 h-4 me-2" />}
                {t('applicants.candidates.exportPdfs')} ({selected.size})
              </Button>

              {/* Column picker */}
              <div className="relative" ref={colPickerRef}>
                <Button
                  variant="outline" size="sm"
                  onClick={() => setShowColPicker(v => !v)}
                  className={showColPicker ? 'border-blue-500 text-blue-600' : ''}
                >
                  <Columns2 className="w-4 h-4 me-1.5" />{t('applicants.candidates.columns')}
                  {ALL_COLUMNS.filter(c => !visibleColumns[c.key]).length > 0 && (
                    <span className="ms-1.5 bg-blue-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                      {ALL_COLUMNS.filter(c => !visibleColumns[c.key]).length}
                    </span>
                  )}
                </Button>

                {showColPicker && (
                  <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[180px]">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{t('applicants.candidates.toggleColumns')}</p>
                    <div className="space-y-0.5">
                      {ALL_COLUMNS.filter(c => !(c.key === 'tier' && isAgencyUser)).map(c => (
                        <button
                          key={c.key}
                          onClick={() => toggleColumn(c.key)}
                          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 text-sm text-start"
                        >
                          <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${visibleColumns[c.key] ? 'bg-blue-600 border-blue-600' : 'border-gray-300'}`}>
                            {visibleColumns[c.key] && <Check className="w-2.5 h-2.5 text-white" />}
                          </span>
                          {t(c.labelKey)}
                        </button>
                      ))}
                    </div>
                    <div className="border-t mt-2 pt-2 flex gap-1.5">
                      <button onClick={() => { const all = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, true])) as Record<ColKey, boolean>; setVisibleColumns(all); localStorage.setItem('candidates-table-columns-v3', JSON.stringify(all)); }} className="flex-1 text-xs text-center text-blue-600 hover:underline py-0.5">{t('applicants.candidates.showAll')}</button>
                      <span className="text-gray-300">|</span>
                      <button onClick={() => { const none = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, false])) as Record<ColKey, boolean>; setVisibleColumns(none); localStorage.setItem('candidates-table-columns-v3', JSON.stringify(none)); }} className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5">{t('applicants.candidates.hideAll')}</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Row 2 */}
            <div className="flex flex-wrap items-center gap-3">
              <Select value={nationalityFilter || '__all__'} onValueChange={v => setNationalityFilter(v === '__all__' ? '' : v)}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t('applicants.candidates.allCitizenships')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('applicants.candidates.allCitizenships')}</SelectItem>
                  {nationalityOptions.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>

              {jobTypes.length > 0 && (
                <Select value={jobTypeFilter || '__all__'} onValueChange={v => setJobTypeFilter(v === '__all__' ? '' : v)}>
                  <SelectTrigger className="w-48"><SelectValue placeholder={t('applicants.candidates.allJobCategories')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">{t('applicants.candidates.allJobCategories')}</SelectItem>
                    {jobTypes.map((jt: any) => <SelectItem key={jt.id} value={jt.id}>{tEnums(`jobCategory.${jt.name}`, { defaultValue: jt.name })}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground whitespace-nowrap">{t('applicants.candidates.appliedFrom')}</span>
                <DateInput value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36 text-sm" />
                <span className="text-xs text-muted-foreground">{t('applicants.candidates.appliedTo')}</span>
                <DateInput value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36 text-sm" />
              </div>

              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5 me-1" />{t('applicants.candidates.clearFilters')}
                </Button>
              )}
            </div>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" style={headStyle('select')}>
                    <Checkbox checked={displayData.length > 0 && selected.size === displayData.length} onCheckedChange={toggleSelectAll} />
                  </TableHead>
                  <SortableHead colKey="candidate" style={headStyle('candidate')} startResize={startResize} label={t('applicants.candidates.tableHeaders.candidate')}    field="firstName"   sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                  {tenant.isPlatformSuper && <SortableHead colKey="tenant" style={headStyle('tenant')} startResize={startResize} label={t('tenantFilter.tenant', { defaultValue: 'Tenant' })} field="tenant" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('contact')     && <SortableHead colKey="contact" style={headStyle('contact')} startResize={startResize} label={t('applicants.candidates.tableHeaders.contact')}      field="email"       sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('nationality') && <SortableHead colKey="nationality" style={headStyle('nationality')} startResize={startResize} label={t('applicants.candidates.tableHeaders.citizenship')}  field="nationality" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('appliedPosition') && <SortableHead colKey="appliedPosition" style={headStyle('appliedPosition')} startResize={startResize} label={t('applicants.candidates.tableHeaders.appliedPosition')} field="appliedPosition" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('passportNumber')  && <SortableHead colKey="passportNumber"  style={headStyle('passportNumber')}  startResize={startResize} label={t('applicants.candidates.tableHeaders.passportNumber')}  field="passportNumber"  sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('birthDate')       && <SortableHead colKey="birthDate" style={headStyle('birthDate')} startResize={startResize} label={t('applicants.candidates.tableHeaders.birthDate', { defaultValue: 'Birth Date' })} field="birthDate" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('age')             && <SortableHead colKey="age"       style={headStyle('age')}       startResize={startResize} label={t('applicants.candidates.tableHeaders.age')} field="age" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('gender')          && <SortableHead colKey="gender"    style={headStyle('gender')}    startResize={startResize} label={t('applicants.candidates.tableHeaders.gender')} field="gender" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('agency')      && <SortableHead colKey="agency" style={headStyle('agency')} startResize={startResize} label={t('applicants.candidates.tableHeaders.agency')}       field="agency"      sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('tier') && !isAgencyUser && <SortableHead colKey="tier" style={headStyle('tier')} startResize={startResize} label={t('applicants.list.tableHeaders.tier')} field="tier" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('applied')     && <SortableHead colKey="applied" style={headStyle('applied')} startResize={startResize} label={t('applicants.candidates.tableHeaders.applied')}      field="createdAt"   sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('source')      && <SortableHead colKey="source"     style={headStyle('source')}     startResize={startResize} label={t('applicants.candidates.tableHeaders.source', { defaultValue: t('applicants.list.tableHeaders.source') })} field="source" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  {col('status')      && <SortableHead colKey="status" style={headStyle('status')} startResize={startResize} label={t('applicants.candidates.tableHeaders.status')}       field="status"      sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />}
                  <TableHead className="text-end relative whitespace-normal align-top" style={headStyle('actions')}>{t('applicants.candidates.tableHeaders.actions')}<ResizeHandle onMouseDown={(e) => startResize('actions', e)} /></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
                {loading && (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="text-center py-8 text-muted-foreground">{t('applicants.candidates.loading')}</TableCell>
                  </TableRow>
                )}
                {!loading && displayData.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="text-center py-12 text-muted-foreground">{t('applicants.candidates.emptyFiltered')}</TableCell>
                  </TableRow>
                )}
                {!loading && displayData.map(applicant => (
                  <TableRow key={applicant.id} className={selected.has(applicant.id) ? 'bg-blue-50' : undefined}>
                    <TableCell>
                      <Checkbox checked={selected.has(applicant.id)} onCheckedChange={() => toggleSelect(applicant.id)} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full overflow-hidden bg-blue-100 flex items-center justify-center shrink-0">
                          {applicant.photoUrl
                            ? <img src={resolveAssetUrl(applicant.photoUrl)} alt={applicant.firstName} className="w-full h-full object-cover" />
                            : <span className="text-blue-600 text-sm font-semibold">{applicant.firstName?.[0]}{applicant.lastName?.[0]}</span>}
                        </div>
                        <div>
                          <div className="font-medium text-[#0F172A]">{applicant.firstName} {applicant.lastName}</div>
                          <div className="text-xs font-mono text-muted-foreground">
                            {applicant.tier === 'CANDIDATE' && applicant.candidateNumber
                              ? <span className="text-purple-600">{applicant.candidateNumber}</span>
                              : applicant.leadNumber
                                ? <span className="text-blue-600">{applicant.leadNumber}</span>
                                : <span className="italic opacity-60">{t('applicants.candidates.legacy')}</span>}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    {tenant.isPlatformSuper && (
                      <TableCell className="text-sm">{tenant.resolveTenantName(applicant)}</TableCell>
                    )}
                    {col('contact') && (
                      <TableCell>
                        <div className="text-sm">
                          <div>{applicant.email}</div>
                          <div className="text-muted-foreground">{formatPhoneDisplay(applicant.phone)}</div>
                        </div>
                      </TableCell>
                    )}
                    {col('nationality') && <TableCell className="text-sm">{applicant.nationality}</TableCell>}
                    {col('appliedPosition') && (
                      <TableCell>
                        {applicant.jobAd?.title
                          ? <span className="text-sm">{applicant.jobAd.title}</span>
                          : <Badge variant="outline" className="text-[10px] font-semibold tracking-wide">{t('applicants.candidates.generalBadge')}</Badge>}
                      </TableCell>
                    )}
                    {col('passportNumber') && (
                      <TableCell className="text-sm font-mono whitespace-nowrap">
                        {readPassportNumber(applicant) || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    {col('birthDate') && (
                      <TableCell className="text-sm tabular-nums whitespace-nowrap">
                        {applicant.dateOfBirth ? formatDate(applicant.dateOfBirth) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    {col('age') && (
                      <TableCell className="text-sm tabular-nums">
                        {calcAge(applicant.dateOfBirth) ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    {col('gender') && (
                      <TableCell className="text-sm">
                        {formatGender(applicant.gender, tEnums) || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    {col('agency') && (
                      <TableCell>
                        {applicant.agency?.name
                          ? <span className="text-sm">{applicant.agency.name}</span>
                          : <span className="text-sm text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    {col('tier') && !isAgencyUser && (
                      <TableCell>
                        <Badge className={getTierColor(applicant.tier)}>{tEnums(`applicantTier.${applicant.tier}`, { defaultValue: applicant.tier })}</Badge>
                      </TableCell>
                    )}
                    {col('applied') && (
                      <TableCell>
                        <span className="text-sm">{applicant.createdAt ? formatDate(applicant.createdAt) : '—'}</span>
                      </TableCell>
                    )}
                    {col('source') && (
                      <TableCell>
                        {applicant.applicationSource ? (
                          <Badge
                            variant="outline"
                            className={
                              applicant.applicationSource.kind === 'JOB_AD'  ? 'bg-blue-50 text-blue-800 border-blue-300'   :
                              applicant.applicationSource.kind === 'PUBLIC'  ? 'bg-emerald-50 text-emerald-800 border-emerald-300' :
                              'bg-slate-50 text-slate-800 border-slate-300'
                            }
                            title={applicant.applicationSource.label}
                          >
                            <span className="truncate max-w-[200px] inline-block align-bottom">{applicant.applicationSource.label}</span>
                          </Badge>
                        ) : <span className="text-muted-foreground text-sm">—</span>}
                      </TableCell>
                    )}
                    {col('status') && (
                      <TableCell>
                        <Badge className={getStatusColor(applicant.status)}>{applicant.status ? tEnums(`applicantStatus.${applicant.status}`, { defaultValue: applicant.status.replace(/_/g, ' ') }) : ''}</Badge>
                      </TableCell>
                    )}
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        {/* Order: View → Edit → WhatsApp → Delete (Phase 1 #13) */}
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/dashboard/candidates/${applicant.id}`}><Eye className="w-4 h-4 me-1" />{t('applicants.candidates.viewAction')}</Link>
                        </Button>
                        {canEdit('applicants') && (
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/dashboard/candidates/${applicant.id}/edit`}><Edit className="w-4 h-4 me-1" />{t('applicants.candidates.editAction')}</Link>
                          </Button>
                        )}
                        <WhatsAppButton phone={formatPhoneDisplay(applicant.phone)} size="icon" />
                        {canDelete('applicants') && (
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(applicant)} className="text-[#EF4444] hover:text-[#EF4444] hover:bg-[#FEF2F2]">
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
              {t('applicants.candidates.showingCount', { count: totalCandidates, shown: displayData.length, total: totalCandidates })}
              {selected.size > 0 && t('applicants.candidates.selectedSuffix', { count: selected.size })}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Bulk status change modal — predefined list, no free-text entry */}
      <Dialog open={statusModalOpen} onOpenChange={(open) => {
        setStatusModalOpen(open);
        if (!open) setPendingStatus('');
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('applicants.candidates.statusDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('applicants.candidates.statusDialog.description', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={pendingStatus} onValueChange={setPendingStatus}>
              <SelectTrigger><SelectValue placeholder={t('applicants.candidates.statusDialog.pickStatus')} /></SelectTrigger>
              <SelectContent>
                {STATUSES.map(s => (
                  <SelectItem key={s} value={s}>{tEnums(`applicantStatus.${s}`, { defaultValue: s.replace(/_/g, ' ') })}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusModalOpen(false)} disabled={bulkActionInProgress}>
              {t('applicants.candidates.cancel')}
            </Button>
            <Button
              disabled={bulkActionInProgress || !pendingStatus}
              onClick={async () => {
                if (!pendingStatus) {
                  toast.error(tc('toast.selectStatus'));
                  return;
                }
                setStatusModalOpen(false);
                const next = pendingStatus;
                setPendingStatus('');
                await handleBulkAction('STATUS_CHANGE', next);
              }}
            >
              {t('applicants.candidates.statusDialog.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Convert to Employees dialog — confirms, lets the operator
          (optionally) override the responsible agency, then hands off
          to the backend CONVERT_TO_EMPLOYEE bulk action which derives
          per-candidate address / licence / emergency contact from the
          applicationData blob. Candidates missing required address
          fields are skipped and reported per-row. */}
      <Dialog open={showBulkConvertDialog} onOpenChange={(o) => !o && setShowBulkConvertDialog(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('applicants.candidates.convertDialog.title', { count: selected.size })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              {t('applicants.candidates.convertDialog.body')}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-convert-agency" className="text-sm">{t('applicants.candidates.workflowDialog.responsibleAgencyOptional')}</Label>
              <Select value={bulkConvertAgencyId || '__keep__'} onValueChange={(v) => setBulkConvertAgencyId(v === '__keep__' ? '' : v)}>
                <SelectTrigger id="bulk-convert-agency">
                  <SelectValue placeholder={t('applicants.candidates.workflowDialog.keepCurrent')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__keep__">
                    <span className="text-muted-foreground">{t('applicants.candidates.workflowDialog.keepCurrent')}</span>
                  </SelectItem>
                  {agencies.map((a: any) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('applicants.candidates.convertDialog.reassignNote')}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkConvertDialog(false)} disabled={bulkActionInProgress}>{tc('actions.cancel')}</Button>
            <Button
              className="bg-[#22C55E] hover:bg-[#16a34a] text-white"
              disabled={bulkActionInProgress}
              onClick={async () => {
                setShowBulkConvertDialog(false);
                await handleBulkAction('CONVERT_TO_EMPLOYEE', undefined, bulkConvertAgencyId || undefined);
              }}
            >
              {t('applicants.candidates.convertDialog.convertAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Connect to Workflow dialog — assigns one chosen
          workflow to every selected candidate. Per-candidate rules
          (single active workflow, admin-only reassignment) are
          enforced on the backend; the summary toast spells out who
          was assigned, reassigned, skipped, or blocked. */}
      <Dialog open={showBulkWorkflowDialog} onOpenChange={(o) => !o && setShowBulkWorkflowDialog(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('applicants.candidates.workflowDialog.title', { count: selected.size })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              {t('applicants.candidates.workflowDialog.body')}
              <strong className="text-foreground"> {t('applicants.candidates.workflowDialog.inProgress')}</strong>
              {t('applicants.candidates.workflowDialog.bodyContinuation')}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-workflow" className="text-sm">{t('applicants.candidates.workflowDialog.workflowRequired')}</Label>
              <Select value={bulkWorkflowId} onValueChange={setBulkWorkflowId}>
                <SelectTrigger id="bulk-workflow">
                  <SelectValue placeholder={allWorkflows.length === 0 ? t('applicants.candidates.workflowDialog.noWorkflows') : t('applicants.candidates.workflowDialog.pickWorkflow')} />
                </SelectTrigger>
                <SelectContent>
                  {allWorkflows.map((w: any) => (
                    <SelectItem key={w.id} value={w.id}>
                      <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: w.color ?? '#6366F1' }} />
                        <span>{w.name}</span>
                        <span className={`ms-1 text-[10px] px-1.5 py-0.5 rounded border ${w.isPublic ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-700 border-slate-200'}`}>
                          {w.isPublic ? t('applicants.candidates.workflowDialog.isPublic') : t('applicants.candidates.workflowDialog.isPrivate')}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-workflow-notes" className="text-sm">{t('applicants.candidates.workflowDialog.notes')} <span className="text-muted-foreground text-xs">{t('applicants.candidates.workflowDialog.optionalLabel')}</span></Label>
              <Input
                id="bulk-workflow-notes"
                placeholder={t('applicants.candidates.workflowDialog.notesPlaceholder')}
                value={bulkWorkflowNotes}
                onChange={(e) => setBulkWorkflowNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkWorkflowDialog(false)} disabled={bulkWorkflowInFlight}>{tc('actions.cancel')}</Button>
            <Button
              disabled={bulkWorkflowInFlight || !bulkWorkflowId}
              onClick={handleBulkAssignWorkflow}
            >
              {bulkWorkflowInFlight ? t('applicants.candidates.workflowDialog.assigning') : t('applicants.candidates.workflowDialog.connectAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
