/**
 * Phase 3 Reports Hardening — Phase C (sharing UI).
 *
 * Manage-access modal for a saved report. Owner-only or callers who
 * already hold a SHARE-level grant can open this — the parent
 * component is responsible for hiding the trigger; the backend is the
 * final authority (rejects with 404 if the actor can't share).
 *
 * The user picker is tenant-scoped because `usersApi.list()` is
 * already tenant-scoped on the backend for non-SUPER callers, and the
 * backend rejects cross-tenant grants (`REPORT.SHARE_CROSS_TENANT`).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Trash2, UserPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { reportsApi, usersApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';

type Permission = 'VIEW' | 'RUN' | 'EDIT' | 'SHARE';
type Visibility = 'PRIVATE' | 'SHARED' | 'PUBLIC_IN_TENANT';

interface Share {
  userId: string;
  permission: Permission;
  grantedById?: string | null;
  grantedAt?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  report: {
    id: string;
    name: string;
    visibility: Visibility;
    createdById?: string | null;
    shares?: Share[];
  };
  /** Called after a successful share / revoke / visibility change so
   *  the parent can refresh its saved-reports list. */
  onChanged: () => void | Promise<void>;
}

export function ShareReportDialog({ open, onClose, report, onChanged }: Props) {
  const { t } = useTranslation('pages');
  const [users, setUsers] = useState<any[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [search, setSearch] = useState('');
  const [pickedUserId, setPickedUserId] = useState<string>('');
  const [permission, setPermission] = useState<Permission>('VIEW');
  const [busy, setBusy] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>(report.visibility);

  useEffect(() => { setVisibility(report.visibility); }, [report.visibility, open]);

  useEffect(() => {
    if (!open) return;
    setLoadingUsers(true);
    usersApi.list({ limit: 200 })
      .then((res: any) => setUsers(Array.isArray(res?.data) ? res.data : []))
      .catch(() => setUsers([]))
      .finally(() => setLoadingUsers(false));
  }, [open]);

  const userNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const u of users) m[u.id] = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || u.id;
    return m;
  }, [users]);

  const sharedIds = useMemo(() => new Set((report.shares ?? []).map(s => s.userId)), [report.shares]);

  // Filter the picker to users in the same tenant (the backend list is
  // already tenant-scoped for non-SUPER) AND exclude the owner and
  // anyone already on the share list.
  const pickerOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter(u => u.id !== report.createdById && !sharedIds.has(u.id))
      .filter(u => {
        if (!q) return true;
        const name = `${u.firstName ?? ''} ${u.lastName ?? ''} ${u.email ?? ''}`.toLowerCase();
        return name.includes(q);
      })
      .slice(0, 50);
  }, [users, search, sharedIds, report.createdById]);

  const handleVisibility = async (next: Visibility) => {
    if (next === visibility) return;
    setBusy(true);
    try {
      await reportsApi.setVisibility(report.id, next);
      setVisibility(next);
      toast.success(t('reports.sharing.toast.visibility'));
      await onChanged();
    } catch (err) {
      toast.error(apiError(err, t('reports.sharing.toast.visibilityFailed')));
    } finally {
      setBusy(false);
    }
  };

  const handleShare = async () => {
    if (!pickedUserId) return;
    setBusy(true);
    try {
      await reportsApi.share(report.id, pickedUserId, permission);
      toast.success(t('reports.sharing.toast.shared'));
      setPickedUserId('');
      setSearch('');
      await onChanged();
    } catch (err) {
      toast.error(apiError(err, t('reports.sharing.toast.shareFailed')));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (userId: string) => {
    setBusy(true);
    try {
      await reportsApi.revokeShare(report.id, userId);
      toast.success(t('reports.sharing.toast.revoked'));
      await onChanged();
    } catch (err) {
      toast.error(apiError(err, t('reports.sharing.toast.revokeFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('reports.sharing.modalTitle', { name: report.name })}
          </DialogTitle>
        </DialogHeader>

        {/* Visibility */}
        <div className="space-y-2">
          <Label className="text-xs">{t('reports.visibility.label')}</Label>
          <Select value={visibility} onValueChange={(v) => handleVisibility(v as Visibility)} disabled={busy}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="PRIVATE">{t('reports.visibility.private')}</SelectItem>
              <SelectItem value="SHARED">{t('reports.visibility.shared')}</SelectItem>
              <SelectItem value="PUBLIC_IN_TENANT">{t('reports.visibility.publicInTenant')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Add access */}
        <div className="space-y-2 pt-2 border-t">
          <Label className="text-xs">{t('reports.sharing.pickUser')}</Label>
          <Input
            placeholder={t('reports.sharing.searchUserPh')}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPickedUserId(''); }}
          />
          {loadingUsers ? (
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />…
            </div>
          ) : (
            <Select value={pickedUserId} onValueChange={setPickedUserId} disabled={busy || pickerOptions.length === 0}>
              <SelectTrigger><SelectValue placeholder={t('reports.sharing.pickUser')} /></SelectTrigger>
              <SelectContent>
                {pickerOptions.map((u) => {
                  // Prefer the business user number (e.g. U00012) over the
                  // raw UUID — operators recognise it from emails / chats.
                  // Falls back to the email or a short hash only when we
                  // have nothing better.
                  const displayName = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || u.id;
                  const businessId = (u as any).userNumber ?? null;
                  return (
                    <SelectItem key={u.id} value={u.id}>
                      <span className="font-medium">{displayName}</span>
                      {businessId && <span className="ms-2 font-mono text-xs text-muted-foreground">{businessId}</span>}
                      {u.email && <span className="ms-2 text-muted-foreground text-xs">{u.email}</span>}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">{t('reports.sharing.permissionLabel')}</Label>
              <Select value={permission} onValueChange={(v) => setPermission(v as Permission)} disabled={busy}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="VIEW">{t('reports.sharing.permission.view')}</SelectItem>
                  <SelectItem value="RUN">{t('reports.sharing.permission.run')}</SelectItem>
                  <SelectItem value="EDIT">{t('reports.sharing.permission.edit')}</SelectItem>
                  <SelectItem value="SHARE">{t('reports.sharing.permission.share')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" onClick={handleShare} disabled={busy || !pickedUserId}>
              <UserPlus className="w-3.5 h-3.5 me-1" />
              {t('reports.sharing.addAccess')}
            </Button>
          </div>
        </div>

        {/* Current shares */}
        <div className="space-y-2 pt-2 border-t">
          <Label className="text-xs">{t('reports.sharing.manageAccess')}</Label>
          {(!report.shares || report.shares.length === 0) ? (
            <p className="text-xs text-muted-foreground">{t('reports.sharing.noShares')}</p>
          ) : (
            <ul className="space-y-1 max-h-48 overflow-y-auto">
              {report.shares.map((s) => (
                <li key={s.userId} className="flex items-center justify-between gap-2 rounded border p-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{userNameById[s.userId] ?? s.userId}</div>
                    <div className="text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px] me-1">
                        {t(`reports.sharing.permission.${s.permission.toLowerCase()}`)}
                      </Badge>
                      {s.grantedById && userNameById[s.grantedById] && (
                        <span>{t('reports.sharing.grantedBy', { name: userNameById[s.grantedById] })}</span>
                      )}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" className="text-[#EF4444]" disabled={busy} onClick={() => handleRevoke(s.userId)}>
                    <Trash2 className="w-3.5 h-3.5 me-1" />
                    {t('reports.sharing.revokeAccess')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('actions.close', { ns: 'common', defaultValue: 'Close' })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
