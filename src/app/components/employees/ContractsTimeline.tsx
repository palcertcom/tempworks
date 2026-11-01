/**
 * ContractsTimeline
 * ─────────────────────────────────────────────────────────────────
 * First-class contract records for an employee, rendered as a
 * chronological timeline (oldest → newest) so the full employment
 * history reads top-to-bottom as a continuous sequence:
 *   Initial contract (2026) → Renewal (2027) → …
 *
 * Distinct from WorkHistoryTimeline (discrete post-hire events). Rows
 * with source=DOCUMENT were auto-created from an uploaded contract
 * document and link back to it.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { contractsApi, type ContractRecord } from '../../services/api';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog';
import { toast } from 'sonner';
import { apiError } from '../../../i18n/apiError';
import { confirm } from '../ui/ConfirmDialog';
import { Plus, Save, Edit2, Trash2, CalendarRange, Link2, LogOut } from 'lucide-react';
import { formatDate } from '../../../i18n/formatters';
import { DateInput } from '../ui/date-input';

function fmt(iso?: string | null) {
  if (!iso) return '—';
  return formatDate(iso);
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE:   'bg-emerald-100 text-emerald-800 border-emerald-200',
  UPCOMING: 'bg-blue-100 text-blue-800 border-blue-200',
  ENDED:    'bg-slate-100 text-slate-700 border-slate-200',
};
const STATUS_DOT: Record<string, string> = {
  ACTIVE:   'bg-emerald-500',
  UPCOMING: 'bg-blue-500',
  ENDED:    'bg-slate-400',
};

interface FormState {
  id?: string;
  startDate: string;
  endDate: string;
  contractType: string;
  notes: string;
  hasDocument?: boolean;      // edit: contract already has a linked doc
  documentName?: string | null;
}
const EMPTY_FORM: FormState = { startDate: '', endDate: '', contractType: 'Full-time', notes: '' };

function durationLabel(start?: string | null, end?: string | null): string {
  if (!start) return '';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const days = Math.max(0, Math.round((e - s) / 86400000));
  if (days < 31) return `${days}d`;
  const months = Math.round(days / 30.44);
  if (months < 12) return `${months} mo`;
  const years = (days / 365.25).toFixed(1).replace(/\.0$/, '');
  return `${years} yr`;
}

export function ContractsTimeline({ employeeId, canWrite }: { employeeId: string; canWrite: boolean }) {
  const { t } = useTranslation('pages');
  const [rows, setRows] = useState<ContractRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  // "End contract" (terminate) dialog.
  const [endOpen, setEndOpen] = useState(false);
  const [endTarget, setEndTarget] = useState<ContractRecord | null>(null);
  const [endDate, setEndDate] = useState('');
  const [endFile, setEndFile] = useState<File | null>(null);
  const [ending, setEnding] = useState(false);

  const load = () => {
    setLoading(true);
    contractsApi.list(employeeId)
      .then(setRows)
      .catch(() => toast.error(t('employees.contracts.loadFailed', { defaultValue: 'Failed to load contracts' })))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [employeeId]);

  const openAdd = () => { setForm(EMPTY_FORM); setFile(null); setDialogOpen(true); };
  const openEdit = (c: ContractRecord) => {
    setForm({
      id: c.id,
      startDate: c.startDate ? c.startDate.slice(0, 10) : '',
      endDate: c.endDate ? c.endDate.slice(0, 10) : '',
      contractType: c.contractType || 'Full-time',
      notes: c.notes ?? '',
      hasDocument: !!c.document,
      documentName: c.document?.name ?? null,
    });
    setFile(null);
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.startDate) {
      toast.error(t('employees.contracts.startRequired', { defaultValue: 'Start date is required' }));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        startDate: form.startDate,
        endDate: form.endDate || null,
        contractType: form.contractType?.trim() || 'Full-time',
        notes: form.notes?.trim() || undefined,
      };
      if (file) {
        // Multipart path — create/update the contract AND upload its
        // document in one request.
        const fd = new FormData();
        fd.append('file', file);
        fd.append('startDate', payload.startDate);
        if (payload.endDate) fd.append('endDate', payload.endDate);
        fd.append('contractType', payload.contractType);
        if (payload.notes) fd.append('notes', payload.notes);
        if (form.id) await contractsApi.updateWithDocument(employeeId, form.id, fd);
        else await contractsApi.createWithDocument(employeeId, fd);
      } else if (form.id) {
        await contractsApi.update(employeeId, form.id, payload);
      } else {
        await contractsApi.create(employeeId, payload);
      }
      toast.success(t('employees.contracts.saved', { defaultValue: 'Contract saved' }));
      setDialogOpen(false);
      load();
    } catch (e: any) {
      toast.error(apiError(e, t('employees.contracts.saveFailed', { defaultValue: 'Failed to save contract' })));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: ContractRecord) => {
    const ok = await confirm({
      title: t('employees.contracts.deleteTitle', { defaultValue: 'Delete contract?' }),
      description: t('employees.contracts.deleteConfirm', { defaultValue: 'This contract record will be removed.' }),
      confirmText: t('common.delete', { defaultValue: 'Delete' }),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await contractsApi.delete(employeeId, c.id);
      toast.success(t('employees.contracts.deleted', { defaultValue: 'Contract deleted' }));
      load();
    } catch (e: any) {
      toast.error(apiError(e, t('employees.contracts.deleteFailed', { defaultValue: 'Failed to delete' })));
    }
  };

  const openEnd = (c: ContractRecord) => {
    setEndTarget(c);
    setEndDate('');
    setEndFile(null);
    setEndOpen(true);
  };
  const saveEnd = async () => {
    if (!endTarget) return;
    if (!endDate) {
      toast.error(t('employees.contracts.endDateRequired', { defaultValue: 'Effective end date is required' }));
      return;
    }
    setEnding(true);
    try {
      if (endFile) {
        const fd = new FormData();
        fd.append('file', endFile);
        fd.append('endDate', endDate);
        await contractsApi.updateWithDocument(employeeId, endTarget.id, fd);
      } else {
        await contractsApi.update(employeeId, endTarget.id, { endDate });
      }
      toast.success(t('employees.contracts.ended', { defaultValue: 'Contract ended' }));
      setEndOpen(false);
      load();
    } catch (e: any) {
      toast.error(apiError(e, t('employees.contracts.endFailed', { defaultValue: 'Failed to end contract' })));
    } finally {
      setEnding(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarRange className="w-4 h-4" />
          {t('employees.contracts.title', { defaultValue: 'Contract Timeline' })}
        </CardTitle>
        {canWrite && (
          <Button size="sm" onClick={openAdd}>
            <Plus className="w-4 h-4 me-1.5" />
            {t('employees.contracts.add', { defaultValue: 'Add Contract' })}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <CalendarRange className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('employees.contracts.empty', { defaultValue: 'No contracts recorded yet.' })}</p>
            <p className="text-xs mt-1">{t('employees.contracts.emptyHint', { defaultValue: 'Upload a contract document or add one manually — they will appear here in chronological order.' })}</p>
          </div>
        ) : (
          <ol className="relative ms-2">
            {/* vertical connecting line */}
            <span className="absolute start-[7px] top-2 bottom-2 w-px bg-border" aria-hidden />
            {rows.map((c, idx) => {
              const status = String(c.status || 'ACTIVE');
              const prev = rows[idx - 1];
              // Gap between the previous contract's end and this start.
              let gapDays = 0;
              if (prev?.endDate && c.startDate) {
                gapDays = Math.round((new Date(c.startDate).getTime() - new Date(prev.endDate).getTime()) / 86400000);
              }
              return (
                <li key={c.id} className="relative ps-7 pb-5 last:pb-0">
                  <span className={`absolute start-0 top-1.5 w-3.5 h-3.5 rounded-full border-2 border-background ${STATUS_DOT[status] ?? 'bg-slate-400'}`} aria-hidden />
                  {gapDays > 1 && (
                    <p className="text-[11px] text-amber-600 mb-1">
                      {t('employees.contracts.gap', { defaultValue: '{{count}}-day gap before this contract', count: gapDays })}
                    </p>
                  )}
                  <div className="rounded-lg border bg-card px-3 py-2.5 group">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">
                            {fmt(c.startDate)} <span className="text-muted-foreground">→</span> {c.endDate ? fmt(c.endDate) : t('employees.contracts.openEnded', { defaultValue: 'Open-ended' })}
                          </span>
                          <Badge variant="outline" className={`text-[10px] uppercase ${STATUS_TONE[status] ?? ''}`}>{status}</Badge>
                          <span className="text-xs text-muted-foreground">· {durationLabel(c.startDate, c.endDate)}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap text-xs text-muted-foreground">
                          <span>{c.contractType}</span>
                          {c.source === 'DOCUMENT' && (
                            <Badge variant="outline" className="text-[10px]">
                              {t('employees.contracts.fromDocument', { defaultValue: 'Auto from document' })}
                            </Badge>
                          )}
                          {c.document && (
                            <Link
                              to={`/dashboard/documents/${c.document.id}`}
                              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                            >
                              <Link2 className="w-3 h-3" />
                              {c.document.name}
                            </Link>
                          )}
                        </div>
                        {c.notes && <p className="text-xs text-muted-foreground mt-1">{c.notes}</p>}
                      </div>
                      {canWrite && (
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          {/* End contract — only meaningful while it's still
                              running (no end date yet, and not ended). */}
                          {!c.endDate && status !== 'ENDED' && (
                            <button title={t('employees.contracts.end', { defaultValue: 'End contract' })} onClick={() => openEnd(c)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-amber-50 text-muted-foreground hover:text-amber-700">
                              <LogOut className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button title={t('common.edit', { defaultValue: 'Edit' })} onClick={() => openEdit(c)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button title={t('common.delete', { defaultValue: 'Delete' })} onClick={() => remove(c)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-50 text-muted-foreground hover:text-red-600">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form.id
                ? t('employees.contracts.editTitle', { defaultValue: 'Edit Contract' })
                : t('employees.contracts.addTitle', { defaultValue: 'Add Contract' })}
            </DialogTitle>
            <DialogDescription>
              {t('employees.contracts.dialogHelp', { defaultValue: 'Contracts are shown in chronological order by start date.' })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('employees.contracts.startDate', { defaultValue: 'Start date' })} *</Label>
              <DateInput value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('employees.contracts.endDate', { defaultValue: 'End date (optional)' })}</Label>
              <DateInput value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label className="text-xs">{t('employees.contracts.type', { defaultValue: 'Contract type' })}</Label>
              <Input value={form.contractType} onChange={e => setForm(f => ({ ...f, contractType: e.target.value }))} placeholder="Full-time" />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label className="text-xs">{t('employees.contracts.notes', { defaultValue: 'Notes' })}</Label>
              <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label className="text-xs">{t('employees.contracts.document', { defaultValue: 'Contract document (optional)' })}</Label>
              <Input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-[11px] text-muted-foreground">
                {form.hasDocument && !file
                  ? t('employees.contracts.docLinked', { defaultValue: 'Linked: {{name}} — choose a file to replace it.', name: form.documentName || '' })
                  : t('employees.contracts.docHelp', { defaultValue: 'Uploads the file as a document and links it to this contract (start/end become the document\'s issue/expiry dates).' })}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
            <Button onClick={save} disabled={saving}>
              <Save className="w-4 h-4 me-1.5" />
              {t('common.save', { defaultValue: 'Save' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* End contract (terminate) dialog */}
      <Dialog open={endOpen} onOpenChange={setEndOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('employees.contracts.endTitle', { defaultValue: 'End contract' })}</DialogTitle>
            <DialogDescription>
              {t('employees.contracts.endHelp', {
                defaultValue: 'Set the effective employment end date. The employee stays Active until this date passes, then changes to Terminated automatically.',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('employees.contracts.effectiveEndDate', { defaultValue: 'Effective end date' })} *</Label>
              <DateInput value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('employees.contracts.terminationDoc', { defaultValue: 'Termination document (optional)' })}</Label>
              <Input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                onChange={e => setEndFile(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEndOpen(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
            <Button onClick={saveEnd} disabled={ending}>
              <LogOut className="w-4 h-4 me-1.5" />
              {t('employees.contracts.end', { defaultValue: 'End contract' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
