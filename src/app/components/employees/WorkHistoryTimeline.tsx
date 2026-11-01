/**
 * WorkHistoryTimeline
 * ─────────────────────────────────────────────────────────────────
 * Post-hire contract timeline shown inside the Employee Profile's
 * Contracts tab. Deliberately kept separate from Workflow History —
 * no pipeline / stage events ever appear here.
 *
 * Ordering: newest first (date desc, createdAt desc) so operators
 * see the latest contract event at the top of the list.
 */
import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { employeeWorkHistoryApi, usersApi, settingsApi } from '../../services/api';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog';
import { toast } from 'sonner';
import { apiError } from '../../../i18n/apiError';
import { confirm } from '../ui/ConfirmDialog';
import {
  Plus, Save, X, FileText, Paperclip, Trash2, Download, Edit2, CheckCircle2,
  LogOut, Clock, Coffee, XOctagon, BadgeCheck,
} from 'lucide-react';
import { formatDate } from '../../../i18n/formatters';
import { DateInput } from '../ui/date-input';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');

// Fallback icons + tones for the seven built-in event types. When an
// operator adds a new type via Settings, we pick a neutral icon/tone
// so the timeline still renders consistently.
const EVENT_TONE_HINTS: Record<string, { icon: any; tone: string }> = {
  NEW_CONTRACT:       { icon: BadgeCheck,  tone: 'emerald' },
  PROBATION_START:    { icon: Clock,       tone: 'blue' },
  PROBATION_END:      { icon: CheckCircle2, tone: 'blue' },
  END_OF_CONTRACT:    { icon: LogOut,      tone: 'amber' },
  UNPAID_LEAVE_START: { icon: Coffee,      tone: 'slate' },
  UNPAID_LEAVE_END:   { icon: Coffee,      tone: 'slate' },
  TERMINATED:         { icon: XOctagon,    tone: 'red' },
};
const DEFAULT_EVENT_META = { icon: FileText, tone: 'slate' };

type EventTypeValue = string;
type EventTypeOption = { value: string; label: string; icon: any; tone: string };

const TONE_CLASS: Record<string, string> = {
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  blue:    'bg-blue-100 text-blue-800 border-blue-200',
  amber:   'bg-amber-100 text-amber-800 border-amber-200',
  slate:   'bg-slate-100 text-slate-700 border-slate-200',
  red:     'bg-red-100 text-red-800 border-red-200',
};

const TONE_DOT: Record<string, string> = {
  emerald: 'bg-emerald-500',
  blue:    'bg-blue-500',
  amber:   'bg-amber-500',
  slate:   'bg-slate-400',
  red:     'bg-red-500',
};

function fmtDate(iso?: string) {
  if (!iso) return '—';
  return formatDate(iso);
}

function fullName(u?: { firstName?: string; lastName?: string; email?: string } | null) {
  if (!u) return '';
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '';
}

interface Props {
  employeeId: string;
  canWrite: boolean;
}

