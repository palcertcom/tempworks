import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Trash2, Edit2, Save, X, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { vehiclesApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { confirm } from '../../components/ui/ConfirmDialog';

interface MaintenanceType {
  id: string;
  name: string;
  description?: string;
  defaultIntervalDays?: number;
  defaultIntervalKm?: number;
  intervalMode?: 'DAYS' | 'KM' | 'BOTH';
  isActive: boolean;
}

interface FormData {
  name: string;
  description: string;
  defaultIntervalDays: string;
  defaultIntervalKm: string;
  intervalMode: 'DAYS' | 'KM' | 'BOTH';
}

const INITIAL_FORM: FormData = {
  name: '',
  description: '',
  defaultIntervalDays: '',
  defaultIntervalKm: '',
  intervalMode: 'KM',
};

export function MaintenanceTypesSettings() {
  const { t } = useTranslation('common');
  const { t: tp } = useTranslation('pages');
  const { canEdit } = usePermissions();
  const isAdmin = canEdit('settings');
  const [maintenanceTypes, setMaintenanceTypes] = useState<MaintenanceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(INITIAL_FORM);

  useEffect(() => {
    loadMaintenanceTypes();
  }, []);

  const loadMaintenanceTypes = async () => {
    setLoading(true);
    try {
      const data = await vehiclesApi.listMaintenanceTypes();
      setMaintenanceTypes(data);
    } catch {
      toast.error(t('toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!form.name.trim()) {
      toast.error(t('toast.nameRequired'));
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: form.name,
        description: form.description || undefined,
        defaultIntervalDays: form.defaultIntervalDays ? parseInt(form.defaultIntervalDays) : undefined,
        defaultIntervalKm: form.defaultIntervalKm ? parseInt(form.defaultIntervalKm) : undefined,
        intervalMode: form.intervalMode,
      };

      if (editingId) {
        await vehiclesApi.updateMaintenanceType(editingId, payload);
        toast.success(t('toast.savedSuccessfully'));
        setEditingId(null);
      } else {
        await vehiclesApi.createMaintenanceType(payload);
        toast.success(t('toast.savedSuccessfully'));
      }

      setForm(INITIAL_FORM);
      await loadMaintenanceTypes();
    } catch (err: any) {
      toast.error(apiError(err, t('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (mt: MaintenanceType) => {
    setEditingId(mt.id);
    setForm({
      name: mt.name,
      description: mt.description || '',
      defaultIntervalDays: mt.defaultIntervalDays?.toString() || '',
      defaultIntervalKm: mt.defaultIntervalKm?.toString() || '',
      intervalMode: mt.intervalMode || 'KM',
    });
  };

  const handleCancel = () => {
    setEditingId(null);
    setForm(INITIAL_FORM);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirm({
      title: t('confirm.deleteMaintenanceTypeTitle'),
      description: t('confirm.deleteMaintenanceTypeBodyNamed', { name }),
      confirmText: t('actions.delete'),
      tone: 'destructive',
    }))) return;

    try {
      await vehiclesApi.deleteMaintenanceType(id);
      toast.success(t('toast.deleted'));
      await loadMaintenanceTypes();
    } catch {
      toast.error(t('toast.deleteFailed'));
    }
  };

  if (!isAdmin) {
    return <div className="text-center py-16 text-muted-foreground">{tp('settings.maintenanceTypes.accessDenied')}</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/settings"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Wrench className="w-6 h-6 text-blue-600" /> {tp('settings.maintenanceTypes.headerTitle')}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {tp('settings.maintenanceTypes.headerSubtitle')}
          </p>
        </div>
      </div>

      {/* Form Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {editingId ? tp('settings.maintenanceTypes.formCardTitleEdit') : tp('settings.maintenanceTypes.formCardTitleAdd')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium">{tp('settings.maintenanceTypes.nameLabel')}</label>
            <Input
              placeholder="e.g. Oil Change, Brake Service, Annual Inspection"
              value={form.name}
              onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium">{tp('settings.maintenanceTypes.descriptionLabel')}</label>
            <Textarea
              placeholder="e.g. Oil and filter change, check fluid levels"
              value={form.description}
              onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
              className="mt-1 h-20 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">{tp('settings.maintenanceTypes.intervalDaysLabel')}</label>
              <Input
                type="number"
                placeholder="e.g. 365"
                value={form.defaultIntervalDays}
                onChange={(e) => setForm(prev => ({ ...prev, defaultIntervalDays: e.target.value }))}
                className="mt-1"
                min="0"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{tp('settings.maintenanceTypes.intervalKmLabel')}</label>
              <Input
                type="number"
                placeholder="e.g. 10000"
                value={form.defaultIntervalKm}
                onChange={(e) => setForm(prev => ({ ...prev, defaultIntervalKm: e.target.value }))}
                className="mt-1"
                min="0"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">{tp('settings.maintenanceTypes.intervalModeLabel')}</label>
            <Select value={form.intervalMode} onValueChange={(v: any) => setForm(prev => ({ ...prev, intervalMode: v }))}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DAYS">{tp('settings.maintenanceTypes.modeDays')}</SelectItem>
                <SelectItem value="KM">{tp('settings.maintenanceTypes.modeKm')}</SelectItem>
                <SelectItem value="BOTH">{tp('settings.maintenanceTypes.modeBoth')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {tp('settings.maintenanceTypes.intervalModeHelper')}
            </p>
          </div>

          <div className="flex gap-2 pt-2">
            <Button onClick={handleAdd} disabled={saving} className="gap-2">
              <Save className="w-4 h-4" />
              {saving ? 'Saving…' : editingId ? 'Update' : 'Add'}
            </Button>
            {editingId && (
              <Button variant="outline" onClick={handleCancel} className="gap-2">
                <X className="w-4 h-4" /> Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* List Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Maintenance Types ({maintenanceTypes.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground text-sm">{tp('settings.maintenanceTypes.loading')}</p>
          ) : maintenanceTypes.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">{tp('settings.maintenanceTypes.empty')}</p>
          ) : (
            <div className="space-y-2">
              {maintenanceTypes.map((mt) => (
                <div key={mt.id} className="p-4 border rounded-lg space-y-2 hover:bg-accent/50">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <p className="font-medium text-sm">{mt.name}</p>
                      {mt.description && (
                        <p className="text-xs text-muted-foreground">{mt.description}</p>
                      )}
                      <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                        {mt.intervalMode && (
                          <span>Mode: <span className="font-medium text-foreground">{mt.intervalMode === 'BOTH' ? 'Whichever comes first' : mt.intervalMode}</span></span>
                        )}
                        {mt.defaultIntervalDays && (
                          <span>Days: <span className="font-medium text-foreground">{mt.defaultIntervalDays}</span></span>
                        )}
                        {mt.defaultIntervalKm && (
                          <span>Km: <span className="font-medium text-foreground">{mt.defaultIntervalKm}</span></span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleEdit(mt)}
                        disabled={editingId === mt.id}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDelete(mt.id, mt.name)}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
