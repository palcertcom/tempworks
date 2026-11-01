import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Search, AlertTriangle, CheckCircle, Clock, FileText,
  Download, Upload, RefreshCw, Edit, Trash2, CheckCircle2, XCircle, Eye,
  ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown, Filter, X, ArrowLeft,
  Columns2, Check, Archive, ArchiveRestore,
} from 'lucide-react';
import { useColumnWidths, ResizeHandle } from '../../hooks/useColumnWidths';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { documentsApi, settingsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { formatDate } from '../../../i18n/formatters';
import { getDocumentDisplayName } from '../../utils/documentDisplay';
import { DateInput } from '../../components/ui/date-input';
import { Checkbox } from '../../components/ui/checkbox';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');
const getFileUrl = (fileUrl: string) => {
  if (!fileUrl) return '';
  if (fileUrl.search(/https?:\/\/.*?(https?:\/\/)/) !== -1) {
    return fileUrl.slice(fileUrl.indexOf('http', 1));
  }
  return /^https?:\/\//i.test(fileUrl) ? fileUrl : `${API_BASE}${fileUrl}`;
};

// `labelKey` is resolved against `documents.compliance.statusOptions.<KEY>`
// at render time. Keeping value as the canonical enum string preserves the
// API contract; only the dropdown label is translated.
const STATUS_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'PENDING',       labelKey: 'PENDING' },
  { value: 'VERIFIED',      labelKey: 'VERIFIED' },
  { value: 'REJECTED',      labelKey: 'REJECTED' },
  { value: 'EXPIRED',       labelKey: 'EXPIRED' },
  { value: 'EXPIRING_SOON', labelKey: 'EXPIRING_SOON' },
];

const COMPLIANCE_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'COMPLIANT',     labelKey: 'COMPLIANT' },
  { value: 'AT_RISK',       labelKey: 'AT_RISK' },
  { value: 'NON_COMPLIANT', labelKey: 'NON_COMPLIANT' },
  { value: 'PENDING',       labelKey: 'PENDING' },
];

// ── Sorting ─────────────────────────────────────────────────────────────────
type SortField =
  | 'docId' | 'ownerName' | 'name' | 'typeName' | 'status'
  | 'expiryDate' | 'verifiedAt' | 'createdAt'
  | 'documentNumber' | 'issueDate';
type SortOrder = 'asc' | 'desc';

const SERVER_SORT_FIELDS: SortField[] = [
  'docId', 'name', 'status', 'expiryDate', 'verifiedAt',
  'createdAt', 'documentNumber', 'issueDate',
];

// ── Column visibility ───────────────────────────────────────────────────────
type ColKey =
  | 'docId' | 'owner' | 'document' | 'type' | 'status'
  | 'expiry' | 'verifiedBy' | 'compliance'
  | 'createdAt' | 'documentNumber' | 'issueDate' | 'entityType';

const ALL_COLUMNS: { key: ColKey; labelKey: string }[] = [
  { key: 'docId',          labelKey: 'documents.list.cols.docId' },
  { key: 'owner',          labelKey: 'documents.list.cols.owner' },
  { key: 'document',       labelKey: 'documents.list.cols.document' },
  { key: 'type',           labelKey: 'documents.list.cols.type' },
  { key: 'status',         labelKey: 'documents.list.cols.status' },
  { key: 'expiry',         labelKey: 'documents.list.cols.expiry' },
  { key: 'verifiedBy',     labelKey: 'documents.list.cols.verifiedBy' },
  { key: 'compliance',     labelKey: 'documents.list.cols.compliance' },
  { key: 'createdAt',      labelKey: 'documents.list.cols.createdAt' },
  { key: 'documentNumber', labelKey: 'documents.list.cols.documentNumber' },
  { key: 'issueDate',      labelKey: 'documents.list.cols.issueDate' },
  { key: 'entityType',     labelKey: 'documents.list.cols.entityType' },
];

const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  docId: true, owner: true, document: true, type: true, status: true,
  expiry: true, verifiedBy: true, compliance: true,
  createdAt: false, documentNumber: false, issueDate: false, entityType: false,
};

const DEFAULT_COL_WIDTHS: Record<ColKey | 'actions', number> = {
  docId: 160, owner: 180, document: 280, type: 150, status: 130,
  expiry: 110, verifiedBy: 160, compliance: 130,
  createdAt: 110, documentNumber: 160, issueDate: 110, entityType: 120,
  actions: 220,
};

const STORAGE_KEY = 'documents-compliance-table-columns';

function loadVisibleColumns(): Record<ColKey, boolean> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...DEFAULT_VISIBLE, ...JSON.parse(saved) } : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

