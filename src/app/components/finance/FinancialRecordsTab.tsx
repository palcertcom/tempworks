/**
 * FinancialRecordsTab
 *
 * Shared component rendered inside both ApplicantProfile and EmployeeProfile.
 * Displays a double-entry style ledger table:
 *   Credit  = companyDisbursedAmount   (money disbursed BY the company TO the person)
 *   Debit   = deductionAmount          (money recovered through payroll deductions)
 *   Balance = running cumulative: SUM(credit) - SUM(debit)
 *
 * employeeOrAgencyPaidAmount is shown as a separate informational column and does
 * NOT affect the balance calculation.
 *
 * Accounting rules (mirrors backend):
 *   totalDisbursed = SUM(companyDisbursedAmount)
 *   totalDeducted  = SUM(deductionAmount where NOT NULL)
 *   currentBalance = totalDisbursed − totalDeducted
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, Edit2, Trash2, ChevronDown, ChevronUp, Upload, X,
  FileText, Download, TrendingUp, TrendingDown, Wallet,
  CheckCircle, Clock, AlertCircle, Paperclip,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from 'sonner';
import { financeApi, usersApi, getAccessToken } from '../../services/api';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '../../../i18n/formatters';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../ui/field-error';
import { ValidationSummary } from '../ui/validation-summary';
import { DateInput } from '../ui/date-input';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');

// ─── Types ────────────────────────────────────────────────────────────────────

interface FinancialRecord {
  id: string;
  entityType: string;
  entityId: string;
  transactionDate: string;
  currency: string;
  transactionType: string;
  description?: string;
  paymentMethod?: string;
  paidByName?: string;
  paidByUser?: { id: string; firstName: string; lastName: string };
  companyDisbursedAmount: number;
  employeeOrAgencyPaidAmount: number;
  status: 'PENDING' | 'PARTIAL' | 'DEDUCTED';
  deductionAmount?: number;
  deductionDate?: string;
  payrollReference?: string;
  /** Each partial payroll deduction against this record. Sum ≤ companyDisbursedAmount. */
  deductions?: Array<{
    id: string;
    amount: number;
    deductionDate: string;
    payrollReference?: string;
    notes?: string;
    createdAt: string;
    createdBy?: { id: string; firstName: string; lastName: string };
  }>;
  notes?: string;
  attachments?: Attachment[];
  createdAt: string;
}

interface Attachment {
  id: string;
  name: string;
  fileUrl: string;
  mimeType?: string;
  fileSize?: number;
}

interface Constants {
  transactionTypes: string[];
  paymentMethods: string[];
  statuses: string[];
  currencies: string[];
}

interface Totals {
  totalDisbursed: number;
  totalDeducted: number;
  currentBalance: number;
  totalEmpAgency: number;
  recordCount: number;
}

// ─── Empty form defaults ──────────────────────────────────────────────────────

// Helper — the datetime-local <input> needs a local-ish ISO string
// cut at minutes (YYYY-MM-DDTHH:MM), not the UTC slice.
function nowLocalDatetime() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY_FORM = {
  transactionDate: nowLocalDatetime(),
  currency: 'EUR',
  transactionType: '',
  description: '',
  paymentMethod: '',
  paidByName: '',
  paidById: '',
  companyDisbursedAmount: '',
  employeeOrAgencyPaidAmount: '',
  payrollReference: '',
  notes: '',
};

const EMPTY_STATUS_FORM = {
  status: 'DEDUCTED',
  deductionAmount: '',
  deductionDate: '',
  payrollReference: '',
};

// ─── Helper functions ─────────────────────────────────────────────────────────

function fmt(amount: number | undefined | null, currency = 'EUR') {
  if (amount == null || isNaN(Number(amount))) return '—';
  return formatCurrency(Number(amount), currency || 'EUR', { minimumFractionDigits: 2 });
}

