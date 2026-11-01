import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Download, XCircle, RefreshCw, ArrowLeft, Plus, Database } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button }   from '../../components/ui/button';
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

  const [locked, setLocked] = useState(false);

  // Create backup modal
  const [showCreate,    setShowCreate]    = useState(false);
  const [createKind,    setCreateKind]    = useState<'DATABASE' | 'FILES'>('DATABASE');
  const [creating,      setCreating]      = useState(false);

  const [downloadProgress, setDownloadProgress] = useState({ phase: 'choosing', bytes: 0 });
  const [downloadSeconds, setDownloadSeconds] = useState(0);
  const [directHistory, setDirectHistory] = useState<any[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const fetchDirectHistory = useCallback(async () => {
    try { setDirectHistory(await backupApi.directHistory()); setHistoryError(false); }
    catch { setHistoryError(true); }
  }, []);
  useEffect(() => { fetchDirectHistory(); }, [fetchDirectHistory]);
  useEffect(() => {
    if (!creating) return;
    const started = Date.now();
    setDownloadSeconds(0);
    const timer = setInterval(() => setDownloadSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [creating]);

  const downloadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => downloadAbort.current?.abort(), []);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await backupApi.status();
      setLocked(s?.locked ?? false);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!locked) return;
    const timer = setInterval(fetchStatus, 3000);
    return () => clearInterval(timer);
  }, [locked, fetchStatus]);

  // ── Create backup ─────────────────────────────────────────────────────────

  const handleCreate = async () => {
    const abort = new AbortController();
    downloadAbort.current = abort;
    setCreating(true);
    setDownloadProgress({ phase: 'choosing', bytes: 0 });
    try {
      await backupApi.directDownload(createKind, abort.signal, setDownloadProgress);
      toast.success(t('settings.directZip.saved', { defaultValue: 'ZIP download finished. Keep the file on your device.' }));
      setShowCreate(false);
    } catch (err: any) {
      if (err?.name !== 'AbortError') toast.error(apiError(err, tc('toast.exportFailed')));
    } finally {
      downloadAbort.current = null;
      setCreating(false);
      fetchStatus();
      fetchDirectHistory();
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
            <h1 className="text-2xl font-bold">{t('settings.directZip.pageTitle', { defaultValue: 'Backup downloads' })}</h1>
            <p className="text-muted-foreground mt-1">
              {t('settings.directZip.pageSubtitle', { defaultValue: 'Download database and uploaded files as ZIP archives, and review download activity.' })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowCreate(true)} disabled={locked || creating}>
            {locked
              ? <><RefreshCw className="w-4 h-4 me-2 animate-spin" />{t('settings.databaseBackup.operationInProgress')}</>
              : <><Plus className="w-4 h-4 me-2" />{t('settings.directZip.download', { defaultValue: 'Download backup ZIP' })}</>
            }
          </Button>
        </div>
      </div>

      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900">
        {t('settings.directZip.info', { defaultValue: 'Download database.sql inside a ZIP, or uploaded files in a separate ZIP. The archive is streamed to your device and is not saved on the server. Keep this page open until the download finishes. Download operations are recorded in the direct-download history below; archives remain on your device.' })}
        <p className="mt-2">{t('settings.directZip.scope', { defaultValue: 'Files ZIP includes current Spaces objects and uploads on the serving instance. It cannot recover missing files or files held only by another instance. Database SQL contains schema and data, without cluster roles or access grants. Keep the downloaded archives in a safe place.' })}</p>
      </div>

      {/* Direct download audit history */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle>{t('settings.directZip.historyTitle', { defaultValue: 'Direct ZIP download history' })}</CardTitle>
          <CardDescription>{t('settings.directZip.historyNote', { defaultValue: 'Latest 50 operations. Sent means the server finished sending; local file saving is not verified. No archive is stored here.' })}</CardDescription></div>
          <Button variant="outline" onClick={fetchDirectHistory}><RefreshCw className="w-4 h-4" /><span className="sr-only">{t('settings.directZip.refresh', { defaultValue: 'Refresh history' })}</span></Button>
        </CardHeader>
        <CardContent>
          {historyError ? <p role="alert">{t('settings.directZip.historyError', { defaultValue: 'Could not load download history. Try refreshing.' })}</p> :
          <div className="overflow-x-auto"><Table>
            <TableHeader><TableRow>
              {['when', 'who', 'type', 'result', 'size'].map(key => <TableHead key={key}>{t(`settings.directZip.${key}`, { defaultValue: ({ when: 'Started', who: 'Created by', type: 'Backup type', result: 'Result', size: 'ZIP bytes generated' } as any)[key] })}</TableHead>)}
            </TableRow></TableHeader>
            <TableBody>
              {directHistory.length === 0 && <TableRow><TableCell colSpan={5}>{t('settings.directZip.emptyHistory', { defaultValue: 'No direct downloads recorded yet.' })}</TableCell></TableRow>}
              {directHistory.map(row => <TableRow key={row.id}>
                <TableCell>{fmt(row.createdAt)}</TableCell>
                <TableCell><div>{row.userName || row.userEmail || '—'}</div><div className="text-xs text-muted-foreground">{row.userEmail}</div></TableCell>
                <TableCell>{t(`settings.directZip.${row.kind === 'FILES' ? 'files' : 'database'}`)}<div className="text-xs text-muted-foreground break-all">{row.fileName}</div></TableCell>
                <TableCell>{t(`settings.directZip.state${row.state}`, { defaultValue: ({ STARTED: 'Started — awaiting result', STREAMED: 'Sent by server', FAILED: 'Failed', CANCELLED: 'Connection closed / cancelled', UNKNOWN: 'Result unknown (interrupted)' } as any)[row.state] || row.state })}{row.finishedAt && <div className="text-xs text-muted-foreground">{fmt(row.finishedAt)}</div>}</TableCell>
                <TableCell>{(row.bytes / 1048576).toFixed(2)} MiB</TableCell>
              </TableRow>)}
            </TableBody>
          </Table></div>}
        </CardContent>
      </Card>

      {/* ── Create Backup Modal ──────────────────────────────────────────────── */}
      <Dialog open={showCreate} onOpenChange={o => { if (!creating) setShowCreate(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.directZip.download', { defaultValue: 'Download backup ZIP' })}</DialogTitle>
            <DialogDescription>{t('settings.directZip.description', { defaultValue: 'Choose a backup to save on your device. No archive is retained on the server.' })}</DialogDescription>
          </DialogHeader>
          <Select disabled={creating} value={createKind} onValueChange={v => setCreateKind(v as 'DATABASE' | 'FILES')}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="DATABASE">{t('settings.directZip.database', { defaultValue: 'Database — database.sql inside ZIP' })}</SelectItem>
              <SelectItem value="FILES">{t('settings.directZip.files', { defaultValue: 'Uploaded files — one ZIP' })}</SelectItem>
            </SelectContent>
          </Select>
          {creating && <div className="space-y-2 py-3" aria-busy="true">
            <p className="text-sm" role="status">{t(`settings.directZip.phase${downloadProgress.phase}`, { defaultValue: ({ choosing: 'Choose where to save the ZIP…', preparing: 'Preparing backup — waiting for data…', receiving: 'Receiving and saving ZIP…', saving: 'Preparing local download…' } as any)[downloadProgress.phase] })}</p>
            <div role="progressbar" aria-label={t('settings.directZip.downloading', { defaultValue: 'Downloading…' })} aria-valuetext={`${(downloadProgress.bytes / 1048576).toFixed(2)} MiB`} className="h-2 w-full overflow-hidden rounded-full bg-blue-100">
              <div className="h-full w-full rounded-full bg-blue-500 animate-pulse motion-reduce:animate-none" />
            </div>
            <p className="text-sm tabular-nums">{t('settings.directZip.progressDetail', { defaultValue: '{{size}} MiB received · {{seconds}} seconds elapsed', size: (downloadProgress.bytes / 1048576).toFixed(2), seconds: downloadSeconds })}</p>
            <p className="text-xs text-muted-foreground">{t('settings.directZip.noPercent', { defaultValue: 'The final ZIP size is not known yet, so a percentage is unavailable. Keep this page open.' })}</p>
          </div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => creating ? downloadAbort.current?.abort() : setShowCreate(false)}>
              {t('settings.databaseBackup.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={creating || locked}>
              {creating ? <RefreshCw className="w-4 h-4 me-2 animate-spin" /> : <Download className="w-4 h-4 me-2" />}
              {creating ? t('settings.directZip.downloading', { defaultValue: 'Downloading…' }) : t('settings.directZip.download', { defaultValue: 'Download backup ZIP' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