export function DocumentsCompliance() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { t: tEnums } = useTranslation('enums');
  const tDC = (key: string, opts?: any) => t(`documents.compliance.${key}`, opts);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { canCreate, canEdit, canDelete, can } = usePermissions();
  const tenantVersion = useTenantSyncVersion();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenant = useSuperUserTenantFilter();

  // ── Server-driven state ──────────────────────────────────────────────────
  const [documents,  setDocuments]  = useState<any[]>([]);
  const [meta,       setMeta]       = useState({ total: 0, page: 1, limit: 30, totalPages: 1 });
  const [kpis,       setKpis]       = useState({ valid: 0, expiringSoon: 0, expired: 0, pending: 0, total: 0 });
  const [loading,    setLoading]    = useState(true);
  const [docTypes,   setDocTypes]   = useState<{ id: string; name: string; code?: string }[]>([]);

  // ── Filters ──────────────────────────────────────────────────────────────
  const [search,           setSearch]           = useState(searchParams.get('search')         ?? '');
  const [statusFilter,     setStatusFilter]     = useState(searchParams.get('status')         ?? '');
  const [typeFilter,       setTypeFilter]       = useState(searchParams.get('documentTypeId') ?? '');
  const [entityTypeF,      setEntityTypeF]      = useState(searchParams.get('entityType')     ?? '');
  const [docIdFilter,      setDocIdFilter]      = useState(searchParams.get('docId')          ?? '');
  const [docNumFilter,     setDocNumFilter]     = useState(searchParams.get('documentNumber') ?? '');
  const [expFrom,          setExpFrom]          = useState(searchParams.get('expiryDateFrom') ?? '');
  const [expTo,            setExpTo]            = useState(searchParams.get('expiryDateTo')   ?? '');
  const [issueFrom,        setIssueFrom]        = useState('');
  const [issueTo,          setIssueTo]          = useState('');
  const [complianceFilter, setComplianceFilter] = useState('');
  const [ownerFilter,      setOwnerFilter]      = useState('');
  const [verifierFilter,   setVerifierFilter]   = useState('');
  // Archive view: active (default) | archived | all.
  const [archivedView,     setArchivedView]     = useState<'active' | 'archived' | 'all'>('active');
  const [sortBy,           setSortBy]           = useState<SortField>((searchParams.get('sortBy') as SortField) ?? 'createdAt');
  const [sortOrder,        setSortOrder]        = useState<SortOrder>((searchParams.get('sortOrder') as SortOrder) ?? 'desc');
  const [page,             setPage]             = useState(1);
  const limit = 30;

  // ── Column visibility ─────────────────────────────────────────────────────
  const [visibleColumns, setVisibleColumns] = useState<Record<ColKey, boolean>>(loadVisibleColumns);

  const { headStyle, startResize } = useColumnWidths('docs-compliance-col-widths-v1', DEFAULT_COL_WIDTHS);
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

  // ── Dialog state ──────────────────────────────────────────────────────────
  const [verifying,       setVerifying]      = useState<string | null>(null);
  const [rejectDialog,    setRejectDialog]   = useState<{ open: boolean; docId: string; docName: string }>({ open: false, docId: '', docName: '' });
  const [rejectionReason, setRejectionReason]= useState('');
  const [renewDialog,     setRenewDialog]    = useState<{ open: boolean; doc: any | null }>({ open: false, doc: null });
  const [renewForm,       setRenewForm]      = useState({ name: '', issueDate: '', expiryDate: '', documentNumber: '', issueCountry: '', issuer: '', notes: '' });
  const [renewing,        setRenewing]       = useState(false);
  const [renewFile,       setRenewFile]      = useState<File | null>(null);
  // "Open-ended" toggle for the Renew dialog (work contracts etc.).
  // When ticked, expiryDate is omitted from the renewal payload.
  const [renewNoExpiry,   setRenewNoExpiry]  = useState(false);

  // ── Load document types ────────────────────────────────────────────────────
  useEffect(() => {
    settingsApi.getDocumentTypes().then(setDocTypes).catch(() => {});
  }, []);

  // ── Fetch documents ───────────────────────────────────────────────────────
  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const useServerSort = SERVER_SORT_FIELDS.includes(sortBy);
      const params: Record<string, any> = tenant.applyToParams({
        page: p, limit,
        ...(useServerSort ? { sortBy, sortOrder } : { sortBy: 'createdAt', sortOrder: 'desc' }),
        ...(search       ? { search }                         : {}),
        ...(statusFilter ? { status: statusFilter }           : {}),
        ...(typeFilter   ? { documentTypeId: typeFilter }     : {}),
        ...(entityTypeF  ? { entityType: entityTypeF }        : {}),
        ...(docIdFilter  ? { docId: docIdFilter }             : {}),
        ...(docNumFilter ? { documentNumber: docNumFilter }   : {}),
        ...(expFrom      ? { expiryDateFrom: expFrom }        : {}),
        ...(expTo        ? { expiryDateTo:   expTo }          : {}),
        ...(archivedView !== 'active' ? { archived: archivedView } : {}),
      });
      const res = await documentsApi.list(params) as any;
      setDocuments(res.data ?? []);
      setMeta(res.meta ?? { total: 0, page: p, limit, totalPages: 1 });
      // KPI tiles must reflect the full filtered collection, not the
      // current page. Backend computes expiringSoon/expired by
      // expiryDate (stored status is usually VERIFIED/PENDING).
      const { status: _ignoredStatus, page: _p, limit: _l, sortBy: _sb, sortOrder: _so, ...kpiParams } = params as any;
      documentsApi.kpis(kpiParams).then(setKpis).catch(() => {});
    } catch {
      toast.error(tc('toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, typeFilter, entityTypeF, docIdFilter, docNumFilter, expFrom, expTo, sortBy, sortOrder, archivedView, tenantVersion, tenant.tenantFilter]);

  useEffect(() => { setPage(1); load(1); }, [search, statusFilter, typeFilter, entityTypeF, docIdFilter, docNumFilter, expFrom, expTo, sortBy, sortOrder, archivedView, tenant.tenantFilter]);

  const handlePage = (p: number) => { setPage(p); load(p); };

  const handleSort = (field: SortField) => {
    if (sortBy === field) setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortOrder('asc'); }
  };

  const clearFilters = () => {
    setSearch(''); setStatusFilter(''); setTypeFilter('');
    setEntityTypeF(''); setDocIdFilter(''); setDocNumFilter('');
    setExpFrom(''); setExpTo('');
    setIssueFrom(''); setIssueTo('');
    setComplianceFilter(''); setOwnerFilter(''); setVerifierFilter('');
  };

  const hasFilters = !!(search || statusFilter || typeFilter || entityTypeF
    || docIdFilter || docNumFilter || expFrom || expTo
    || issueFrom || issueTo || complianceFilter || ownerFilter || verifierFilter);

  // ── Client-side sort + filter of current page ────────────────────────────
  const complianceOf = (status: string): string => {
    if (status === 'VERIFIED')      return 'COMPLIANT';
    if (status === 'EXPIRING_SOON') return 'AT_RISK';
    if (status === 'PENDING')       return 'PENDING';
    return 'NON_COMPLIANT';
  };

  const displayData = useMemo(() => {
    let data = documents;

    // Client-only filters
    if (complianceFilter) data = data.filter(d => complianceOf(d.status) === complianceFilter);
    if (ownerFilter) {
      const q = ownerFilter.toLowerCase();
      data = data.filter(d => (d.ownerName ?? '').toLowerCase().includes(q)
        || (d.ownerSystemId ?? '').toLowerCase().includes(q));
    }
    if (verifierFilter) {
      const q = verifierFilter.toLowerCase();
      data = data.filter(d => {
        if (!d.verifiedBy) return false;
        const name = `${d.verifiedBy.firstName ?? ''} ${d.verifiedBy.lastName ?? ''}`.toLowerCase();
        return name.includes(q);
      });
    }
    if (issueFrom || issueTo) {
      const from = issueFrom ? new Date(issueFrom).getTime() : -Infinity;
      const to   = issueTo   ? new Date(issueTo + 'T23:59:59').getTime() : Infinity;
      data = data.filter(d => {
        if (!d.issueDate) return false;
        const t = new Date(d.issueDate).getTime();
        return t >= from && t <= to;
      });
    }

    // Client-side sort for derived fields (server handles the rest)
    if (!SERVER_SORT_FIELDS.includes(sortBy)) {
      data = [...data].sort((a, b) => {
        let aVal: any = '', bVal: any = '';
        if (sortBy === 'ownerName') {
          aVal = (a.ownerName ?? '').toLowerCase();
          bVal = (b.ownerName ?? '').toLowerCase();
        } else if (sortBy === 'typeName') {
          aVal = (a.documentType?.name ?? '').toLowerCase();
          bVal = (b.documentType?.name ?? '').toLowerCase();
        }
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return sortOrder === 'asc' ? cmp : -cmp;
      });
    }

    return data;
  }, [documents, complianceFilter, ownerFilter, verifierFilter, issueFrom, issueTo, sortBy, sortOrder]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleApprove = async (doc: any) => {
    setVerifying(doc.id);
    try {
      const updated = await documentsApi.verify(doc.id, { action: 'VERIFY' });
      setDocuments(prev => prev.map(d => d.id === doc.id ? updated : d));
      toast.success(tc('toast.approvedNamed', { name: doc.name }));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.operationFailed')));
    } finally { setVerifying(null); }
  };

  const handleReject = async () => {
    if (!rejectionReason.trim()) { toast.error(tc('toast.rejectionReasonRequired')); return; }
    setVerifying(rejectDialog.docId);
    try {
      const updated = await documentsApi.verify(rejectDialog.docId, { action: 'REJECT', reason: rejectionReason.trim() });
      setDocuments(prev => prev.map(d => d.id === rejectDialog.docId ? updated : d));
      toast.success(tc('toast.rejectedNamed', { name: rejectDialog.docName }));
      setRejectDialog({ open: false, docId: '', docName: '' });
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.operationFailed')));
    } finally { setVerifying(null); }
  };

  const handleDelete = async (doc: any) => {
    if (!(await confirm({
      title: tc('confirm.deleteDocumentTitle'),
      description: tc('confirm.deleteDocumentBodyNamed', { name: doc.name }),
      confirmText: tc('actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await documentsApi.delete(doc.id);
      setDocuments(prev => prev.filter(d => d.id !== doc.id));
      toast.success(t('documents.compliancePage.deleteSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('documents.compliancePage.deleteFailed')));
    }
  };

  const handleArchive = async (doc: any) => {
    if (!(await confirm({
      title: t('documents.compliancePage.archiveTitle', { defaultValue: 'Archive document?' }),
      description: t('documents.compliancePage.archiveBody', {
        defaultValue: '"{{name}}" will be marked No Longer Valid — kept in history but removed from the active list and compliance alerts.',
        name: doc.name,
      }),
      confirmText: t('documents.compliancePage.archive', { defaultValue: 'Archive' }),
    }))) return;
    try {
      await documentsApi.archive(doc.id);
      toast.success(t('documents.compliancePage.archiveSuccess', { defaultValue: 'Document archived' }));
      load(page);
    } catch (err: any) {
      toast.error(apiError(err, t('documents.compliancePage.archiveFailed', { defaultValue: 'Failed to archive' })));
    }
  };

  const handleUnarchive = async (doc: any) => {
    try {
      await documentsApi.unarchive(doc.id);
      toast.success(t('documents.compliancePage.unarchiveSuccess', { defaultValue: 'Document restored to active' }));
      load(page);
    } catch (err: any) {
      toast.error(apiError(err, t('documents.compliancePage.unarchiveFailed', { defaultValue: 'Failed to restore' })));
    }
  };

  const openRenewDialog = (doc: any) => {
    setRenewForm({ name: `${doc.name} (Renewal)`, issueDate: '', expiryDate: '', documentNumber: doc.documentNumber ?? '', issueCountry: doc.issueCountry ?? '', issuer: doc.issuer ?? '', notes: '' });
    setRenewFile(null);
    setRenewDialog({ open: true, doc });
  };

  const handleRenew = async () => {
    // The new file is mandatory — renewal replaces the old document with
    // the fresh copy and archives the old one.
    if (!renewFile) {
      toast.error(t('documents.compliancePage.renewFileRequired', { defaultValue: 'Please attach the new document file.' }));
      return;
    }
    setRenewing(true);
    try {
      const fd = new FormData();
      fd.append('file', renewFile);
      if (renewForm.name)           fd.append('name', renewForm.name);
      if (renewForm.issueDate)      fd.append('issueDate', renewForm.issueDate);
      // Skip expiryDate when the operator ticked "No expiry date"
      // (open-ended renewal — e.g. a new indefinite work contract).
      if (!renewNoExpiry && renewForm.expiryDate) fd.append('expiryDate', renewForm.expiryDate);
      if (renewForm.documentNumber) fd.append('documentNumber', renewForm.documentNumber);
      if (renewForm.issueCountry)   fd.append('issueCountry', renewForm.issueCountry);
      if (renewForm.issuer)         fd.append('issuer', renewForm.issuer);
      if (renewForm.notes)          fd.append('notes', renewForm.notes);
      const renewed = await documentsApi.renew(renewDialog.doc.id, fd);
      toast.success(tc('toast.renewalCreated', { id: renewed.docId ?? renewed.id }));
      setRenewDialog({ open: false, doc: null });
      setRenewNoExpiry(false);
      setRenewFile(null);
      load(page);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.operationFailed')));
    } finally { setRenewing(false); }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  const getStatusBadge = (status: string) => {
    const map: Record<string, string> = {
      VERIFIED: 'bg-emerald-100 text-emerald-700',
      EXPIRING_SOON: 'bg-amber-100 text-amber-700',
      EXPIRED: 'bg-red-100 text-red-700',
      REJECTED: 'bg-red-100 text-red-700',
      PENDING: 'bg-gray-100 text-gray-700',
    };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>{tEnums(`documentStatus.${status}`, { defaultValue: status })}</span>;
  };

  const getComplianceBadge = (status: string) => {
    if (status === 'VERIFIED')      return <span className="px-2 py-0.5 rounded-full text-xs border border-emerald-400 text-emerald-600 bg-emerald-50">{t('documents.compliance.complianceBadge.compliant')}</span>;
    if (status === 'EXPIRING_SOON') return <span className="px-2 py-0.5 rounded-full text-xs border border-amber-400  text-amber-600  bg-amber-50">{t('documents.compliance.complianceBadge.atRisk')}</span>;
    if (status === 'PENDING')       return <span className="px-2 py-0.5 rounded-full text-xs border border-gray-300   text-gray-600   bg-gray-50">{t('documents.compliance.complianceBadge.pending')}</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs border border-red-400 text-red-600 bg-red-50">{t('documents.compliance.complianceBadge.nonCompliant')}</span>;
  };

  const SortableHead = ({ label, field, colKey, className }: {
    label: string;
    field: SortField;
    colKey: string;
    className?: string;
  }) => {
    const active = sortBy === field;
    return (
      <TableHead
        className={`relative whitespace-normal align-top ${className ?? ''}`}
        style={headStyle(colKey)}
      >
        <button
          onClick={() => handleSort(field)}
          className="flex items-center gap-1 hover:text-foreground font-medium group text-start break-words"
        >
          <span className="break-words">{label}</span>
          {active
            ? sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-primary shrink-0" /> : <ArrowDown className="w-3 h-3 text-primary shrink-0" />
            : <ArrowUpDown className="w-3 h-3 opacity-30 group-hover:opacity-60 shrink-0" />}
        </button>
        <ResizeHandle onMouseDown={(e) => startResize(colKey, e)} />
      </TableHead>
    );
  };

  // ── Stats ─────────────────────────────────────────────────────────────────
  // Sourced from /documents/kpis so the tiles reflect the entire
  // filtered collection (not just the current page) and so
  // expiringSoon / expired are computed from expiryDate.
  const validDocs    = kpis.valid;
  const expiringDocs = kpis.expiringSoon;
  const expiredDocs  = kpis.expired;
  const pendingDocs  = kpis.pending;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{t('documents.compliance.title')}</h1>
          </div>
          <p className="text-muted-foreground mt-1">{t('documents.compliance.subtitle')}</p>
        </div>
        {canCreate('documents') && (
          <Button asChild>
            <Link to="/dashboard/documents/upload">
              <Upload className="w-4 h-4 me-2" />{tDC('uploadDocument')}
            </Link>
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { key: 'valid',     icon: <CheckCircle className="w-6 h-6 text-emerald-500" />, bg: 'bg-emerald-50', count: validDocs,    label: tDC('statsValid'),         filter: 'VERIFIED' },
          { key: 'expiring',  icon: <Clock       className="w-6 h-6 text-amber-500"  />, bg: 'bg-amber-50',   count: expiringDocs, label: tDC('statsExpiringSoon'),  filter: 'EXPIRING_SOON' },
          { key: 'expired',   icon: <AlertTriangle className="w-6 h-6 text-red-500" />, bg: 'bg-red-50',      count: expiredDocs,  label: tDC('statsExpired'),       filter: 'EXPIRED' },
          { key: 'pending',   icon: <FileText    className="w-6 h-6 text-gray-500"  />, bg: 'bg-gray-50',     count: pendingDocs,  label: tDC('statsPending'),       filter: 'PENDING' },
        ].map(({ key, icon, bg, count, label, filter }) => (
          <Card key={key} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setStatusFilter(f => f === filter ? '' : filter)}>
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <div className={`w-11 h-11 rounded-lg ${bg} flex items-center justify-center flex-shrink-0`}>{icon}</div>
                <div><p className="text-2xl font-semibold">{count}</p><p className="text-xs text-muted-foreground leading-tight">{label}</p></div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Compliance alert banner */}
      {(expiringDocs > 0 || expiredDocs > 0) && (
        <Card className="border-amber-400 bg-amber-50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-medium text-amber-700">{t('documents.compliance.complianceAlerts')}</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {tDC('alertCombined', { expired: expiredDocs, expiring: expiringDocs })}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setStatusFilter('EXPIRING_SOON')}>{tDC('viewAction')}</Button>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Filter className="w-4 h-4" /> {t('documents.compliance.filterTitle')}</CardTitle>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground">
                <X className="w-3 h-3 me-1" /> {tDC('clearFilters')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Row 1: search + status + type */}
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={tDC('searchPh')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="ps-9"
              />
            </div>
            {tenant.isPlatformSuper && (
              <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
            )}
            <Select value={statusFilter || '__all__'} onValueChange={v => setStatusFilter(v === '__all__' ? '' : v)}>
              <SelectTrigger className="w-44"><SelectValue placeholder={t('documents.compliance.allStatuses')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{tDC('allStatuses')}</SelectItem>
                {STATUS_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{tDC(`statusOptions.${o.labelKey}`)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={typeFilter || '__all__'} onValueChange={v => setTypeFilter(v === '__all__' ? '' : v)}>
              <SelectTrigger className="w-48"><SelectValue placeholder={t('documents.compliance.allTypes')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('documents.compliance.allTypes')}</SelectItem>
                {docTypes.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={entityTypeF || '__all__'} onValueChange={v => setEntityTypeF(v === '__all__' ? '' : v)}>
              <SelectTrigger className="w-36"><SelectValue placeholder={t('documents.compliance.allEntities')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{tDC('allEntities')}</SelectItem>
                <SelectItem value="APPLICANT">{tEnums('entityType.APPLICANT')}</SelectItem>
                <SelectItem value="EMPLOYEE">{tEnums('entityType.EMPLOYEE')}</SelectItem>
              </SelectContent>
            </Select>
            {/* Archive view */}
            <Select value={archivedView} onValueChange={v => setArchivedView(v as 'active' | 'archived' | 'all')}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t('documents.compliancePage.viewActive', { defaultValue: 'Active only' })}</SelectItem>
                <SelectItem value="archived">{t('documents.compliancePage.viewArchived', { defaultValue: 'Archived only' })}</SelectItem>
                <SelectItem value="all">{t('documents.compliancePage.viewAll', { defaultValue: 'Active + Archived' })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {/* Row 2: docId + docNumber + owner + verifier + compliance */}
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder={tDC('docIdPh')}
              value={docIdFilter}
              onChange={e => setDocIdFilter(e.target.value)}
              className="w-52"
            />
            <Input
              placeholder={tDC('docNumPh')}
              value={docNumFilter}
              onChange={e => setDocNumFilter(e.target.value)}
              className="w-44"
            />
            <Input
              placeholder={tDC('ownerPh')}
              value={ownerFilter}
              onChange={e => setOwnerFilter(e.target.value)}
              className="w-44"
            />
            <Input
              placeholder={tDC('verifierPh')}
              value={verifierFilter}
              onChange={e => setVerifierFilter(e.target.value)}
              className="w-40"
            />
            <Select value={complianceFilter || '__all__'} onValueChange={v => setComplianceFilter(v === '__all__' ? '' : v)}>
              <SelectTrigger className="w-40"><SelectValue placeholder={t('documents.compliance.allCompliance')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{tDC('allCompliance')}</SelectItem>
                {COMPLIANCE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{tDC(`complianceOptions.${o.labelKey}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {/* Row 3: expiry range + issue range + column picker */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{tDC('expiryFrom')}</span>
              <DateInput value={expFrom} onChange={e => setExpFrom(e.target.value)} className="w-36" />
              <span className="text-xs text-muted-foreground">{tDC('expiryToLabel')}</span>
              <DateInput value={expTo} onChange={e => setExpTo(e.target.value)} className="w-36" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{tDC('issueFrom')}</span>
              <DateInput value={issueFrom} onChange={e => setIssueFrom(e.target.value)} className="w-36" />
              <span className="text-xs text-muted-foreground">{tDC('issueToLabel')}</span>
              <DateInput value={issueTo} onChange={e => setIssueTo(e.target.value)} className="w-36" />
            </div>

            {/* Column picker */}
            <div className="relative ms-auto" ref={colPickerRef}>
              <Button
                variant="outline" size="sm"
                onClick={() => setShowColPicker(v => !v)}
                className={showColPicker ? 'border-primary text-primary' : ''}
              >
                <Columns2 className="w-4 h-4 me-1.5" />{tDC('columnsButton')}
                {hiddenCount > 0 && (
                  <span className="ms-1.5 bg-primary text-primary-foreground text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                    {hiddenCount}
                  </span>
                )}
              </Button>

              {showColPicker && (
                <div className="absolute end-0 top-full mt-1.5 z-50 bg-white border rounded-lg shadow-lg p-3 min-w-[200px]">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{t('documents.compliance.toggleColumns')}</p>
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
                    >{t('documents.compliance.showAll')}</button>
                    <span className="text-gray-300">|</span>
                    <button
                      onClick={() => {
                        setVisibleColumns(DEFAULT_VISIBLE);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_VISIBLE));
                      }}
                      className="flex-1 text-xs text-center text-gray-500 hover:underline py-0.5"
                    >{tDC('reset')}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Reject dialog */}
      <Dialog open={rejectDialog.open} onOpenChange={open => !open && setRejectDialog(s => ({ ...s, open: false }))}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tDC('rejectDialog.title')}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">{tDC('rejecting')} <span className="font-medium text-foreground">{rejectDialog.docName}</span></p>
            <div className="space-y-2">
              <Label htmlFor="reject-reason">{tDC('rejectionReason')} <span className="text-destructive">*</span></Label>
              <Textarea id="reject-reason" placeholder={tDC('rejectDialog.reasonPh')} value={rejectionReason} onChange={e => setRejectionReason(e.target.value)} rows={4} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialog(s => ({ ...s, open: false }))}>{tc('actions.cancel')}</Button>
            <Button className="bg-red-500 hover:bg-red-600 text-white" onClick={handleReject} disabled={!!verifying || !rejectionReason.trim()}>
              <XCircle className="w-4 h-4 me-2" />{verifying ? tDC('rejectDialog.rejecting') : tDC('rejectDialog.confirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Renew dialog */}
      <Dialog open={renewDialog.open} onOpenChange={open => !open && setRenewDialog(s => ({ ...s, open: false }))}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{tDC('renewDialog.title')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground -mt-2">
            {tDC('renewDialog.bodyPrefix')}<span className="font-medium text-foreground">{renewDialog.doc?.docId ?? renewDialog.doc?.name}</span>{tDC('renewDialog.bodySuffix')}
          </p>
          <div className="space-y-3">
            {/* New document file — required. Replaces the old copy; the
                original is auto-archived on renewal. */}
            <div>
              <Label>{t('documents.compliancePage.renewFileLabel', { defaultValue: 'New document file' })} *</Label>
              <Input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                onChange={e => setRenewFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t('documents.compliancePage.renewFileHelp', { defaultValue: 'Upload the renewed document. The previous document will be archived automatically.' })}
              </p>
            </div>
            <div><Label>{tDC('renewDialog.nameLabel')}</Label><Input value={renewForm.name} onChange={e => setRenewForm(p => ({ ...p, name: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>{tDC('renewDialog.issueDateLabel')}</Label><DateInput value={renewForm.issueDate} onChange={e => setRenewForm(p => ({ ...p, issueDate: e.target.value }))} /></div>
              <div>
                <Label>{tDC('renewDialog.expiryDateLabel')}</Label>
                <DateInput
                  value={renewNoExpiry ? '' : renewForm.expiryDate}
                  disabled={renewNoExpiry}
                  onChange={e => setRenewForm(p => ({ ...p, expiryDate: e.target.value }))}
                />
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none mt-1">
                  <Checkbox
                    checked={renewNoExpiry}
                    onCheckedChange={(v) => {
                      const on = !!v;
                      setRenewNoExpiry(on);
                      if (on) setRenewForm(p => ({ ...p, expiryDate: '' }));
                    }}
                  />
                  {tDC('renewDialog.noExpiry', { defaultValue: 'No expiry date (open-ended)' })}
                </label>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>{tDC('renewDialog.docNumberLabel')}</Label><Input value={renewForm.documentNumber} onChange={e => setRenewForm(p => ({ ...p, documentNumber: e.target.value }))} /></div>
              <div><Label>{tDC('renewDialog.issueCountryLabel')}</Label><Input value={renewForm.issueCountry} onChange={e => setRenewForm(p => ({ ...p, issueCountry: e.target.value }))} /></div>
            </div>
            <div><Label>{tDC('renewDialog.issuerLabel')}</Label><Input value={renewForm.issuer} onChange={e => setRenewForm(p => ({ ...p, issuer: e.target.value }))} /></div>
            <div><Label>{tDC('renewDialog.notesLabel')}</Label><Input value={renewForm.notes} onChange={e => setRenewForm(p => ({ ...p, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenewDialog(s => ({ ...s, open: false }))}>{tc('actions.cancel')}</Button>
            <Button onClick={handleRenew} disabled={renewing || !renewFile}>
              <RefreshCw className="w-4 h-4 me-2" />{renewing ? tDC('renewDialog.creating') : tDC('renewDialog.createAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Documents table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{tDC('documentsCount', { count: meta.total })}</CardTitle>
            {meta.totalPages > 1 && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <span>{tDC('pageOf', { page: meta.page, totalPages: meta.totalPages })}</span>
                <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => handlePage(page - 1)}><ChevronLeft className="w-4 h-4" /></Button>
                <Button variant="ghost" size="sm" disabled={page >= meta.totalPages} onClick={() => handlePage(page + 1)}><ChevronRight className="w-4 h-4" /></Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="table-fixed">
              <TableHeader className="bg-muted/40">
                <TableRow>
                  {col('docId')          && <SortableHead colKey="docId"          label={t('documents.list.cols.docId')}          field="docId" />}
                  {col('owner')          && <SortableHead colKey="owner"          label={t('documents.list.cols.owner')}          field="ownerName" />}
                  {col('document')       && <SortableHead colKey="document"       label={t('documents.list.cols.document')}       field="name" />}
                  {col('type')           && <SortableHead colKey="type"           label={t('documents.list.cols.type')}           field="typeName" />}
                  {col('status')         && <SortableHead colKey="status"         label={t('documents.list.cols.status')}         field="status" />}
                  {col('expiry')         && <SortableHead colKey="expiry"         label={t('documents.list.cols.expiry')}         field="expiryDate" />}
                  {col('verifiedBy')     && <SortableHead colKey="verifiedBy"     label={t('documents.list.cols.verifiedBy')}     field="verifiedAt" />}
                  {col('compliance')     && <SortableHead colKey="compliance"     label={t('documents.list.cols.compliance')}     field="status" />}
                  {col('createdAt')      && <SortableHead colKey="createdAt"      label={t('documents.list.cols.createdAt')}      field="createdAt" />}
                  {col('documentNumber') && <SortableHead colKey="documentNumber" label={t('documents.list.cols.documentNumber')} field="documentNumber" />}
                  {col('issueDate')      && <SortableHead colKey="issueDate"      label={t('documents.list.cols.issueDate')}      field="issueDate" />}
                  {col('entityType')     && <SortableHead colKey="entityType"     label={t('documents.list.cols.entityType')}     field="ownerName" />}
                  <TableHead
                    className="text-end whitespace-normal align-top relative"
                    style={headStyle('actions')}
                  >
                    {tDC('actionsHeader')}
                    <ResizeHandle onMouseDown={(e) => startResize('actions', e)} />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">
                {loading ? (
                  <TableRow><TableCell colSpan={visibleCount + 1} className="p-8 text-center text-muted-foreground">{t('documents.compliance.loading')}</TableCell></TableRow>
                ) : displayData.length === 0 ? (
                  <TableRow><TableCell colSpan={visibleCount + 1} className="p-8 text-center text-muted-foreground">{t('documents.compliance.noDocuments')}</TableCell></TableRow>
                ) : displayData.map(doc => {
                  const daysLeft = doc.expiryDate
                    ? Math.ceil((new Date(doc.expiryDate).getTime() - Date.now()) / 86400000)
                    : null;
                  const verifierName = doc.verifiedBy
                    ? `${doc.verifiedBy.firstName} ${doc.verifiedBy.lastName}`
                    : null;
                  return (
                    <TableRow key={doc.id}>
                      {col('docId') && (
                        <TableCell>
                          {doc.docId
                            ? <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{doc.docId}</code>
                            : <span className="text-xs text-muted-foreground italic">—</span>}
                          {doc.renewedFrom && (
                            <div className="text-xs text-blue-500 mt-0.5">{t('documents.compliance.renewalSuffix')}</div>
                          )}
                        </TableCell>
                      )}
                      {col('owner') && (
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <button
                              className="text-start text-sm font-medium hover:text-primary break-words whitespace-normal max-w-[200px]"
                              onClick={() => setEntityTypeF(doc.entityType)}
                            >
                              {doc.ownerName ?? doc.entityId.slice(0, 8) + '…'}
                            </button>
                            {doc.ownerSystemId && (
                              <span className="text-xs text-muted-foreground font-mono">{doc.ownerSystemId}</span>
                            )}
                            <span className={`text-xs px-1.5 py-0.5 rounded w-fit font-medium ${doc.entityType === 'APPLICANT' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                              {tEnums(`entityType.${doc.entityType}`, { defaultValue: doc.entityType })}
                            </span>
                          </div>
                        </TableCell>
                      )}
                      {col('document') && (
                        <TableCell>
                          <p className="font-medium break-words whitespace-normal max-w-[220px]" title={getDocumentDisplayName(doc.name, doc.documentType?.name)}>{getDocumentDisplayName(doc.name, doc.documentType?.name)}</p>
                          <p className="text-xs text-muted-foreground">{(doc.fileSize / 1024).toFixed(1)} KB</p>
                        </TableCell>
                      )}
                      {col('type') && (
                        <TableCell className="text-muted-foreground">{doc.documentType?.name ?? '—'}</TableCell>
                      )}
                      {col('status') && (
                        <TableCell>
                          {getStatusBadge(doc.status)}
                          {doc.archivedAt && (
                            <span className="ms-1 inline-block px-2 py-0.5 rounded-full text-xs border border-slate-300 text-slate-600 bg-slate-100">
                              {t('documents.compliancePage.archivedBadge', { defaultValue: 'Archived' })}
                            </span>
                          )}
                          {doc.rejectionReason && (
                            <p className="text-xs text-red-500 mt-0.5 max-w-[200px] break-words whitespace-normal" title={doc.rejectionReason}>
                              ✕ {doc.rejectionReason}
                            </p>
                          )}
                        </TableCell>
                      )}
                      {col('expiry') && (
                        <TableCell>
                          {doc.expiryDate
                            ? <>
                                <p className="text-sm">{formatDate(doc.expiryDate)}</p>
                                {daysLeft !== null && daysLeft > 0  && <p className="text-xs text-muted-foreground">{tDC('daysLeft', { count: daysLeft })}</p>}
                                {daysLeft !== null && daysLeft <= 0 && <p className="text-xs text-red-500">{tDC('daysAgo', { count: Math.abs(daysLeft) })}</p>}
                              </>
                            : <span className="text-muted-foreground text-xs">{tDC('naAbbreviation')}</span>}
                        </TableCell>
                      )}
                      {col('verifiedBy') && (
                        <TableCell className="text-xs text-muted-foreground">
                          {verifierName ? (
                            <>
                              <p>{verifierName}</p>
                              {doc.verifiedAt && <p>{formatDate(doc.verifiedAt)}</p>}
                            </>
                          ) : '—'}
                        </TableCell>
                      )}
                      {col('compliance') && (
                        <TableCell>{getComplianceBadge(doc.status)}</TableCell>
                      )}
                      {col('createdAt') && (
                        <TableCell className="text-sm text-muted-foreground">
                          {doc.createdAt ? formatDate(doc.createdAt) : '—'}
                        </TableCell>
                      )}
                      {col('documentNumber') && (
                        <TableCell className="text-sm font-mono">{doc.documentNumber ?? '—'}</TableCell>
                      )}
                      {col('issueDate') && (
                        <TableCell className="text-sm">
                          {doc.issueDate ? formatDate(doc.issueDate) : '—'}
                        </TableCell>
                      )}
                      {col('entityType') && (
                        <TableCell>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${doc.entityType === 'APPLICANT' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                            {doc.entityType === 'APPLICANT' ? 'Applicant' : 'Employee'}
                          </span>
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          {doc.status === 'PENDING' && can('documents', 'update') && (
                            <>
                              <Button size="sm" className="bg-emerald-500 hover:bg-emerald-600 text-white h-7 px-2" onClick={() => handleApprove(doc)} disabled={verifying === doc.id}>
                                <CheckCircle2 className="w-3 h-3 me-1" />{verifying === doc.id ? '…' : tDC('approve')}
                              </Button>
                              <Button size="sm" variant="outline" className="text-red-500 border-red-300 hover:bg-red-50 h-7 px-2" onClick={() => { setRejectDialog({ open: true, docId: doc.id, docName: doc.name }); setRejectionReason(''); }} disabled={verifying === doc.id}>
                                <XCircle className="w-3 h-3 me-1" />{tDC('reject')}
                              </Button>
                            </>
                          )}
                          {(doc.status === 'EXPIRED' || doc.status === 'EXPIRING_SOON' || doc.status === 'VERIFIED') && canCreate('documents') && (
                            <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => openRenewDialog(doc)}>
                              <RefreshCw className="w-3 h-3 me-1" />{tDC('renew')}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" asChild title={tDC('download')}>
                            <a href={getFileUrl(doc.fileUrl)} target="_blank" rel="noopener noreferrer" aria-label={tDC('download')}>
                              <Download className="w-3.5 h-3.5" />
                            </a>
                          </Button>
                          {can('documents', 'read') && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" asChild title={tDC('view')}>
                              <Link to={`/dashboard/documents/${doc.id}`} aria-label={tDC('viewDocument')}>
                                <Eye className="w-3.5 h-3.5" />
                              </Link>
                            </Button>
                          )}
                          {canEdit('documents') && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" asChild title={tDC('edit')}>
                              <Link to={`/dashboard/documents/${doc.id}/edit`} aria-label={tDC('edit')}><Edit className="w-3.5 h-3.5" /></Link>
                            </Button>
                          )}
                          {canEdit('documents') && (
                            doc.archivedAt ? (
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50" onClick={() => handleUnarchive(doc)} title={t('documents.compliancePage.unarchive', { defaultValue: 'Restore to active' })} aria-label={t('documents.compliancePage.unarchive', { defaultValue: 'Restore to active' })}>
                                <ArchiveRestore className="w-3.5 h-3.5" />
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-amber-500 hover:text-amber-700 hover:bg-amber-50" onClick={() => handleArchive(doc)} title={t('documents.compliancePage.archive', { defaultValue: 'Archive (No longer valid)' })} aria-label={t('documents.compliancePage.archive', { defaultValue: 'Archive' })}>
                                <Archive className="w-3.5 h-3.5" />
                              </Button>
                            )
                          )}
                          {canDelete('documents') && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 hover:text-red-600 hover:bg-red-50" onClick={() => handleDelete(doc)} title={tDC('delete')} aria-label={tDC('delete')}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {/* Pagination footer */}
          {meta.totalPages > 1 && (
            <div className="px-4 py-3 border-t flex items-center justify-between text-sm text-muted-foreground">
              <span>{tDC('paginationFooter', { total: meta.total, page: meta.page, totalPages: meta.totalPages })}</span>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => handlePage(page - 1)}><ChevronLeft className="w-4 h-4" /> {tDC('prev')}</Button>
                <Button variant="outline" size="sm" disabled={page >= meta.totalPages} onClick={() => handlePage(page + 1)}>{tDC('next')} <ChevronRight className="w-4 h-4" /></Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
