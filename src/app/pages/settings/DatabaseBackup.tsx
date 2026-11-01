import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Shield, Download, RotateCcw, Trash2, Eye, CheckCircle2,
  XCircle, RefreshCw, ArrowLeft, HardDrive, Plus, Info, Clock, FileArchive,
  Database,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button }   from '../../components/ui/button';
import { Input }    from '../../components/ui/input';
import { Badge }    from '../../components/ui/badge';
import { Label }    from '../../components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { backupApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { toast } from 'sonner';
import { formatDateTime } from '../../../i18n/formatters';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Backup {
  id:            string;
  fileName:      string;
  fileSize:      number;
  fileSizeHuman: string;
  backupType:    string;
  kind?:         'DATABASE' | 'FULL_SYSTEM';
  kindLabel?:    string;
  /** recovery completeness: COMPLETED = complete recovery point */
  status:        'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INCOMPLETE' | 'DEGRADED';
  recoverability?: 'COMPLETE' | 'DEGRADED' | 'INCOMPLETE' | null;
  /** artifact integrity of the stored bytes — independent of completeness */
  integrity?:    'OK' | 'FAILED' | null;
  recoveryIssues?: { code: string; severity: string; count: number; detail: string; action: string }[];
  notes?:        string;
  errorMessage?: string;
  checksum?:     string | null;
  verifyResult?: 'VERIFIED' | 'FAILED' | null;
  verifiedAt?:   string | null;
  restoreTestedAt?: string | null;
  offsiteStatus?: string;
  fileMissing?:  boolean;
  components?:   any;
  uploadsIncluded?: boolean;
  uploadsCount?: number;
  metadata?:     any;
  createdAt:     string;
  completedAt?:  string;
  createdBy?:    { id: string; name: string; email: string } | null;
  fileExists:    boolean;
}

interface RestoreOption {
  mode:        string;
  label:       string;
  description: string;
  risk:        'LOW' | 'MEDIUM' | 'HIGH';
  notes:       string;
}

interface Preview {
  backup:         Backup;
  fileExists:     boolean;
  warnings:       string[];
  compatibility:  Record<string, any>;
  restoreOptions: RestoreOption[];
}

const RESTORE_CONFIRM = 'RESTORE DATABASE';

const STATUS_BADGE: Record<string, string> = {
  COMPLETED: 'bg-green-100 text-green-800',
  RUNNING:   'bg-blue-100 text-blue-800',
  PENDING:   'bg-yellow-100 text-yellow-800',
  FAILED:    'bg-red-100 text-red-800',
  // Package written but referenced files changed during capture — NOT usable
  // as a full-system backup (never shown as completed/verified).
  INCOMPLETE: 'bg-orange-100 text-orange-800',
  // Consistent, but files referenced by the database exist in no source —
  // a useful partial backup, never a complete recovery point.
  DEGRADED:   'bg-amber-100 text-amber-800',
};
/** statuses that have a stored artifact (verifiable / downloadable) */
const HAS_ARTIFACT = ['COMPLETED', 'DEGRADED', 'INCOMPLETE'];

const RISK_BADGE: Record<string, string> = {
  HIGH:   'bg-red-100 text-red-700',
  MEDIUM: 'bg-amber-100 text-amber-700',
  LOW:    'bg-green-100 text-green-700',
};

