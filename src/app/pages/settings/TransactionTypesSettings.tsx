import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { settingsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { ArrowLeft, Plus, Pencil, Trash2, CheckCircle, XCircle, DollarSign, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '../../hooks/usePermissions';

type TxType = {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
};

export function TransactionTypesSettings() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canCreate, canEdit, canDelete } = usePermissions();
  const [items, setItems] = useState<TxType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TxType | null>(null);
  const [form, setForm] = useState<{ name: string; sortOrder: number; isActive: boolean }>({
    name: '',
    sortOrder: 100,
    isActive: true,
  });

  const [deleteTarget, setDeleteTarget] = useState<TxType | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await settingsApi.getTransactionTypes(true);
      setItems(data);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.loadFailed')));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    // Default sortOrder puts new entries at the end of the active list.
    const nextOrder = items.length > 0
      ? Math.max(...items.map(i => i.sortOrder)) + 10
      : 10;
    setForm({ name: '', sortOrder: nextOrder, isActive: true });
    setDialogOpen(true);
  };

  const openEdit = (t: TxType) => {
    setEditing(t);
    setForm({ name: t.name, sortOrder: t.sortOrder, isActive: t.isActive });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const trimmed = form.name.trim();
    if (!trimmed) {
      toast.error(tc('toast.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const updated = await settingsApi.updateTransactionType(editing.id, {
          name: trimmed,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
        });
        setItems(prev => prev.map(i => i.id === editing.id ? { ...i, ...updated } : i));
        toast.success(tc('toast.savedSuccessfully'));
      } else {
        const created = await settingsApi.createTransactionType({
          name: trimmed,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
        });
        setItems(prev => [...prev, created]);
        toast.success(tc('toast.savedSuccessfully'));
      }
      setDialogOpen(false);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (t: TxType) => {
    try {
      const updated = await settingsApi.updateTransactionType(t.id, { isActive: !t.isActive });
      setItems(prev => prev.map(i => i.id === t.id ? { ...i, ...updated } : i));
      toast.success(t.isActive ? tc('toast.hiddenFromDropdownNamed', { name: t.name }) : tc('toast.reEnabledNamed', { name: t.name }));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await settingsApi.deleteTransactionType(deleteTarget.id);
      // Soft-delete flips isActive=false — update locally so the row
      // stays visible but renders as inactive.
      setItems(prev => prev.map(i => i.id === deleteTarget.id ? { ...i, isActive: false } : i));
      toast.success(tc('toast.deactivatedNamed', { name: deleteTarget.name }));
      setDeleteTarget(null);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.deleteFailed')));
    } finally {
      setDeleting(false);
    }
  };

  const sorted = [...items].sort((a, b) =>
    a.sortOrder === b.sortOrder
      ? a.name.localeCompare(b.name)
      : a.sortOrder - b.sortOrder,
  );
  const active = sorted.filter(i => i.isActive);
  const inactive = sorted.filter(i => !i.isActive);

  return (
    <div className="p-8 space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/settings"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">{t('settings.transactionTypes.headerTitle')}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Options shown in the "Transaction Type" dropdown when creating a financial record.
            Deactivating a type hides it from the dropdown but keeps existing records intact.
          </p>
        </div>
        {canCreate('settings') && (
          <Button className="bg-[#2563EB] hover:bg-[#1d4ed8]" onClick={openCreate}>
            <Plus className="w-4 h-4 me-2" />New Type
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Active</p>
              <p className="text-2xl font-bold text-emerald-600">{loading ? '—' : active.length}</p>
            </div>
            <CheckCircle className="w-7 h-7 text-emerald-600" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Inactive</p>
              <p className="text-2xl font-bold text-muted-foreground">{loading ? '—' : inactive.length}</p>
            </div>
            <XCircle className="w-7 h-7 text-muted-foreground" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total</p>
              <p className="text-2xl font-bold">{loading ? '—' : items.length}</p>
            </div>
            <DollarSign className="w-7 h-7 text-[#F59E0B]" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Types</CardTitle>
          <CardDescription>Drag-to-reorder isn't wired yet — use Sort Order to position entries in the dropdown.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">{t('settings.transactionTypes.loading')}</div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              No transaction types defined. Click <strong>New Type</strong> to add one.
            </div>
          ) : (
            <ul className="divide-y">
              {sorted.map(t => (
                <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="font-mono text-xs text-muted-foreground w-10 text-end">{t.sortOrder}</span>
                  <span className={`flex-1 text-sm ${t.isActive ? '' : 'text-muted-foreground line-through'}`}>
                    {t.name}
                  </span>
                  <Badge
                    variant={t.isActive ? 'default' : 'secondary'}
                    className={t.isActive ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : ''}
                  >
                    {t.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                  {canEdit('settings') && (
                    <Button variant="outline" size="sm" onClick={() => handleToggleActive(t)}>
                      {t.isActive ? <XCircle className="w-4 h-4 me-1" /> : <CheckCircle className="w-4 h-4 me-1" />}
                      {t.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                  )}
                  {canEdit('settings') && (
                    <Button variant="outline" size="sm" onClick={() => openEdit(t)}>
                      <Pencil className="w-4 h-4 me-1" />Edit
                    </Button>
                  )}
                  {canDelete('settings') && t.isActive && (
                    <Button
                      variant="outline" size="sm"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => setDeleteTarget(t)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={o => !saving && setDialogOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Transaction Type' : 'New Transaction Type'}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'Rename or reorder this type. The label is stored as-is on historical records — renaming here doesn\'t relabel past entries.'
                : 'Add a new option to the finance Transaction Type dropdown.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="tx-name">{t('settings.transactionTypes.nameLabel')}</Label>
              <Input
                id="tx-name"
                placeholder="e.g. Relocation Allowance"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tx-sort">{t('settings.transactionTypes.sortOrderLabel')}</Label>
              <Input
                id="tx-sort"
                type="number"
                value={form.sortOrder}
                onChange={e => setForm(f => ({ ...f, sortOrder: Number(e.target.value) || 0 }))}
              />
              <p className="text-xs text-muted-foreground">{t('settings.transactionTypes.sortOrderHelper')}</p>
            </div>
            <div className="flex items-center justify-between border rounded-lg px-3 py-2">
              <div>
                <Label htmlFor="tx-active">{t('settings.transactionTypes.activeLabel')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.transactionTypes.activeHelper')}</p>
              </div>
              <Switch
                id="tx-active"
                checked={form.isActive}
                onCheckedChange={c => setForm(f => ({ ...f, isActive: c }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              <X className="w-4 h-4 me-2" />Cancel
            </Button>
            <Button
              className="bg-[#2563EB] hover:bg-[#1d4ed8]"
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
            >
              <Save className="w-4 h-4 me-2" />
              {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate transaction type?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.name}</strong> will be hidden from the finance dropdown.
              Records that already use this label keep showing it unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tc('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? 'Deactivating…' : 'Deactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