function fmtDate(date: string) {
  if (!date) return '—';
  return formatDate(date, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Date + HH:MM on a single line. Used where the clock time matters
 *  (transaction rows, history timeline). Falls back to fmtDate alone
 *  when the value is midnight UTC — the common case for older rows
 *  captured via a date-only picker. */
function fmtDateTime(date: string) {
  if (!date) return '—';
  const d = new Date(date);
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
  if (!hasTime) return fmtDate(date);
  return formatDateTime(d, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  entityType: 'APPLICANT' | 'EMPLOYEE' | 'AGENCY';
  entityId: string;
  /** Display name used for the exported Excel filename. Falls back to
   *  the entity id when omitted so older callers keep working. */
  entityName?: string;
  canWrite: boolean;
  canChangeStatus: boolean;
}

export function FinancialRecordsTab({ entityType, entityId, entityName, canWrite, canChangeStatus }: Props) {
  const { t, i18n } = useTranslation('pages');
  const dir = i18n.dir();
  const [records, setRecords] = useState<FinancialRecord[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [constants, setConstants] = useState<Constants | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Lazy-loaded history per record — fetched the first time the
  // operator expands a row. Keyed by record id.
  const [history, setHistory] = useState<Record<string, any[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});

  const loadHistoryFor = async (recordId: string, force = false) => {
    if (!force && (history[recordId] || historyLoading[recordId])) return;
    setHistoryLoading(h => ({ ...h, [recordId]: true }));
    try {
      const logs = await financeApi.getHistory(recordId);
      setHistory(h => ({ ...h, [recordId]: logs }));
    } catch {
      setHistory(h => ({ ...h, [recordId]: [] }));
    } finally {
      setHistoryLoading(h => ({ ...h, [recordId]: false }));
    }
  };

  // Every mutation invalidates the whole history cache so timelines
  // pick up new audit rows the next time a record is expanded.
  const invalidateHistory = () => { setHistory({}); };

  // Add/Edit modal
  const [showModal, setShowModal] = useState(false);
  const [editRecord, setEditRecord] = useState<FinancialRecord | null>(null);
  const [form, setForm] = useState<Record<string, any>>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();

  // Status modal
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [statusRecord, setStatusRecord] = useState<FinancialRecord | null>(null);
  const [statusForm, setStatusForm] = useState<Record<string, any>>({ ...EMPTY_STATUS_FORM });
  const [savingStatus, setSavingStatus] = useState(false);

  // Delete confirm
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Attachment upload (on existing records via expanded row)
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  // Staff list for "Paid By" dropdown
  const [staffList, setStaffList] = useState<{ id: string; name: string }[]>([]);

  // Pending files queued inside the Add/Edit modal (uploaded after record save)
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  // ── Data loaders ────────────────────────────────────────────────────────────

  const loadRecords = useCallback(async () => {
    try {
      setLoading(true);
      const [res, tots] = await Promise.all([
        financeApi.list({ entityType, entityId, limit: 500 }),
        financeApi.getTotals(entityType, entityId),
      ]);
      const items: FinancialRecord[] = (res as any)?.data ?? [];
      // Sort chronologically for running balance
      items.sort((a, b) => new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime());
      setRecords(items);
      setTotals(tots as Totals);
    } catch {
      toast.error(t('finance.tab.toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, t]);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  useEffect(() => {
    financeApi.getConstants().then(c => setConstants(c as Constants)).catch(() => {});
    // Load all internal staff (agency users + system users) for the Paid By dropdown
    usersApi.list({ limit: 200, status: 'ACTIVE' }).then((res: any) => {
      const users: any[] = res?.data ?? [];
      setStaffList(users.map((u: any) => ({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim() + (u.role ? ` (${u.role})` : ''),
      })));
    }).catch(() => {});
  }, []);

  // ── Running balance ─────────────────────────────────────────────────────────

  const recordsWithBalance = records.map((r, i) => {
    const prevBalance = i === 0 ? 0
      : records.slice(0, i).reduce(
        (acc, prev) => acc + Number(prev.companyDisbursedAmount ?? 0) - Number(prev.deductionAmount ?? 0),
        0,
      );
    const balance = prevBalance + Number(r.companyDisbursedAmount ?? 0) - Number(r.deductionAmount ?? 0);
    return { ...r, runningBalance: balance };
  });

  // ── Modal helpers ───────────────────────────────────────────────────────────

  const openAdd = () => {
    setEditRecord(null);
    setForm({ ...EMPTY_FORM });
    setPendingFiles([]);
    setShowModal(true);
  };

  const openEdit = (rec: FinancialRecord) => {
    setEditRecord(rec);
    setForm({
      // datetime-local wants YYYY-MM-DDTHH:MM in local time, not UTC.
      transactionDate: rec.transactionDate
        ? (() => {
            const d = new Date(rec.transactionDate);
            const pad = (n: number) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          })()
        : '',
      currency: rec.currency ?? 'EUR',
      transactionType: rec.transactionType ?? '',
      description: rec.description ?? '',
      paymentMethod: rec.paymentMethod ?? '',
      paidByName: rec.paidByName ?? '',
      paidById: rec.paidByUser?.id ?? '',
      companyDisbursedAmount: rec.companyDisbursedAmount ?? '',
      employeeOrAgencyPaidAmount: rec.employeeOrAgencyPaidAmount ?? '',
      payrollReference: rec.payrollReference ?? '',
      notes: rec.notes ?? '',
    });
    setPendingFiles([]);
    setShowModal(true);
  };

  const closeModal = () => { setShowModal(false); setEditRecord(null); setPendingFiles([]); };

  const handleSave = async () => {
    clearFieldErrors();
    if (!form.transactionType) { toast.error(t('finance.tab.toast.txTypeRequired')); return; }
    if (!form.transactionDate) { toast.error(t('finance.tab.toast.txDateRequired')); return; }
    if (form.companyDisbursedAmount === '' || Number(form.companyDisbursedAmount) < 0) {
      toast.error(t('finance.tab.toast.amountRequired'));
      return;
    }
    setSaving(true);
    try {
      // Resolve paid-by: prefer dropdown selection, fall back to free-text
      const selectedStaff = staffList.find(s => s.id === form.paidById);
      const payload = {
        entityType,
        entityId,
        transactionDate: form.transactionDate,
        currency: form.currency || 'EUR',
        transactionType: form.transactionType,
        description: form.description || undefined,
        paymentMethod: form.paymentMethod || undefined,
        paidByName: selectedStaff ? selectedStaff.name.split(' (')[0] : (form.paidByName || undefined),
        paidById: form.paidById || undefined,
        companyDisbursedAmount: Number(form.companyDisbursedAmount),
        employeeOrAgencyPaidAmount: Number(form.employeeOrAgencyPaidAmount || 0),
        payrollReference: form.payrollReference || undefined,
        notes: form.notes || undefined,
      };

      let savedId: string;
      if (editRecord) {
        await financeApi.update(editRecord.id, payload);
        savedId = editRecord.id;
        toast.success(t('finance.tab.toast.recordUpdated'));
      } else {
        const created = await financeApi.create(payload) as any;
        savedId = created.id;
        toast.success(t('finance.tab.toast.recordCreated'));
      }

      // Upload any pending files queued inside the modal
      if (pendingFiles.length > 0) {
        await Promise.allSettled(
          pendingFiles.map(file => {
            const fd = new FormData();
            fd.append('file', file);
            return financeApi.addAttachment(savedId, fd);
          }),
        );
        if (pendingFiles.length > 0) toast.success(t('finance.tab.toast.attachmentsUploaded', { count: pendingFiles.length }));
      }

      closeModal();
      invalidateHistory();
      loadRecords();
      // If the row is still expanded, eagerly refresh its timeline so
      // the operator sees the new audit entry without collapsing first.
      if (expandedId) loadHistoryFor(expandedId, true);
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('finance.tab.toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  // ── Status modal ────────────────────────────────────────────────────────────

  const openStatus = (rec: FinancialRecord) => {
    setStatusRecord(rec);
    // Default the amount to the remaining balance so repeated
    // deductions naturally drive the status to DEDUCTED when paid off.
    const alreadyDeducted = (rec.deductions ?? []).reduce((s, d) => s + Number(d.amount ?? 0), 0)
      || Number(rec.deductionAmount ?? 0);
    const remaining = Math.max(0, Number(rec.companyDisbursedAmount ?? 0) - alreadyDeducted);
    setStatusForm({
      status: 'DEDUCTED',
      deductionAmount: remaining || '',
      deductionDate: new Date().toISOString().slice(0, 10),
      payrollReference: '',
    });
    setShowStatusModal(true);
  };

  const handleSaveStatus = async () => {
    if (!statusRecord) return;
    const amount = Number(statusForm.deductionAmount);
    if (!amount || amount <= 0) {
      toast.error(t('finance.tab.toast.deductionGtZero'));
      return;
    }
    const alreadyDeducted = (statusRecord.deductions ?? []).reduce((s, d) => s + Number(d.amount ?? 0), 0)
      || Number(statusRecord.deductionAmount ?? 0);
    const remaining = Number(statusRecord.companyDisbursedAmount) - alreadyDeducted;
    if (amount > remaining + 0.005) {
      toast.error(t('finance.tab.toast.deductionMaxRemaining', { remaining: remaining.toFixed(2) }));
      return;
    }
    setSavingStatus(true);
    try {
      // Append a new partial deduction. The backend keeps the parent
      // record's aggregate fields and status in sync.
      await financeApi.addDeduction(statusRecord.id, {
        amount,
        deductionDate: statusForm.deductionDate || new Date().toISOString().slice(0, 10),
        payrollReference: statusForm.payrollReference || undefined,
      });
      toast.success(Math.abs(amount - remaining) < 0.005
        ? t('finance.tab.toast.fullyDeducted')
        : t('finance.tab.toast.partialDeduction'));
      setShowStatusModal(false);
      invalidateHistory();
      loadRecords();
      // If the row is still expanded, eagerly refresh its timeline so
      // the operator sees the new audit entry without collapsing first.
      if (expandedId) loadHistoryFor(expandedId, true);
    } catch (err: any) {
      toast.error(apiError(err, t('finance.tab.toast.deductionAddFailed')));
    } finally {
      setSavingStatus(false);
    }
  };

  const handleRemoveDeduction = async (deductionId: string) => {
    try {
      await financeApi.removeDeduction(deductionId);
      toast.success(t('finance.tab.toast.deductionRemoved'));
      invalidateHistory();
      loadRecords();
      // If the row is still expanded, eagerly refresh its timeline so
      // the operator sees the new audit entry without collapsing first.
      if (expandedId) loadHistoryFor(expandedId, true);
    } catch (err: any) {
      toast.error(apiError(err, t('finance.tab.toast.deductionRemoveFailed')));
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await financeApi.delete(id);
      toast.success(t('finance.tab.toast.recordDeleted'));
      invalidateHistory();
      loadRecords();
      // If the row is still expanded, eagerly refresh its timeline so
      // the operator sees the new audit entry without collapsing first.
      if (expandedId) loadHistoryFor(expandedId, true);
    } catch (err: any) {
      toast.error(apiError(err, t('finance.tab.toast.deleteFailed')));
    } finally {
      setDeletingId(null);
    }
  };

  // ── Attachment upload ───────────────────────────────────────────────────────

  const handleAttach = async (recordId: string) => {
    if (!attachFile) { toast.error(t('finance.tab.toast.fileRequired')); return; }
    setUploadingAttachment(true);
    try {
      const fd = new FormData();
      fd.append('file', attachFile);
      await financeApi.addAttachment(recordId, fd);
      toast.success(t('finance.tab.toast.attachmentUploaded'));
      setAttachingId(null);
      setAttachFile(null);
      invalidateHistory();
      loadRecords();
      // If the row is still expanded, eagerly refresh its timeline so
      // the operator sees the new audit entry without collapsing first.
      if (expandedId) loadHistoryFor(expandedId, true);
    } catch (err: any) {
      toast.error(apiError(err, t('finance.tab.toast.uploadFailed')));
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleRemoveAttachment = async (recordId: string, attachmentId: string) => {
    try {
      await financeApi.removeAttachment(recordId, attachmentId);
      toast.success(t('finance.tab.toast.attachmentRemoved'));
      invalidateHistory();
      loadRecords();
      // If the row is still expanded, eagerly refresh its timeline so
      // the operator sees the new audit entry without collapsing first.
      if (expandedId) loadHistoryFor(expandedId, true);
    } catch (err: any) {
      toast.error(apiError(err, t('finance.tab.toast.removeFailed')));
    }
  };

  // ── Export ──────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    try {
      const blob = await financeApi.exportExcel({ entityType, entityId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Name after the entity + compact timestamp so finance staff can
      // stash multiple exports of the same person side-by-side without
      // overwriting each other. Sanitise the display name down to
      // filesystem-safe characters and fall back to the id slice.
      const safeName = (entityName ?? '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60)
        || entityId.slice(0, 8);
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
      a.download = `${safeName}_financial_records_${stamp}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(apiError(err, t('finance.tab.toast.exportFailed')));
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          {t('finance.tab.loading')}
        </CardContent>
      </Card>
    );
  }

  const currency = records[0]?.currency ?? 'EUR';

  return (
    <div className="space-y-4">
      {/* Header actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-lg">{t('finance.tab.ledgerTitle')}</h3>
          <Badge variant="outline" className="text-xs">{t('finance.tab.recordCount', { count: records.length })}</Badge>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handleExport}>
            <Download className="w-4 h-4 me-1" />{t('finance.tab.exportExcel')}
          </Button>
          {canWrite && (
            <Button size="sm" onClick={openAdd}>
              <Plus className="w-4 h-4 me-1" />{t('finance.tab.addTransaction')}
            </Button>
          )}
        </div>
      </div>

      {/* Totals summary cards */}
      {totals && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-blue-200 bg-blue-50/40">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center">
                  <TrendingUp className="w-4 h-4 text-blue-600" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{t('finance.tab.totalDisbursed')}</p>
                  <p className="text-xl font-bold text-blue-700">{fmt(totals.totalDisbursed, currency)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-amber-200 bg-amber-50/40">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center">
                  <TrendingDown className="w-4 h-4 text-amber-600" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{t('finance.tab.totalDeducted')}</p>
                  <p className="text-xl font-bold text-amber-700">{fmt(totals.totalDeducted, currency)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className={`border-${totals.currentBalance > 0 ? 'emerald' : 'slate'}-200 bg-${totals.currentBalance > 0 ? 'emerald' : 'slate'}-50/40`}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-3">
                <div className={`w-9 h-9 rounded-lg bg-${totals.currentBalance > 0 ? 'emerald' : 'slate'}-100 flex items-center justify-center`}>
                  <Wallet className={`w-4 h-4 text-${totals.currentBalance > 0 ? 'emerald' : 'slate'}-600`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{t('finance.tab.currentBalance')}</p>
                  <p className={`text-xl font-bold text-${totals.currentBalance > 0 ? 'emerald' : 'slate'}-700`}>
                    {fmt(totals.currentBalance, currency)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Transactions table */}
      <Card>
        <CardContent className="p-0">
          {records.length === 0 ? (
            <div className="py-12 text-center">
              <Wallet className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">{t('finance.tab.empty')}</p>
              {canWrite && (
                <Button size="sm" className="mt-3" onClick={openAdd}>
                  <Plus className="w-4 h-4 me-1" />{t('finance.tab.addFirstTransaction')}
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto" dir={dir}>
              <table className="w-full text-sm" dir={dir}>
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-start px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{t('finance.tab.columns.date')}</th>
                    <th className="text-start px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{t('finance.tab.columns.type')}</th>
                    <th className="text-start px-4 py-3 font-medium text-muted-foreground">{t('finance.tab.columns.description')}</th>
                    <th className="text-start px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{t('finance.tab.columns.stage')}</th>
                    <th className="text-end px-4 py-3 font-medium text-blue-600 whitespace-nowrap">{t('finance.tab.columns.credit')}</th>
                    <th className="text-end px-4 py-3 font-medium text-slate-500 whitespace-nowrap">{t('finance.tab.columns.empAgency')}</th>
                    <th className="text-end px-4 py-3 font-medium text-amber-600 whitespace-nowrap">{t('finance.tab.columns.debit')}</th>
                    <th className="text-end px-4 py-3 font-medium text-emerald-700 whitespace-nowrap">{t('finance.tab.columns.balance')}</th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">{t('finance.tab.columns.status')}</th>
                    <th className="text-end px-4 py-3 font-medium text-muted-foreground">{t('finance.tab.columns.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {recordsWithBalance.map((rec) => (
                    <>
                      <tr
                        key={rec.id}
                        className="border-b hover:bg-muted/20 transition-colors cursor-pointer"
                        onClick={() => {
                          const next = expandedId === rec.id ? null : rec.id;
                          setExpandedId(next);
                          // Lazy-load the change history the first
                          // time the row expands so closed rows don't
                          // cost a request.
                          if (next) loadHistoryFor(rec.id);
                        }}
                      >
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                          {fmtDateTime(rec.transactionDate)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="font-medium">{rec.transactionType}</span>
                        </td>
                        <td className="px-4 py-3 max-w-[200px] truncate text-muted-foreground">
                          {rec.description || '—'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {rec.stageAtCreation && (
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                              rec.stageAtCreation === 'EMPLOYEE'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : rec.stageAtCreation === 'CANDIDATE'
                                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                                  : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}>
                              {rec.stageAtCreation}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-end font-semibold text-blue-700 whitespace-nowrap">
                          {Number(rec.companyDisbursedAmount) > 0
                            ? fmt(rec.companyDisbursedAmount, rec.currency)
                            : <span className="text-muted-foreground font-normal">—</span>}
                        </td>
                        <td className="px-4 py-3 text-end text-slate-500 whitespace-nowrap text-xs">
                          {Number(rec.employeeOrAgencyPaidAmount) > 0
                            ? fmt(rec.employeeOrAgencyPaidAmount, rec.currency)
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-end font-semibold text-amber-700 whitespace-nowrap">
                          {rec.deductionAmount != null && Number(rec.deductionAmount) > 0
                            ? fmt(rec.deductionAmount, rec.currency)
                            : <span className="text-muted-foreground font-normal">—</span>}
                        </td>
                        <td className="px-4 py-3 text-end font-bold whitespace-nowrap">
                          <span className={rec.runningBalance > 0 ? 'text-emerald-700' : rec.runningBalance < 0 ? 'text-red-600' : 'text-slate-500'}>
                            {fmt(rec.runningBalance, rec.currency)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <StatusBadge status={rec.status} />
                        </td>
                        <td className="px-4 py-3 text-end" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {expandedId === rec.id
                              ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                              : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                            {canWrite && (
                              <>
                                <Button
                                  size="icon" variant="ghost"
                                  className="h-7 w-7"
                                  title={t('finance.tab.actionTitles.edit')}
                                  onClick={() => openEdit(rec)}
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </Button>
                                {canChangeStatus && rec.status !== 'DEDUCTED' && (
                                  <Button
                                    size="icon" variant="ghost"
                                    className="h-7 w-7 text-amber-600"
                                    title={rec.status === 'PARTIAL' ? t('finance.tab.actionTitles.addAnotherDeduction') : t('finance.tab.actionTitles.addFirstDeduction')}
                                    onClick={() => openStatus(rec)}
                                  >
                                    <CheckCircle className="w-3.5 h-3.5" />
                                  </Button>
                                )}
                                <Button
                                  size="icon" variant="ghost"
                                  className="h-7 w-7 text-red-500"
                                  title={t('finance.tab.actionTitles.delete')}
                                  disabled={deletingId === rec.id}
                                  onClick={() => handleDelete(rec.id)}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded detail row */}
                      {expandedId === rec.id && (
                        <tr key={`${rec.id}-detail`} className="bg-muted/10 border-b">
                          <td colSpan={10} className="px-6 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                              <div className="space-y-2">
                                <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">{t('finance.tab.expanded.transactionDetails')}</p>
                                {/* Description = customer-facing line shown in the
                                    row above (truncated there). We repeat it in full
                                    here because long descriptions get clipped in the
                                    narrow Description column. */}
                                <InfoItem label={t('finance.tab.expanded.description')} value={rec.description || '—'} />
                                {rec.paymentMethod && <InfoItem label={t('finance.tab.expanded.paymentMethod')} value={rec.paymentMethod} />}
                                {rec.paidByName && <InfoItem label={t('finance.tab.expanded.paidBy')} value={rec.paidByName} />}
                                {rec.paidByUser && <InfoItem label={t('finance.tab.expanded.recordedBy')} value={`${rec.paidByUser.firstName} ${rec.paidByUser.lastName}`} />}
                                <InfoItem label={t('finance.tab.expanded.currency')} value={rec.currency} />
                                {rec.notes && <InfoItem label={t('finance.tab.expanded.internalNotes')} value={rec.notes} />}
                              </div>
                              {/* Deductions — the record can carry any
                                  number of partial payroll deductions.
                                  Always shown; empty state explains how
                                  to start deducting. */}
                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">
                                    {t('finance.tab.expanded.deductions', { count: rec.deductions?.length ?? 0 })}
                                  </p>
                                  {(() => {
                                    const sum = (rec.deductions ?? []).reduce((s, d) => s + Number(d.amount ?? 0), 0)
                                      || Number(rec.deductionAmount ?? 0);
                                    const remaining = Math.max(0, Number(rec.companyDisbursedAmount) - sum);
                                    return (
                                      <span className="text-xs text-muted-foreground">
                                        {fmt(sum, rec.currency)} / {fmt(rec.companyDisbursedAmount, rec.currency)}
                                        {remaining > 0 && <> · remaining <span className="text-amber-700">{fmt(remaining, rec.currency)}</span></>}
                                      </span>
                                    );
                                  })()}
                                </div>
                                {(rec.deductions?.length ?? 0) > 0 ? (
                                  <div className="space-y-1">
                                    {rec.deductions!.map(d => (
                                      <div key={d.id} className="flex items-center justify-between gap-2 px-2 py-1.5 border rounded bg-white text-xs">
                                        <div className="min-w-0 flex-1">
                                          <p className="font-medium text-amber-700">{fmt(d.amount, rec.currency)}</p>
                                          <p className="text-muted-foreground">
                                            {fmtDate(d.deductionDate)}
                                            {d.payrollReference && <> · {d.payrollReference}</>}
                                          </p>
                                        </div>
                                        {canChangeStatus && (
                                          <Button
                                            size="icon" variant="ghost"
                                            className="h-6 w-6 text-red-500 shrink-0"
                                            title={t('finance.tab.actionTitles.removeDeduction')}
                                            onClick={() => handleRemoveDeduction(d.id)}
                                          >
                                            <Trash2 className="w-3 h-3" />
                                          </Button>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-xs text-muted-foreground italic">
                                    No deductions yet — use the <CheckCircle className="inline w-3 h-3 mx-0.5 text-amber-600" /> action to record one.
                                  </p>
                                )}
                                {canChangeStatus && rec.status !== 'DEDUCTED' && (
                                  <Button
                                    size="sm" variant="outline"
                                    className="w-full text-xs mt-1"
                                    onClick={() => openStatus(rec)}
                                  >
                                    <CheckCircle className="w-3 h-3 me-1" />
                                    {rec.status === 'PARTIAL' ? 'Add another deduction' : 'Add first deduction'}
                                  </Button>
                                )}
                              </div>
                              <div className="space-y-2">
                                <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">
                                  Attachments ({rec.attachments?.length ?? 0})
                                </p>
                                {rec.attachments?.map(att => (
                                  <div key={att.id} className="flex items-center justify-between gap-2 p-2 border rounded bg-white">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                                      <a
                                        href={`${att.fileUrl?.startsWith('http') ? '' : API_BASE}${att.fileUrl}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs text-blue-600 hover:underline truncate"
                                      >
                                        {att.name}
                                      </a>
                                    </div>
                                    {canWrite && (
                                      <Button
                                        size="icon" variant="ghost"
                                        className="h-6 w-6 text-red-400 shrink-0"
                                        onClick={() => handleRemoveAttachment(rec.id, att.id)}
                                      >
                                        <X className="w-3 h-3" />
                                      </Button>
                                    )}
                                  </div>
                                ))}
                                {canWrite && attachingId === rec.id ? (
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="file"
                                      accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                      className="text-xs flex-1 min-w-0"
                                      onChange={e => setAttachFile(e.target.files?.[0] ?? null)}
                                    />
                                    <Button
                                      size="sm" className="shrink-0"
                                      disabled={!attachFile || uploadingAttachment}
                                      onClick={() => handleAttach(rec.id)}
                                    >
                                      {uploadingAttachment ? '…' : 'Upload'}
                                    </Button>
                                    <Button
                                      size="icon" variant="ghost"
                                      className="h-7 w-7 shrink-0"
                                      onClick={() => { setAttachingId(null); setAttachFile(null); }}
                                    >
                                      <X className="w-4 h-4" />
                                    </Button>
                                  </div>
                                ) : canWrite ? (
                                  <Button
                                    size="sm" variant="outline"
                                    className="w-full text-xs"
                                    onClick={() => setAttachingId(rec.id)}
                                  >
                                    <Paperclip className="w-3 h-3 me-1" />Attach File
                                  </Button>
                                ) : null}
                              </div>
                            </div>

                            {/* Change History — audit trail of everything
                                that was done to this transaction (create,
                                edits, deductions added/removed, status
                                changes, attachments, delete). Lazy-loaded
                                the first time the row is expanded. */}
                            <div className="mt-6 pt-4 border-t">
                              <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-2">
                                {t('finance.tab.history.title')}
                              </p>
                              {historyLoading[rec.id] ? (
                                <p className="text-xs text-muted-foreground italic">{t('finance.tab.history.loading')}</p>
                              ) : (history[rec.id]?.length ?? 0) === 0 ? (
                                <p className="text-xs text-muted-foreground italic">{t('finance.tab.history.empty')}</p>
                              ) : (
                                <div className="space-y-1.5">
                                  {history[rec.id]!.map((h: any) => (
                                    <HistoryEntry key={h.id} entry={h} currency={rec.currency} />
                                  ))}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>

                {/* Totals footer */}
                {totals && records.length > 0 && (
                  <tfoot>
                    <tr className="bg-muted/30 border-t-2 font-semibold">
                      {/* Label spans Date, Type, Description, Stage so the
                          first monetary cell lines up with Credit (↑). */}
                      <td colSpan={4} className="px-4 py-3 text-sm font-semibold">{t('finance.tab.totals')}</td>
                      <td className="px-4 py-3 text-end text-blue-700">{fmt(totals.totalDisbursed, currency)}</td>
                      <td className="px-4 py-3 text-end text-slate-500 text-xs">{fmt(totals.totalEmpAgency, currency)}</td>
                      <td className="px-4 py-3 text-end text-amber-700">{fmt(totals.totalDeducted, currency)}</td>
                      <td className="px-4 py-3 text-end">
                        <span className={`font-bold ${totals.currentBalance > 0 ? 'text-emerald-700' : totals.currentBalance < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                          {fmt(totals.currentBalance, currency)}
                        </span>
                      </td>
                      {/* Status + Actions are non-numeric — leave them blank. */}
                      <td colSpan={2} />
                    </tr>
                    <tr className="bg-muted/10">
                      <td colSpan={10} className="px-4 py-2 text-xs text-muted-foreground">
                        <span className="text-blue-600 font-medium">{t('finance.tab.footerLegend.creditDef')}</span>{t('finance.tab.footerLegend.creditDescr')} &nbsp;·&nbsp;
                        <span className="text-amber-600 font-medium">{t('finance.tab.footerLegend.debitDef')}</span>{t('finance.tab.footerLegend.debitDescr')} &nbsp;·&nbsp;
                        <span className="text-slate-500">{t('finance.tab.footerLegend.empAgency')}</span>{t('finance.tab.footerLegend.empAgencyDescr')} &nbsp;·&nbsp;
                        <span className="text-emerald-700 font-medium">{t('finance.tab.footerLegend.balance')}</span>{t('finance.tab.footerLegend.balanceDescr')}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Add / Edit Modal ──────────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <Card className="max-w-2xl w-full my-6">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-lg">
                {editRecord ? t('finance.tab.modal.editTitle') : t('finance.tab.modal.newTitle')}
              </CardTitle>
              <Button size="icon" variant="ghost" onClick={closeModal}>
                <X className="w-4 h-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <ValidationSummary errors={fieldErrs} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Date */}
                <div className="space-y-1">
                  <Label className="text-xs">{t('finance.tab.modal.transactionDate')}</Label>
                  <Input
                    type="datetime-local"
                    value={form.transactionDate}
                    onChange={e => setForm(f => ({ ...f, transactionDate: e.target.value }))}
                  />
                </div>
                {/* Currency */}
                <div className="space-y-1">
                  <Label className="text-xs">{t('finance.tab.modal.currency')}</Label>
                  <Select value={form.currency} onValueChange={v => setForm(f => ({ ...f, currency: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(constants?.currencies ?? ['EUR', 'GBP', 'USD']).map(c => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Transaction type */}
                <div className="space-y-1 md:col-span-2">
                  <Label className="text-xs">{t('finance.tab.modal.transactionType')}</Label>
                  <Select value={form.transactionType} onValueChange={v => setForm(f => ({ ...f, transactionType: v }))}>
                    <SelectTrigger><SelectValue placeholder={t('finance.tab.modal.selectTypePh')} /></SelectTrigger>
                    <SelectContent>
                      {(constants?.transactionTypes ?? []).map(tt => (
                        <SelectItem key={tt} value={tt}>{tt}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Description — short summary shown on the table row. */}
                <div className="space-y-1 md:col-span-2">
                  <Label className="text-xs">{t('finance.tab.modal.description')}</Label>
                  <Input
                    placeholder={t('finance.tab.modal.descriptionPh')}
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t('finance.tab.modal.descriptionHelp')}
                  </p>
                </div>
                {/* Company disbursed (Credit) */}
                <div className="space-y-1">
                  <Label className="text-xs text-blue-700">{t('finance.tab.modal.creditAmount')}</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={form.companyDisbursedAmount}
                    onChange={e => setForm(f => ({ ...f, companyDisbursedAmount: e.target.value }))}
                    // Lock the monetary amounts once payroll has been
                    // processed — changing them would silently re-balance
                    // the ledger without matching reality. Reset status
                    // to PENDING first if the amount truly needs fixing.
                    disabled={editRecord?.status === 'DEDUCTED' || editRecord?.status === 'PARTIAL'}
                  />
                  <p className="text-xs text-muted-foreground">
                    {editRecord?.status === 'DEDUCTED'
                      ? t('finance.tab.modal.creditLockedDeducted')
                      : editRecord?.status === 'PARTIAL'
                        ? t('finance.tab.modal.creditLockedPartial')
                        : t('finance.tab.modal.creditHelp')}
                  </p>
                </div>
                {/* Employee/agency paid (informational) */}
                <div className="space-y-1">
                  <Label className="text-xs text-slate-500">{t('finance.tab.modal.empAgencyAmount')}</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={form.employeeOrAgencyPaidAmount}
                    onChange={e => setForm(f => ({ ...f, employeeOrAgencyPaidAmount: e.target.value }))}
                    disabled={editRecord?.status === 'DEDUCTED' || editRecord?.status === 'PARTIAL'}
                  />
                  <p className="text-xs text-muted-foreground">
                    {editRecord?.status === 'DEDUCTED' || editRecord?.status === 'PARTIAL'
                      ? t('finance.tab.modal.empAgencyLocked')
                      : t('finance.tab.modal.empAgencyHelp')}
                  </p>
                </div>

                {/* Show the already-applied deduction amount read-only so
                    the operator can see what was deducted without having
                    to reopen the status dialog. */}
                {editRecord?.status === 'DEDUCTED' && (
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs text-amber-700">{t('finance.tab.modal.deductedAmountLocked')}</Label>
                    <Input
                      type="number"
                      value={editRecord.deductionAmount ?? ''}
                      readOnly
                      disabled
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('finance.tab.modal.deductedRecordedOn', { date: editRecord.deductionDate ? fmtDate(editRecord.deductionDate) : '—' })}
                      {editRecord.payrollReference ? t('finance.tab.modal.deductedPayrollRef', { ref: editRecord.payrollReference }) : ''}
                      {t('finance.tab.modal.deductedHelpAdmin')}
                    </p>
                  </div>
                )}
                {/* Payment method */}
                <div className="space-y-1">
                  <Label className="text-xs">{t('finance.tab.modal.paymentMethod')}</Label>
                  <Select value={form.paymentMethod || '__none__'} onValueChange={v => setForm(f => ({ ...f, paymentMethod: v === '__none__' ? '' : v }))}>
                    <SelectTrigger><SelectValue placeholder={t('finance.tab.modal.selectPh')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t('finance.tab.modal.notSpecified')}</SelectItem>
                      {(constants?.paymentMethods ?? []).map(m => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Paid by — staff dropdown */}
                <div className="space-y-1">
                  <Label className="text-xs">{t('finance.tab.modal.paidByStaff')}</Label>
                  <Select
                    value={form.paidById || '__none__'}
                    onValueChange={v => {
                      if (v === '__none__') {
                        setForm(f => ({ ...f, paidById: '', paidByName: '' }));
                      } else {
                        const staff = staffList.find(s => s.id === v);
                        setForm(f => ({ ...f, paidById: v, paidByName: staff ? staff.name.split(' (')[0] : '' }));
                      }
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder={t('finance.tab.modal.selectStaffPh')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t('finance.tab.modal.notSpecified')}</SelectItem>
                      {staffList.map(s => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Payroll Reference is collected later, when the row is
                    marked DEDUCTED via the status dialog — at creation
                    time there's nothing to reconcile against yet. */}
                {/* Notes — private, long-form context visible only in
                    the expanded panel (not the ledger row). */}
                <div className="space-y-1">
                  <Label className="text-xs">{t('finance.tab.modal.internalNotes')}</Label>
                  <Input
                    placeholder={t('finance.tab.modal.internalNotesPh')}
                    value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t('finance.tab.modal.internalNotesHelp')}
                  </p>
                </div>
              </div>

              {/* Attachments — queue files before saving */}
              <div className="space-y-2 pt-1 border-t">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium flex items-center gap-1.5">
                    <Paperclip className="w-3.5 h-3.5" />
                    {t('finance.tab.modal.attachedDocs')}
                    {pendingFiles.length > 0 && (
                      <Badge variant="outline" className="text-xs ms-1">{t('finance.tab.modal.queued', { count: pendingFiles.length })}</Badge>
                    )}
                  </Label>
                  <label className="cursor-pointer">
                    <span className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium">
                      <Plus className="w-3.5 h-3.5" />{t('finance.tab.modal.addFile')}
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                      multiple
                      className="hidden"
                      onChange={e => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length) setPendingFiles(prev => [...prev, ...files]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
                {/* Existing attachments (edit mode) */}
                {editRecord && (editRecord.attachments ?? []).length > 0 && (
                  <div className="space-y-1">
                    {editRecord.attachments!.map(att => (
                      <div key={att.id} className="flex items-center justify-between gap-2 p-2 border rounded bg-muted/20 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <a href={`${att.fileUrl?.startsWith('http') ? '' : API_BASE}${att.fileUrl}`} target="_blank" rel="noreferrer"
                            className="text-blue-600 hover:underline truncate">{att.name}</a>
                        </div>
                        <Button size="icon" variant="ghost" className="h-5 w-5 text-red-400 shrink-0"
                          onClick={() => handleRemoveAttachment(editRecord.id, att.id)}>
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {/* Pending (new) files */}
                {pendingFiles.length > 0 && (
                  <div className="space-y-1">
                    {pendingFiles.map((file, idx) => (
                      <div key={idx} className="flex items-center justify-between gap-2 p-2 border border-dashed rounded bg-blue-50/40 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                          <span className="truncate text-blue-700">{file.name}</span>
                          <span className="text-muted-foreground shrink-0">({(file.size / 1024).toFixed(0)} KB)</span>
                        </div>
                        <Button size="icon" variant="ghost" className="h-5 w-5 text-red-400 shrink-0"
                          onClick={() => setPendingFiles(prev => prev.filter((_, i) => i !== idx))}>
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {pendingFiles.length === 0 && (!editRecord || (editRecord.attachments ?? []).length === 0) && (
                  <p className="text-xs text-muted-foreground">{t('finance.tab.modal.noFilesAttached')}</p>
                )}
              </div>

              <div className="flex gap-3 pt-2 border-t">
                <Button className="flex-1" onClick={handleSave} disabled={saving}>
                  {saving ? t('finance.tab.modal.saving') : editRecord ? t('finance.tab.modal.saveChanges') : t('finance.tab.modal.createRecord')}
                </Button>
                <Button variant="outline" className="flex-1" onClick={closeModal} disabled={saving}>
                  {t('finance.tab.modal.cancel')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Status / Deduction Modal ──────────────────────────────────────── */}
      {showStatusModal && statusRecord && (() => {
        // Derive the remaining balance so the dialog can cap + label
        // the input accurately whether this is the first, middle, or
        // final deduction of a multi-tranche recovery.
        const alreadyDeducted = (statusRecord.deductions ?? []).reduce((s, d) => s + Number(d.amount ?? 0), 0)
          || Number(statusRecord.deductionAmount ?? 0);
        const disbursed = Number(statusRecord.companyDisbursedAmount ?? 0);
        const remaining = Math.max(0, disbursed - alreadyDeducted);
        const isAdditional = (statusRecord.deductions?.length ?? 0) > 0 || alreadyDeducted > 0;
        return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="max-w-md w-full">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-amber-600" />
                {isAdditional ? t('finance.tab.statusModal.addAnotherTitle') : t('finance.tab.statusModal.addTitle')}
              </CardTitle>
              <Button size="icon" variant="ghost" onClick={() => setShowStatusModal(false)}>
                <X className="w-4 h-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-1">
                <p><span className="text-muted-foreground">{t('finance.tab.statusModal.transaction')}</span> <span className="font-medium">{statusRecord.transactionType}</span></p>
                <p><span className="text-muted-foreground">{t('finance.tab.statusModal.originalAmount')}</span> <span className="font-medium text-blue-700">{fmt(disbursed, statusRecord.currency)}</span></p>
                {isAdditional && (
                  <>
                    <p><span className="text-muted-foreground">{t('finance.tab.statusModal.alreadyDeducted')}</span> <span className="font-medium text-amber-700">{fmt(alreadyDeducted, statusRecord.currency)}</span></p>
                    <p><span className="text-muted-foreground">{t('finance.tab.statusModal.remaining')}</span> <span className="font-medium text-emerald-700">{fmt(remaining, statusRecord.currency)}</span></p>
                  </>
                )}
                {statusRecord.description && <p><span className="text-muted-foreground">{t('finance.tab.statusModal.description')}</span> {statusRecord.description}</p>}
              </div>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs text-amber-700">{t('finance.tab.statusModal.deductionAmount')}</Label>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={remaining}
                    value={statusForm.deductionAmount}
                    onChange={e => setStatusForm(f => ({ ...f, deductionAmount: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">{t('finance.tab.statusModal.deductionAmountHelp', { remaining: fmt(remaining, statusRecord.currency) })}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('finance.tab.statusModal.deductionDate')}</Label>
                  <DateInput
                    value={statusForm.deductionDate}
                    onChange={e => setStatusForm(f => ({ ...f, deductionDate: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('finance.tab.statusModal.payrollReference')}</Label>
                  <Input
                    placeholder={t('finance.tab.statusModal.payrollReferencePh')}
                    value={statusForm.payrollReference}
                    onChange={e => setStatusForm(f => ({ ...f, payrollReference: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex gap-3 pt-2 border-t">
                <Button
                  className="flex-1 bg-amber-600 hover:bg-amber-700"
                  onClick={handleSaveStatus}
                  disabled={savingStatus}
                >
                  {savingStatus ? t('finance.tab.statusModal.saving') : t('finance.tab.statusModal.confirm')}
                </Button>
                <Button variant="outline" className="flex-1" onClick={() => setShowStatusModal(false)} disabled={savingStatus}>
                  {t('finance.tab.statusModal.cancel')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
        );
      })()}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('pages');
  if (status === 'DEDUCTED') {
    return (
      <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 font-medium text-xs">
        <CheckCircle className="w-3 h-3 me-1" />{t('finance.tab.statusBadge.deducted')}
      </Badge>
    );
  }
  if (status === 'PARTIAL') {
    return (
      <Badge className="bg-blue-100 text-blue-800 border-blue-200 font-medium text-xs">
        <Clock className="w-3 h-3 me-1" />{t('finance.tab.statusBadge.partial')}
      </Badge>
    );
  }
  return (
    <Badge className="bg-amber-50 text-amber-700 border-amber-200 font-medium text-xs">
      <Clock className="w-3 h-3 me-1" />{t('finance.tab.statusBadge.pending')}
    </Badge>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// Renders one audit-log entry as a compact two-line card. Accepts the
// currency so monetary diffs can be rendered with the right formatting.
function HistoryEntry({ entry, currency }: { entry: any; currency: string }) {
  const { t } = useTranslation('pages');
  const when = new Date(entry.createdAt);
  const stamp = formatDateTime(when, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const who = entry.user?.name || entry.user?.email || entry.userEmail || t('finance.tab.history.systemUser');

  // Map backend action codes into friendly verbs + tone classes so the
  // panel reads like a timeline rather than a raw log.
  const META: Record<string, { label: string; tone: string }> = {
    FINANCIAL_RECORD_CREATED:            { label: t('finance.tab.history.createdTransaction'),    tone: 'text-blue-700 bg-blue-50 border-blue-200' },
    FINANCIAL_RECORD_UPDATED:            { label: t('finance.tab.history.updatedFields'),         tone: 'text-slate-700 bg-slate-50 border-slate-200' },
    FINANCIAL_RECORD_STATUS_CHANGED:     { label: t('finance.tab.history.changedStatus'),         tone: 'text-amber-700 bg-amber-50 border-amber-200' },
    FINANCIAL_RECORD_DEDUCTION_ADDED:    { label: t('finance.tab.history.addedDeduction'),        tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    FINANCIAL_RECORD_DEDUCTION_REMOVED:  { label: t('finance.tab.history.removedDeduction'),      tone: 'text-red-700 bg-red-50 border-red-200' },
    FINANCIAL_ATTACHMENT_ADDED:          { label: t('finance.tab.history.attachedFile'),          tone: 'text-indigo-700 bg-indigo-50 border-indigo-200' },
    FINANCIAL_ATTACHMENT_REMOVED:        { label: t('finance.tab.history.removedAttachment'),     tone: 'text-red-700 bg-red-50 border-red-200' },
    FINANCIAL_RECORD_DELETED:            { label: t('finance.tab.history.deletedTransaction'),    tone: 'text-red-700 bg-red-50 border-red-200' },
  };
  const meta = META[entry.action] ?? { label: entry.action, tone: 'text-slate-700 bg-slate-50 border-slate-200' };
  const changes = entry.changes ?? {};

  // Build a short human-readable summary of what changed per action.
  const fmtCurrency = (v: any) => {
    const n = Number(v);
    if (Number.isFinite(n)) {
      try { return `${currency} ${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
      catch { return `${currency} ${n.toFixed(2)}`; }
    }
    return String(v);
  };
  const parts: string[] = [];
  switch (entry.action) {
    case 'FINANCIAL_RECORD_CREATED':
      if (changes.transactionType) parts.push(String(changes.transactionType));
      if (changes.companyDisbursedAmount != null) parts.push(fmtCurrency(changes.companyDisbursedAmount));
      break;
    case 'FINANCIAL_RECORD_UPDATED': {
      const diff = changes.diff ?? {};
      Object.entries(diff).forEach(([field, v]: [string, any]) => {
        const isMoney = field === 'companyDisbursedAmount' || field === 'employeeOrAgencyPaidAmount';
        const from = isMoney ? fmtCurrency(v.from) : (v.from ?? '∅');
        const to   = isMoney ? fmtCurrency(v.to)   : (v.to   ?? '∅');
        parts.push(`${field}: ${from} → ${to}`);
      });
      if (parts.length === 0 && Array.isArray(changes.changed) && changes.changed.length > 0) {
        parts.push(changes.changed.join(', '));
      }
      break;
    }
    case 'FINANCIAL_RECORD_STATUS_CHANGED':
      if (changes.oldStatus || changes.newStatus) parts.push(`${changes.oldStatus ?? '?'} → ${changes.newStatus ?? '?'}`);
      if (changes.deductionAmount != null) parts.push(`amount ${fmtCurrency(changes.deductionAmount)}`);
      if (changes.payrollReference) parts.push(`ref ${changes.payrollReference}`);
      break;
    case 'FINANCIAL_RECORD_DEDUCTION_ADDED':
      if (changes.amount != null) parts.push(fmtCurrency(changes.amount));
      if (changes.deductionDate) parts.push(`on ${changes.deductionDate}`);
      if (changes.payrollReference) parts.push(`ref ${changes.payrollReference}`);
      if (changes.runningTotal != null) parts.push(`total ${fmtCurrency(changes.runningTotal)}`);
      if (changes.nextStatus) parts.push(`→ ${changes.nextStatus}`);
      break;
    case 'FINANCIAL_RECORD_DEDUCTION_REMOVED':
      if (changes.removedAmount != null) parts.push(`−${fmtCurrency(changes.removedAmount)}`);
      if (changes.runningTotal != null) parts.push(`total ${fmtCurrency(changes.runningTotal)}`);
      if (changes.nextStatus) parts.push(`→ ${changes.nextStatus}`);
      break;
    case 'FINANCIAL_ATTACHMENT_ADDED':
    case 'FINANCIAL_ATTACHMENT_REMOVED':
      if (changes.name) parts.push(changes.name);
      break;
  }

  return (
    <div className={`flex items-start justify-between gap-3 px-2.5 py-1.5 border rounded text-xs ${meta.tone}`}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{meta.label}</p>
        {parts.length > 0 && (
          <p className="text-[11px] text-muted-foreground break-words">{parts.join(' · ')}</p>
        )}
      </div>
      <div className="text-end shrink-0">
        <p className="font-medium">{who}</p>
        <p className="text-[11px] text-muted-foreground">{stamp}</p>
      </div>
    </div>
  );
}