export function WorkHistoryTimeline({ employeeId, canWrite }: Props) {
  const { t, i18n } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const dir = i18n.dir();
  const [entries, setEntries]  = useState<any[]>([]);
  const [loading, setLoading]  = useState(true);
  const [users,   setUsers]    = useState<any[]>([]);
  // Event type options come from Settings → Work History Event Types.
  // Falls back to the 7 built-in values if the endpoint returns empty.
  const [eventTypes, setEventTypes] = useState<EventTypeOption[]>([]);

  // Dialog state — shared between "add new entry" and "edit existing".
  const [open, setOpen]        = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<{ date: string; eventType: EventTypeValue; description: string; approvedById: string; effectiveDate: string }>({
    date: new Date().toISOString().slice(0, 10),
    eventType: 'NEW_CONTRACT',
    description: '',
    approvedById: '',
    effectiveDate: '',
  });
  // Event types that close the current contract when given an
  // effective date (kept in sync with the backend).
  const CONTRACT_ENDING_TYPES = ['TERMINATED', 'END_OF_CONTRACT'];
  const [saving, setSaving]    = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await employeeWorkHistoryApi.list(employeeId);
      setEntries(Array.isArray(list) ? list : []);
    } catch (err: any) {
      toast.error(err?.message || t('employees.workHistory.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Only hit the users list when the operator can actually write —
    // the Approved By picker is the only consumer.
    if (canWrite) {
      usersApi.list({ limit: 200 }).then((res: any) => setUsers(res?.data ?? [])).catch(() => setUsers([]));
    }
    // Always load the event types so the timeline can resolve labels
    // for any value (including custom Settings-defined ones) when
    // rendering historical rows.
    settingsApi
      .getWorkHistoryEventTypes(false)
      .then((list: any[]) => {
        const options = (Array.isArray(list) ? list : []).map((t: any) => ({
          value: t.value,
          label: t.label,
          ...(EVENT_TONE_HINTS[t.value] ?? DEFAULT_EVENT_META),
        }));
        setEventTypes(options);
      })
      .catch(() => setEventTypes([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, canWrite]);

  // Resolve metadata for a given event type value, falling back to
  // a humanised version of the value when nothing matches (e.g. a
  // type that was later deleted from Settings).
  const resolveMeta = (value: string) => {
    const opt = eventTypes.find(o => o.value === value);
    if (opt) return opt;
    return {
      value,
      label: value.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      ...(EVENT_TONE_HINTS[value] ?? DEFAULT_EVENT_META),
    };
  };

  const openCreate = () => {
    setEditingId(null);
    // Default to the first active event type from Settings; if the
    // list is empty (pre-seed or all deactivated), fall back to the
    // legacy NEW_CONTRACT value so the dialog still opens cleanly.
    const defaultType = eventTypes[0]?.value ?? 'NEW_CONTRACT';
    setForm({
      date: new Date().toISOString().slice(0, 10),
      eventType: defaultType,
      description: '',
      approvedById: '',
      effectiveDate: '',
    });
    setOpen(true);
  };

  const openEdit = (entry: any) => {
    setEditingId(entry.id);
    setForm({
      date: entry.date ? String(entry.date).slice(0, 10) : '',
      eventType: entry.eventType,
      description: entry.description ?? '',
      approvedById: entry.approvedBy?.id ?? '',
      effectiveDate: entry.effectiveDate ? String(entry.effectiveDate).slice(0, 10) : '',
    });
    setOpen(true);
  };

  const handleSave = async () => {
    if (!form.date)      { toast.error(tc('toast.dateRequired')); return; }
    if (!form.eventType) { toast.error(tc('toast.eventTypeRequired')); return; }
    setSaving(true);
    try {
      const payload = {
        date: form.date,
        eventType: form.eventType,
        description: form.description.trim() || undefined,
        approvedById: form.approvedById || undefined,
        effectiveDate: form.effectiveDate || undefined,
      };
      if (editingId) {
        await employeeWorkHistoryApi.update(employeeId, editingId, payload);
        toast.success(tc('toast.entryUpdated'));
      } else {
        await employeeWorkHistoryApi.create(employeeId, payload);
        toast.success(tc('toast.entryAdded'));
      }
      setOpen(false);
      load();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (entry: any) => {
    const ok = await confirm({
      title: t('common:confirm.deleteWorkHistoryTitle'),
      description: t('common:confirm.deleteWorkHistoryBody', { label: resolveMeta(entry.eventType).label, date: fmtDate(entry.date) }),
      confirmText: t('common:actions.delete'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await employeeWorkHistoryApi.delete(employeeId, entry.id);
      toast.success(tc('toast.entryDeleted'));
      load();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.deleteFailed')));
    }
  };

  const handleAttach = async (entryId: string, file: File) => {
    setUploadingId(entryId);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await employeeWorkHistoryApi.addAttachment(employeeId, entryId, fd);
      toast.success(tc('toast.attachmentUploaded'));
      load();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.uploadFailed')));
    } finally {
      setUploadingId(null);
    }
  };

  const handleRemoveAttachment = async (entryId: string, attachmentId: string, name: string) => {
    const ok = await confirm({
      title: t('common:confirm.removeAttachmentTitle'),
      description: t('common:confirm.deleteDocumentBodyNamed', { name }),
      confirmText: t('common:actions.remove'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await employeeWorkHistoryApi.removeAttachment(employeeId, entryId, attachmentId);
      toast.success(tc('toast.attachmentRemoved'));
      load();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.deleteFailed')));
    }
  };

  const userOptions = useMemo(() => users.filter((u: any) => !u.deletedAt), [users]);

  return (
    <Card dir={dir}>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />{t('employees.workHistory.title')}
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {t('employees.workHistory.subtitle')}
          </p>
        </div>
        {canWrite && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4 me-1" />{t('employees.workHistoryTimeline.addEntry')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="py-8 text-center text-muted-foreground text-sm">{tc('states.loading')}</p>
        ) : entries.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground text-sm">
            {t('employees.workHistoryTimeline.empty')} {canWrite && t('employees.workHistoryTimeline.emptyHint')}
          </div>
        ) : (
          <ol className="relative border-s-2 border-muted/60 ms-2 space-y-5">
            {entries.map((entry: any) => {
              const meta = resolveMeta(entry.eventType);
              const Icon = meta.icon;
              return (
                <li key={entry.id} className="ps-5 relative">
                  <span className={`absolute -start-[9px] top-1 w-4 h-4 rounded-full border-2 border-background ${TONE_DOT[meta.tone]}`} />
                  <div className="rounded-lg border bg-card p-3">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className={TONE_CLASS[meta.tone]}>
                            <Icon className="w-3 h-3 me-1" />{meta.label}
                          </Badge>
                          <span className="text-sm font-medium">{fmtDate(entry.date)}</span>
                        </div>
                        {entry.description && (
                          <p className="text-sm mt-2 whitespace-pre-wrap">{entry.description}</p>
                        )}
                        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground flex-wrap">
                          {entry.createdBy && (
                            <span>{t('employees.workHistoryTimeline.createdBy')} <strong className="text-foreground">{fullName(entry.createdBy)}</strong></span>
                          )}
                          {entry.approvedBy && (
                            <span>{t('employees.workHistoryTimeline.approvedBy')} <strong className="text-foreground">{fullName(entry.approvedBy)}</strong></span>
                          )}
                          <span>· {fmtDate(entry.createdAt)}</span>
                        </div>

                        {/* Attachments */}
                        {(entry.attachments?.length ?? 0) > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {entry.attachments.map((att: any) => (
                              <div key={att.id} className="flex items-center gap-1.5 px-2 py-1 border rounded bg-muted/30 text-xs">
                                <Paperclip className="w-3 h-3 text-muted-foreground" />
                                <a href={`${att.fileUrl?.startsWith('http') ? '' : API_BASE}${att.fileUrl}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate max-w-[14rem]">
                                  {att.name}
                                </a>
                                <a href={`${att.fileUrl?.startsWith('http') ? '' : API_BASE}${att.fileUrl}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                                  <Download className="w-3 h-3" />
                                </a>
                                {canWrite && (
                                  <button
                                    onClick={() => handleRemoveAttachment(entry.id, att.id, att.name)}
                                    className="text-red-400 hover:text-red-600"
                                    aria-label={t('employees.workHistory.removeAttachment')}
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {canWrite && (
                        <div className="flex items-center gap-1 shrink-0">
                          {/* Attach file — hidden native input driven by the paperclip icon. */}
                          <label className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted cursor-pointer" title={t('employees.workHistory.attachFile')}>
                            <Paperclip className="w-3.5 h-3.5" />
                            <input
                              type="file"
                              className="hidden"
                              accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                              disabled={uploadingId === entry.id}
                              onChange={e => {
                                const f = e.target.files?.[0];
                                if (f) handleAttach(entry.id, f);
                                e.target.value = '';
                              }}
                            />
                          </label>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(entry)} title={t('employees.workHistory.edit')}>
                            <Edit2 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500" onClick={() => handleDelete(entry)} title={t('employees.workHistory.delete')}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
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

      {/* Add / edit dialog */}
      <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? t('employees.workHistoryTimeline.editTitle') : t('employees.workHistoryTimeline.addTitle')}</DialogTitle>
            <DialogDescription>{t('employees.workHistoryTimeline.dialogIntro')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="wh-date" className="text-xs">{t('employees.workHistoryTimeline.date')}</Label>
                <DateInput id="wh-date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div>
                <Label className="text-xs">{t('employees.workHistoryTimeline.eventType')}</Label>
                <Select value={form.eventType} onValueChange={(v) => setForm(f => ({ ...f, eventType: v as EventTypeValue }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {eventTypes.length === 0 ? (
                      <SelectItem value="__empty__" disabled>
                        <span className="text-muted-foreground italic">{t('employees.workHistoryTimeline.noEventTypes')}</span>
                      </SelectItem>
                    ) : (
                      eventTypes.map(e => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Effective end date — closes the current contract when set
                on a termination / end-of-contract event. */}
            {CONTRACT_ENDING_TYPES.includes(form.eventType) && (
              <div>
                <Label htmlFor="wh-eff" className="text-xs">
                  {t('employees.workHistoryTimeline.effectiveEndDate', { defaultValue: 'Effective employment end date' })}
                </Label>
                <DateInput id="wh-eff" value={form.effectiveDate} onChange={e => setForm(f => ({ ...f, effectiveDate: e.target.value }))} />
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t('employees.workHistoryTimeline.effectiveEndHelp', {
                    defaultValue: 'Closes the current contract on this date and appears on the Contract Timeline. The employee stays Active until this date passes.',
                  })}
                </p>
              </div>
            )}
            <div>
              <Label htmlFor="wh-desc" className="text-xs">{t('employees.workHistoryTimeline.description')}</Label>
              <Input
                id="wh-desc"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder={t('employees.workHistoryTimeline.descriptionPh')}
              />
            </div>
            <div>
              <Label className="text-xs">{t('employees.workHistoryTimeline.approvedByLabel')}</Label>
              <Select value={form.approvedById || '__none__'} onValueChange={(v) => setForm(f => ({ ...f, approvedById: v === '__none__' ? '' : v }))}>
                <SelectTrigger><SelectValue placeholder={t('employees.workHistoryTimeline.none')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__"><span className="text-muted-foreground">{t('employees.workHistoryTimeline.notSpecified')}</span></SelectItem>
                  {userOptions.map((u: any) => (
                    <SelectItem key={u.id} value={u.id}>
                      {fullName(u) || u.email}
                      {u.userNumber && <span className="ms-2 font-mono text-xs text-muted-foreground">{u.userNumber}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}><X className="w-4 h-4 me-2" />{tc('actions.cancel')}</Button>
            <Button onClick={handleSave} disabled={saving}><Save className="w-4 h-4 me-2" />{saving ? tc('states.saving') : tc('actions.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