function fmt(iso?: string | null): string {
  if (!iso) return '—';
  return formatDateTime(iso);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DatabaseBackup() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const { canEdit } = usePermissions();
  const isAdmin  = canEdit('settings');

  // List state
  const [backups,      setBackups]      = useState<Backup[]>([]);
  const [total,        setTotal]        = useState(0);
  const [page,         setPage]         = useState(1);
  const [totalPages,   setTotalPages]   = useState(1);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [locked,       setLocked]       = useState(false);

  // Create backup modal
  const [showCreate,    setShowCreate]    = useState(false);
  const [createNotes,   setCreateNotes]   = useState('');
  const [createKind,    setCreateKind]    = useState<'DATABASE' | 'FULL_SYSTEM'>('DATABASE');
  const [creating,      setCreating]      = useState(false);

  // Verify / reconcile / preflight
  const [verifyingId,   setVerifyingId]   = useState<string | null>(null);
  const [reconciling,   setReconciling]   = useState(false);
  const [preflight,     setPreflight]     = useState<any | null>(null);
  const [schedule,      setSchedule]      = useState<any | null>(null);

  // Delete modal
  const [deleteTarget,  setDeleteTarget]  = useState<Backup | null>(null);
  const [deleting,      setDeleting]      = useState(false);

  // Restore modal
  const [preview,        setPreview]        = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showRestore,    setShowRestore]    = useState(false);
  const [restoreMode,    setRestoreMode]    = useState('FULL');
  const [confirmPhrase,  setConfirmPhrase]  = useState('');
  const [acceptDegraded, setAcceptDegraded] = useState(false);
  const [restoreNotes,   setRestoreNotes]   = useState('');
  const [skipSafety,     setSkipSafety]     = useState(false);
  const [restoring,      setRestoring]      = useState(false);
  const [restoreResult,  setRestoreResult]  = useState<any | null>(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await backupApi.list({ page, limit: 15, search: search || undefined, status: statusFilter || undefined });
      setBackups(res?.data ?? []);
      setTotal(res?.meta?.total ?? 0);
      setTotalPages(res?.meta?.totalPages ?? 1);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await backupApi.status();
      setLocked(s?.locked ?? false);
    } catch { /* ignore */ }
  }, []);

  const fetchPreflight = useCallback(async () => {
    try { setPreflight(await backupApi.preflight()); } catch { /* ignore */ }
    try { setSchedule(await backupApi.schedule()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchBackups();
    fetchStatus();
    fetchPreflight();
  }, [fetchBackups, fetchStatus, fetchPreflight]);

  // Poll status while locked
  useEffect(() => {
    if (!locked) return;
    const t = setInterval(() => {
      fetchStatus();
      fetchBackups();
    }, 3000);
    return () => clearInterval(t);
  }, [locked, fetchStatus, fetchBackups]);

  // ── Create backup ─────────────────────────────────────────────────────────

  const handleCreate = async () => {
    setCreating(true);
    try {
      await backupApi.create({ notes: createNotes || undefined, kind: createKind });
      toast.success(t('pages:settings.backup.createStarted', { defaultValue: 'Backup started — it runs in the background.' }));
      setShowCreate(false);
      setCreateNotes('');
      fetchBackups();
      fetchStatus();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setCreating(false);
    }
  };

  // ── Verify integrity ────────────────────────────────────────────────────────

  const handleVerify = async (b: Backup) => {
    setVerifyingId(b.id);
    try {
      const res = await backupApi.verify(b.id);
      if (res?.verified) toast.success(t('pages:settings.backup.verifyOk', { defaultValue: 'Integrity verified — complete recovery point.' }));
      else if (res?.integrity === 'OK') toast.warning(t('pages:settings.backup.verifyPartial', { defaultValue: 'Integrity verified, but recovery is {{rec}} — not a complete recovery point.', rec: res?.recoverability }));
      else toast.error(t('pages:settings.backup.verifyFailed', { defaultValue: 'Integrity verification FAILED — see details.' }));
      fetchBackups();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.actionFailed')));
    } finally {
      setVerifyingId(null);
    }
  };

  // ── Reconcile catalog vs disk ─────────────────────────────────────────────────

  const handleReconcile = async () => {
    setReconciling(true);
    try {
      const res = await backupApi.reconcile();
      toast.success(t('pages:settings.backup.reconcileDone', {
        defaultValue: 'Reconciled: {{present}} present, {{missing}} missing of {{total}}.',
        present: res?.present ?? 0, missing: res?.missing ?? 0, total: res?.total ?? 0,
      }));
      fetchBackups();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.actionFailed')));
    } finally {
      setReconciling(false);
    }
  };

  // ── Download ──────────────────────────────────────────────────────────────

  const handleDownload = async (b: Backup) => {
    try {
      await backupApi.download(b.id, b.fileName);
      toast.success(tc('toast.downloadStarted'));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.exportFailed')));
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await backupApi.delete(deleteTarget.id);
      toast.success(tc('toast.deleted'));
      setDeleteTarget(null);
      fetchBackups();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.deleteFailed')));
    } finally {
      setDeleting(false);
    }
  };

  // ── Restore flow ──────────────────────────────────────────────────────────

  const openRestoreModal = async (b: Backup) => {
    setPreviewLoading(true);
    setShowRestore(true);
    setConfirmPhrase('');
    setAcceptDegraded(false);
    setRestoreNotes('');
    setRestoreMode('FULL');
    setSkipSafety(false);
    setRestoreResult(null);
    try {
      const data = await backupApi.preview(b.id);
      setPreview(data);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.loadFailed')));
      setShowRestore(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!preview) return;
    if (confirmPhrase !== RESTORE_CONFIRM) {
      toast.error(tc('toast.typeExactly', { phrase: RESTORE_CONFIRM }));
      return;
    }
    setRestoring(true);
    try {
      const result = await backupApi.restore(preview.backup.id, {
        restoreMode:    restoreMode,
        confirmPhrase,
        notes:          restoreNotes || undefined,
        skipSafetyBackup: skipSafety,
        acceptDegraded: preview.backup.status === 'DEGRADED' ? acceptDegraded : undefined,
      });
      setRestoreResult(result);
      toast.success(tc('toast.savedSuccessfully'));
      fetchBackups();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.operationFailed')));
    } finally {
      setRestoring(false);
    }
  };

  // ── Guard ─────────────────────────────────────────────────────────────────

  if (!isAdmin) {
    return (
      <div className="p-6 flex items-center justify-center min-h-64">
        <div className="text-center">
          <XCircle className="w-12 h-12 mx-auto text-red-500 mb-3" />
          <h2 className="text-lg font-semibold mb-1">{t('settings.databaseBackup.accessDenied')}</h2>
          <p className="text-muted-foreground">{t('settings.databaseBackup.accessDeniedBody')}</p>
        </div>
      </div>
    );
  }

  const completedBackups = backups.filter(b => b.status === 'COMPLETED').length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard/settings')}>
          <ArrowLeft className="w-4 h-4 me-1" />
          {t('settings.databaseBackup.backToSettings')}
        </Button>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
            <Database className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t('settings.databaseBackup.headerTitle')}</h1>
            <p className="text-muted-foreground mt-1">
              {t('settings.databaseBackup.headerSubtitle')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleReconcile} disabled={reconciling} title={t('settings.databaseBackup.reconcileTitle', { defaultValue: 'Reconcile catalog with stored files' })}>
            {reconciling
              ? <><RefreshCw className="w-4 h-4 me-2 animate-spin" />{t('settings.databaseBackup.reconciling', { defaultValue: 'Reconciling…' })}</>
              : <><HardDrive className="w-4 h-4 me-2" />{t('settings.databaseBackup.reconcile', { defaultValue: 'Reconcile' })}</>}
          </Button>
          <Button onClick={() => setShowCreate(true)} disabled={locked}>
            {locked
              ? <><RefreshCw className="w-4 h-4 me-2 animate-spin" />{t('settings.databaseBackup.operationInProgress')}</>
              : <><Plus className="w-4 h-4 me-2" />{t('settings.databaseBackup.createBackup')}</>
            }
          </Button>
        </div>
      </div>

      {/* Preflight banner — surfaces toolchain/connectivity/capacity problems
          (e.g. the pg_dump vs server version mismatch) BEFORE a backup fails. */}
      {preflight && !preflight.ok && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-red-800">
              <p className="font-semibold">{t('settings.databaseBackup.preflightFailed', { defaultValue: 'Backup environment not ready' })}</p>
              <ul className="mt-1 list-disc list-inside space-y-0.5">
                {(preflight.checks ?? []).filter((c: any) => c.state !== 'pass').map((c: any, i: number) => (
                  <li key={i}><span className="font-medium">{c.name}:</span> {c.detail}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {preflight && preflight.ok && (
        <div className="flex items-center gap-2 text-xs text-green-700">
          <CheckCircle2 className="w-4 h-4" />
          {t('settings.databaseBackup.preflightOk', { defaultValue: 'Backup environment ready (PostgreSQL {{major}} toolchain, connectivity, permissions, capacity all OK)', major: preflight.serverMajor ?? '?' })}
        </div>
      )}

      {/* Scheduled-backup status — states plainly whether scheduling is ACTIVE. */}
      {schedule && (
        <div className={`p-3 rounded-lg border text-sm ${schedule.active ? (schedule.stale ? 'bg-red-50 border-red-200 text-red-800' : 'bg-slate-50 border-slate-200 text-slate-700') : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
          <div className="flex items-center gap-2 font-medium">
            <Clock className="w-4 h-4" />
            {schedule.active
              ? t('settings.databaseBackup.scheduleActive', { defaultValue: 'Scheduled {{kind}} backups ACTIVE — cron "{{cron}}" ({{tz}}), next run {{next}}', kind: schedule.kind === 'FULL_SYSTEM' ? 'full-system' : 'database', cron: schedule.cron, tz: schedule.timezone, next: fmt(schedule.nextRun) })
              : t('settings.databaseBackup.scheduleDisabled', { defaultValue: 'Scheduled backups are NOT active (BACKUP_SCHEDULE_CRON is not configured). Only manual backups run.' })}
          </div>
          <div className="mt-1 text-xs">
            {schedule.newestVerified
              ? t('settings.databaseBackup.newestVerified', { defaultValue: 'Newest verified backup: {{age}} h old (stale after {{limit}} h). Retention keeps {{keep}}.', age: Number(schedule.newestVerifiedAgeHours ?? 0).toFixed(1), limit: schedule.staleHours, keep: schedule.retentionCount })
              : t('settings.databaseBackup.noVerified', { defaultValue: 'No verified backup exists yet.' })}
            {schedule.lastRun && <> · {t('settings.databaseBackup.lastScheduled', { defaultValue: 'Last scheduled run: {{outcome}} at {{at}}', outcome: schedule.lastRun.outcome, at: fmt(schedule.lastRun.at) })}</>}
          </div>
        </div>
      )}

      {/* Warning Banner */}
      <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-semibold">{t('settings.databaseBackup.safetyTitle')}</p>
            <ul className="mt-1 list-disc list-inside space-y-1">
              <li>{t('settings.databaseBackup.safetyBulletStorage', { defaultValue: 'Backups are written to BACKUP_DIR (must be a persistent volume) and copied to off-site storage when BACKUP_SPACES_* is configured. A backup that exists only on this server is not disaster recovery.' })}</li>
              <li>{t('settings.databaseBackup.safetyBullet2')}</li>
              <li>{t('settings.databaseBackup.safetyBullet3')}</li>
              <li>{t('settings.databaseBackup.safetyBullet4Pre')} <code className="bg-amber-100 px-1 rounded">pg_dump</code> {t('settings.databaseBackup.safetyBullet4Mid')} <code className="bg-amber-100 px-1 rounded">pg_restore</code> {t('settings.databaseBackup.safetyBullet4Post')} <code className="bg-amber-100 px-1 rounded">PG_BIN_PATH</code> {t('settings.databaseBackup.safetyBullet4Env')}</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('settings.databaseBackup.totalBackups')}</p>
            <p className="text-2xl font-bold text-blue-700">{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('settings.databaseBackup.completed')}</p>
            <p className="text-2xl font-bold text-green-700">{completedBackups}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('settings.databaseBackup.latestBackup')}</p>
            <p className="text-sm font-medium">{backups[0] ? fmt(backups[0].createdAt) : '—'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('settings.databaseBackup.status')}</p>
            <p className={`text-sm font-semibold ${locked ? 'text-blue-600' : 'text-green-600'}`}>
              {locked ? t('settings.databaseBackup.operationRunning') : t('settings.databaseBackup.idle')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder={t('settings.databaseBackup.searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={statusFilter || '__all__'} onValueChange={v => setStatusFilter(v === '__all__' ? '' : v)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('settings.databaseBackup.allStatuses')}</SelectItem>
            <SelectItem value="COMPLETED">{t('settings.databaseBackup.statusCompleted')}</SelectItem>
            <SelectItem value="DEGRADED">{t('settings.databaseBackup.statusDegraded', { defaultValue: 'Degraded (partial)' })}</SelectItem>
            <SelectItem value="INCOMPLETE">{t('settings.databaseBackup.statusIncomplete', { defaultValue: 'Incomplete' })}</SelectItem>
            <SelectItem value="RUNNING">{t('settings.databaseBackup.statusRunning')}</SelectItem>
            <SelectItem value="FAILED">{t('settings.databaseBackup.statusFailed')}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => { fetchBackups(); fetchStatus(); }} disabled={loading}>
          <RefreshCw className={`w-4 h-4 me-1 ${loading ? 'animate-spin' : ''}`} />
          {t('settings.databaseBackup.refresh')}
        </Button>
      </div>

      {/* Backups table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-16 text-center text-muted-foreground">
              <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin opacity-40" />
              <p>{t('settings.databaseBackup.loadingBackups')}</p>
            </div>
          ) : backups.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <FileArchive className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">{t('settings.databaseBackup.noBackupsTitle')}</p>
              <p className="text-sm mt-1">{t('settings.databaseBackup.noBackupsBody')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>{t('settings.databaseBackup.fileName')}</TableHead>
                    <TableHead>{t('settings.databaseBackup.coverage', { defaultValue: 'Coverage' })}</TableHead>
                    <TableHead>{t('settings.databaseBackup.size')}</TableHead>
                    <TableHead>{t('settings.databaseBackup.status')}</TableHead>
                    <TableHead>{t('settings.databaseBackup.integrity', { defaultValue: 'Integrity' })}</TableHead>
                    <TableHead>{t('settings.databaseBackup.createdBy')}</TableHead>
                    <TableHead>{t('settings.databaseBackup.createdAt')}</TableHead>
                    <TableHead>{t('settings.databaseBackup.notes')}</TableHead>
                    <TableHead className="text-end">{t('settings.databaseBackup.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backups.map(b => (
                    <TableRow key={b.id} className="hover:bg-muted/20">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <HardDrive className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div>
                            <div className="font-mono text-xs text-foreground">{b.fileName}</div>
                            {(b.fileMissing || (!b.fileExists && HAS_ARTIFACT.includes(b.status))) && (
                              <div className="text-xs text-red-500">{t('settings.databaseBackup.fileMissing')}</div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const full = b.kind === 'FULL_SYSTEM';
                          const legacy = !b.kind;
                          return (
                            <div className="space-y-0.5">
                              <Badge variant="outline" className={`text-xs ${full ? 'border-indigo-300 text-indigo-700 bg-indigo-50' : 'border-slate-300 text-slate-600 bg-slate-50'}`}>
                                {full ? <FileArchive className="w-3 h-3 me-1" /> : <Database className="w-3 h-3 me-1" />}
                                {b.kindLabel ?? (full ? 'Full System' : legacy ? 'Database (legacy)' : 'Database')}
                              </Badge>
                              <div className="text-[11px] text-muted-foreground">
                                {full
                                  ? t('settings.databaseBackup.coverageFull', { defaultValue: 'DB + globals + {{n}} file(s)', n: b.uploadsCount ?? 0 })
                                  : t('settings.databaseBackup.coverageDb', { defaultValue: 'Database + globals only' })}
                              </div>
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{b.fileSizeHuman}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[b.status] ?? 'bg-gray-100 text-gray-700'}`}>
                          {b.status === 'RUNNING' && <RefreshCw className="w-3 h-3 me-1 animate-spin" />}
                          {b.status}
                        </span>
                        {b.status !== 'COMPLETED' && (b.recoveryIssues?.length ?? 0) > 0 && (
                          <div className="mt-1 space-y-0.5" title={b.recoveryIssues!.map(i => `${i.detail} — ${i.action}`).join('\n')}>
                            {b.recoveryIssues!.map(i => (
                              <div key={i.code} className="text-[11px] text-amber-700">
                                {t('settings.databaseBackup.recoveryIssue', { defaultValue: '{{code}}: {{count}}', code: i.code, count: i.count })}
                              </div>
                            ))}
                            <div className="text-[11px] text-muted-foreground">
                              {t('settings.databaseBackup.notCompleteRecovery', { defaultValue: 'Not a complete recovery point' })}
                            </div>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {HAS_ARTIFACT.includes(b.status) ? (
                          b.verifyResult === 'VERIFIED' ? (
                            <span className="inline-flex items-center text-xs text-green-700"><CheckCircle2 className="w-3.5 h-3.5 me-1" />{t('settings.databaseBackup.integrityVerified', { defaultValue: 'Integrity verified' })}</span>
                          ) : b.verifyResult === 'FAILED' ? (
                            <span className="inline-flex items-center text-xs text-red-600"><XCircle className="w-3.5 h-3.5 me-1" />{t('settings.databaseBackup.verifyFailedShort', { defaultValue: 'Failed' })}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">{t('settings.databaseBackup.notVerified', { defaultValue: 'Not verified' })}</span>
                          )
                        ) : '—'}
                        {b.offsiteStatus === 'VERIFIED' && (
                          <div className="text-[11px] text-emerald-600">{t('settings.databaseBackup.offsiteVerified', { defaultValue: 'Off-site copy verified' })}</div>
                        )}
                        {b.offsiteStatus === 'UPLOADED' && (
                          <div className="text-[11px] text-amber-600">{t('settings.databaseBackup.offsiteUnverified', { defaultValue: 'Off-site uploaded (not verified)' })}</div>
                        )}
                        {(b.offsiteStatus === 'FAILED' || b.offsiteStatus === 'VERIFY_FAILED') && (
                          <div className="text-[11px] text-red-600">{t('settings.databaseBackup.offsiteFailed', { defaultValue: 'Off-site copy FAILED' })}</div>
                        )}
                        {b.offsiteStatus === 'UNKNOWN' && (
                          <div className="text-[11px] text-slate-500">{t('settings.databaseBackup.offsiteUnknown', { defaultValue: 'Off-site status unknown (imported package)' })}</div>
                        )}
                        {(!b.offsiteStatus || b.offsiteStatus === 'NONE') && b.status === 'COMPLETED' && (
                          <div className="text-[11px] text-red-600">{t('settings.databaseBackup.offsiteNone', { defaultValue: 'No off-site copy' })}</div>
                        )}
                        {b.restoreTestedAt && (
                          <div className="text-[11px] text-indigo-600">{t('settings.databaseBackup.restoreTested', { defaultValue: 'Restore-tested' })}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {b.createdBy?.name ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {fmt(b.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[150px] truncate">
                        {b.notes ?? '—'}
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex items-center justify-end gap-1">
                          {HAS_ARTIFACT.includes(b.status) && b.fileExists && (
                            <>
                              <Button
                                variant="ghost" size="sm"
                                onClick={() => handleVerify(b)}
                                disabled={verifyingId === b.id || locked}
                                title={t('settings.databaseBackup.verifyTitle', { defaultValue: 'Verify integrity' })}
                                className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                              >
                                {verifyingId === b.id
                                  ? <RefreshCw className="w-4 h-4 animate-spin" />
                                  : <CheckCircle2 className="w-4 h-4" />}
                              </Button>
                              <Button
                                variant="ghost" size="sm"
                                onClick={() => handleDownload(b)}
                                title={t('settings.databaseBackup.downloadTitle')}
                              >
                                <Download className="w-4 h-4" />
                              </Button>
                              {(b.status === 'COMPLETED' || b.status === 'DEGRADED') && (
                              <Button
                                variant="ghost" size="sm"
                                onClick={() => openRestoreModal(b)}
                                disabled={locked}
                                title={t('settings.databaseBackup.restoreTitle')}
                                className="text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                              >
                                <RotateCcw className="w-4 h-4" />
                              </Button>
                              )}
                            </>
                          )}
                          {b.status !== 'RUNNING' && (
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => setDeleteTarget(b)}
                              title={t('settings.databaseBackup.deleteBackupTitle')}
                              className="text-red-500 hover:text-red-600 hover:bg-red-50"
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
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">{t('settings.databaseBackup.pageOf', { current: page, total: totalPages, count: total })}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('settings.databaseBackup.previous')}</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t('settings.databaseBackup.next')}</Button>
          </div>
        </div>
      )}

      {/* ── Create Backup Modal ──────────────────────────────────────────────── */}
      <Dialog open={showCreate} onOpenChange={o => { if (!o) setShowCreate(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="w-5 h-5 text-blue-600" />
              {t('settings.databaseBackup.createDialogTitle')}
            </DialogTitle>
            <DialogDescription>
              <span dangerouslySetInnerHTML={{ __html: t('settings.databaseBackup.createDialogDescription') }} />
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t('settings.databaseBackup.backupTypeLabel', { defaultValue: 'Backup type' })}</Label>
              <Select value={createKind} onValueChange={v => setCreateKind(v as 'DATABASE' | 'FULL_SYSTEM')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="DATABASE">{t('settings.databaseBackup.kindDatabase', { defaultValue: 'Database only' })}</SelectItem>
                  <SelectItem value="FULL_SYSTEM">{t('settings.databaseBackup.kindFull', { defaultValue: 'Full system (database + uploaded files)' })}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('settings.databaseBackup.notesOptional')}</Label>
              <Input
                placeholder={t('settings.databaseBackup.notesPlaceholder')}
                value={createNotes}
                onChange={e => setCreateNotes(e.target.value)}
              />
            </div>
            {createKind === 'DATABASE' ? (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800 space-y-1">
                <p className="font-medium">{t('settings.databaseBackup.whatsIncludedDb', { defaultValue: 'Database backup includes:' })}</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{t('settings.databaseBackup.inclDb1', { defaultValue: 'Full schema + all data, owners, grants and RLS policies' })}</li>
                  <li>{t('settings.databaseBackup.inclDb2', { defaultValue: 'Cluster globals (roles, memberships) via pg_dumpall' })}</li>
                  <li>{t('settings.databaseBackup.inclDb3', { defaultValue: 'Sequences, constraints, indexes and large objects' })}</li>
                  <li>{t('settings.databaseBackup.inclDb4', { defaultValue: 'Checksums + manifest (verifiable). Does NOT include uploaded files.' })}</li>
                </ul>
              </div>
            ) : (
              <div className="p-3 bg-indigo-50 border border-indigo-200 rounded text-xs text-indigo-800 space-y-1">
                <p className="font-medium">{t('settings.databaseBackup.whatsIncludedFull', { defaultValue: 'Full system backup includes everything in a database backup, plus:' })}</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{t('settings.databaseBackup.inclFull1', { defaultValue: 'All uploaded files (documents, photos, attachments) with checksums' })}</li>
                  <li>{t('settings.databaseBackup.inclFull2', { defaultValue: 'Config templates + release identifiers for a clean-server rebuild' })}</li>
                  <li>{t('settings.databaseBackup.inclFull3', { defaultValue: 'A portable DR package restorable on a clean replacement server' })}</li>
                </ul>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)} disabled={creating}>{t('settings.databaseBackup.cancel')}</Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating
                ? <><RefreshCw className="w-4 h-4 me-2 animate-spin" />{t('settings.databaseBackup.creating')}</>
                : <><Database className="w-4 h-4 me-2" />{t('settings.databaseBackup.createBackup')}</>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirm Modal ─────────────────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={o => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              {t('settings.databaseBackup.deleteDialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.databaseBackup.deleteDialogDescription')}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="py-2 space-y-2">
              <div className="p-3 bg-muted rounded text-sm font-mono">{deleteTarget.fileName}</div>
              <p className="text-sm text-muted-foreground">{t('settings.databaseBackup.sizeLabel', { size: deleteTarget.fileSizeHuman })}</p>
              <p className="text-sm text-muted-foreground">{t('settings.databaseBackup.createdLabel', { date: fmt(deleteTarget.createdAt) })}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>{t('settings.databaseBackup.cancel')}</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting
                ? <><RefreshCw className="w-4 h-4 me-2 animate-spin" />{t('settings.databaseBackup.deleting')}</>
                : <><Trash2 className="w-4 h-4 me-2" />{t('settings.databaseBackup.deleteBackup')}</>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Restore Modal ────────────────────────────────────────────────────── */}
      <Dialog open={showRestore} onOpenChange={o => {
        if (!o && !restoring) { setShowRestore(false); setPreview(null); setRestoreResult(null); }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <RotateCcw className="w-5 h-5" />
              {t('settings.databaseBackup.restoreDialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.databaseBackup.restoreDialogDescription')}
            </DialogDescription>
          </DialogHeader>

          {previewLoading ? (
            <div className="py-8 text-center">
              <RefreshCw className="w-8 h-8 mx-auto animate-spin opacity-40 mb-3" />
              <p className="text-muted-foreground">{t('settings.databaseBackup.loadingPreview')}</p>
            </div>
          ) : restoreResult ? (
            /* ── Success state ── */
            <div className="space-y-4 py-2">
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center gap-2 text-green-800 font-semibold mb-2">
                  <CheckCircle2 className="w-5 h-5" />
                  {t('settings.databaseBackup.restoreCompleted')}
                </div>
                <p className="text-sm text-green-700">{restoreResult.message}</p>
              </div>
              <div className="text-sm space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">{t('settings.databaseBackup.backupLabel')}</span><span className="font-mono">{restoreResult.fileName}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('settings.databaseBackup.modeLabel')}</span><span>{restoreResult.restoreMode}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('settings.databaseBackup.completedLabel')}</span><span>{fmt(restoreResult.completedAt)}</span></div>
                {restoreResult.safetyBackupId && (
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('settings.databaseBackup.safetyBackupId')}</span><span className="font-mono text-xs">{restoreResult.safetyBackupId}</span></div>
                )}
              </div>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 inline me-1" />
                You may need to restart the backend server for all changes to take effect.
              </div>
              <Button className="w-full" onClick={() => { setShowRestore(false); setPreview(null); setRestoreResult(null); }}>
                Close
              </Button>
            </div>
          ) : preview ? (
            /* ── Main restore form ── */
            <div className="space-y-5 py-2">
              {/* Backup summary */}
              <div className="p-4 bg-muted/40 rounded-lg text-sm space-y-2">
                <p className="font-medium flex items-center gap-2"><FileArchive className="w-4 h-4" />{t('settings.databaseBackup.backupDetails')}</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <span className="text-muted-foreground">File</span>
                  <span className="font-mono text-xs">{preview.backup.fileName}</span>
                  <span className="text-muted-foreground">Size</span>
                  <span>{preview.backup.fileSizeHuman}</span>
                  <span className="text-muted-foreground">Created</span>
                  <span>{fmt(preview.backup.createdAt)}</span>
                  <span className="text-muted-foreground">{t('settings.databaseBackup.createdBy')}</span>
                  <span>{preview.backup.createdBy?.name ?? '—'}</span>
                  {preview.backup.metadata?.pgVersion && (
                    <>
                      <span className="text-muted-foreground">PostgreSQL</span>
                      <span className="text-xs">{String(preview.backup.metadata.pgVersion).slice(0, 50)}</span>
                    </>
                  )}
                  {preview.backup.metadata?.estimatedTotalRows != null && (
                    <>
                      <span className="text-muted-foreground">{t('settings.databaseBackup.estRows')}</span>
                      <span>{Number(preview.backup.metadata.estimatedTotalRows).toLocaleString()}</span>
                    </>
                  )}
                  {preview.backup.metadata?.tableCount != null && (
                    <>
                      <span className="text-muted-foreground">Tables</span>
                      <span>{preview.backup.metadata.tableCount}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Warnings */}
              {preview.warnings.length > 0 && (
                <div className="space-y-2">
                  {preview.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Restore mode selector */}
              <div className="space-y-3">
                <Label className="text-sm font-medium">{t('settings.databaseBackup.restoreMode')}</Label>
                <div className="space-y-2">
                  {preview.restoreOptions.map(opt => (
                    <label
                      key={opt.mode}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        restoreMode === opt.mode
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-border hover:bg-muted/30'
                      }`}
                    >
                      <input
                        type="radio"
                        name="restoreMode"
                        value={opt.mode}
                        checked={restoreMode === opt.mode}
                        onChange={() => setRestoreMode(opt.mode)}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{opt.label}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${RISK_BADGE[opt.risk]}`}>
                            {opt.risk} RISK
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                        <p className="text-xs text-amber-700 mt-0.5 flex items-center gap-1">
                          <Info className="w-3 h-3" />{opt.notes}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Safety backup option */}
              <div className="flex items-start gap-2 p-3 bg-green-50 border border-green-200 rounded">
                <Shield className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="skipSafety"
                      checked={skipSafety}
                      onChange={e => setSkipSafety(e.target.checked)}
                      className="w-4 h-4"
                    />
                    <Label htmlFor="skipSafety" className="text-sm cursor-pointer font-medium text-green-800">
                      Skip pre-restore safety backup
                    </Label>
                  </div>
                  <p className="text-xs text-green-700 mt-1 ms-6">
                    By default, a safety backup of the current database is created before restore.
                    Uncheck (default) to keep this protection. Only skip if you are certain.
                  </p>
                </div>
              </div>

              {/* Optional notes */}
              <div className="space-y-1.5">
                <Label className="text-sm">{t('settings.databaseBackup.reasonNotesOptional')}</Label>
                <Input
                  placeholder="e.g. Reverting failed deployment, disaster recovery…"
                  value={restoreNotes}
                  onChange={e => setRestoreNotes(e.target.value)}
                />
              </div>

              {/* Danger warning */}
              <div className="p-4 bg-red-50 border-2 border-red-300 rounded-lg">
                <p className="text-sm font-semibold text-red-800 mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  This will overwrite the current database. This action cannot be undone.
                </p>
                <p className="text-xs text-red-700">
                  All users currently logged in may experience data loss or unexpected behavior.
                  Schedule this during a maintenance window if possible.
                </p>
              </div>

              {preview.backup.status === 'DEGRADED' && (
                <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <input type="checkbox" className="mt-1" checked={acceptDegraded} onChange={e => setAcceptDegraded(e.target.checked)} />
                  <span>
                    {t('settings.databaseBackup.acceptDegraded', { defaultValue: 'This backup is DEGRADED: files referenced by its database are missing from it ({{n}}). I accept restoring the database without them.', n: preview.backup.recoveryIssues?.reduce((a, i) => a + (i.count || 0), 0) ?? '?' })}
                  </span>
                </label>
              )}

              {/* Confirm phrase */}
              <div className="space-y-2">
                <Label className="text-sm">
                  Type{' '}
                  <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-sm">{RESTORE_CONFIRM}</code>
                  {' '}to confirm:
                </Label>
                <Input
                  placeholder={RESTORE_CONFIRM}
                  value={confirmPhrase}
                  onChange={e => setConfirmPhrase(e.target.value)}
                  className="font-mono"
                />
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setShowRestore(false)} disabled={restoring}>
                  {t('settings.databaseBackup.cancel')}
                </Button>
                <Button
                  variant="destructive"
                  disabled={restoring || confirmPhrase !== RESTORE_CONFIRM || !preview.fileExists || (preview.backup.status === 'DEGRADED' && !acceptDegraded)}
                  onClick={handleRestore}
                >
                  {restoring
                    ? <><RefreshCw className="w-4 h-4 me-2 animate-spin" />{t('settings.databaseBackup.restoring')}</>
                    : <><RotateCcw className="w-4 h-4 me-2" />{t('settings.databaseBackup.executeRestore')}</>
                  }
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
