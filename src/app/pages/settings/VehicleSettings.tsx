import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Trash2, Save, Truck, Edit2, X, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { Badge } from '../../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { settingsApi, vehiclesApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { confirm } from '../../components/ui/ConfirmDialog';

// Centralised set of every vehicle lookup list shown on this page. The
// short keys must match the backend (settings.service.ts → VEHICLE_LOOKUP_KEYS).
// Sections group them by where they appear on the Vehicle form so the
// admin UX matches the data-entry UX.
type LookupKey =
  | 'vehicleTypes'
  | 'statuses' | 'fuelTypes' | 'documentTypes' | 'insuranceTypes' | 'euroEmissionClasses'
  | 'bodyTypes' | 'hitchTypes'
  | 'tankMaterials' | 'adrClasses'
  | 'vinSubTypes' | 'insuranceGroups';

interface LookupDef {
  key:         LookupKey;
  label:       string;
  description: string;
  placeholder: string;
}

interface MaintenanceType {
  id: string;
  name: string;
  description?: string;
  defaultIntervalDays?: number;
  defaultIntervalKm?: number;
  intervalMode?: 'DAYS' | 'KM' | 'BOTH';
  isActive: boolean;
}

interface MaintenanceTypeForm {
  name: string;
  description: string;
  defaultIntervalDays: string;
  defaultIntervalKm: string;
  intervalMode: 'DAYS' | 'KM' | 'BOTH';
}

interface SectionDef {
  id:    string;
  label: string;
  desc:  string;
  items: LookupDef[];
}

const SECTIONS: SectionDef[] = [
  {
    id: 'common',
    label: 'Common',
    desc: 'Lookup lists that appear on every vehicle profile',
    items: [
      { key: 'vehicleTypes',        label: 'Vehicle Types',        description: 'Categories shown in the Vehicle Type dropdown — drives type-specific form sections (Truck, Tanker, …)', placeholder: 'e.g. Forklift' },
      { key: 'statuses',            label: 'Vehicle Statuses',     description: 'Statuses available in the vehicle profile', placeholder: 'e.g. Rented' },
      { key: 'fuelTypes',           label: 'Fuel Types',           description: 'Fuel types selectable on the vehicle form',  placeholder: 'e.g. Hydrogen' },
      { key: 'insuranceTypes',      label: 'Insurance Types',      description: 'Insurance type values (Comprehensive, …)',   placeholder: 'e.g. Goods in Transit' },
      { key: 'documentTypes',       label: 'Vehicle Document Types', description: 'Used by the Documents tab on a vehicle',    placeholder: 'e.g. Inspection' },
      { key: 'euroEmissionClasses', label: 'Euro Emission Classes', description: 'Emission classes for trucks/trailers',      placeholder: 'e.g. Euro VI' },
    ],
  },
  {
    id: 'truck',
    label: 'Trucks & Trailers',
    desc: 'Lookups specific to trucks and trailer combinations',
    items: [
      { key: 'bodyTypes',  label: 'Body Types',         description: 'Flatbed, curtainsider, box, tipper, …',                  placeholder: 'e.g. Walking Floor' },
      { key: 'hitchTypes', label: 'Trailer Hitch Types', description: '5th wheel, drawbar, pintle, …',                          placeholder: 'e.g. Goose Neck' },
    ],
  },
  {
    id: 'tanker',
    label: 'Tanker',
    desc: 'Tanker-only lookup lists',
    items: [
      { key: 'tankMaterials', label: 'Tank Materials', description: 'Stainless steel, aluminium, …',                placeholder: 'e.g. Carbon Steel' },
      { key: 'adrClasses',    label: 'ADR Classes',    description: 'Hazardous-goods classification (1–9)',         placeholder: 'e.g. 3 Flammable Liquids' },
    ],
  },
  {
    id: 'car',
    label: 'Cars',
    desc: 'Lookups used on the Car form',
    items: [
      { key: 'vinSubTypes',     label: 'VIN Sub-types',    description: 'Saloon, hatchback, SUV, …',                  placeholder: 'e.g. Coupe' },
      { key: 'insuranceGroups', label: 'Insurance Groups', description: 'Insurance group identifiers',                placeholder: 'e.g. 30' },
    ],
  },
];

/** Inline list editor — input + chips with remove buttons. */
function LookupListEditor({
  def,
  values,
  onChange,
  canEdit,
}: {
  def:      LookupDef;
  values:   string[];
  onChange: (next: string[]) => void;
  canEdit:  boolean;
}) {
  const [draft, setDraft] = useState('');
  const { t: tCommon } = useTranslation('common');

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
      toast.error(tCommon('toast.valueAlreadyExists'));
      return;
    }
    onChange([...values, trimmed]);
    setDraft('');
  };

  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  return (
    <Card className="border-blue-100">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {def.label}
          <Badge variant="outline" className="font-normal text-xs">{values.length}</Badge>
        </CardTitle>
        <CardDescription>{def.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canEdit && (
          <div className="flex gap-2">
            <Input
              placeholder={def.placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
            />
            <Button type="button" onClick={add} className="gap-1.5"><Plus className="w-4 h-4" /> Add</Button>
          </div>
        )}
        {values.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4 border-2 border-dashed rounded-lg">
            No values defined — vehicle forms will show an empty dropdown.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {values.map((v) => (
              <span key={v} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-muted text-sm border">
                {v}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => remove(v)}
                    className="text-muted-foreground hover:text-red-500"
                    aria-label={`Remove ${v}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const INITIAL_MT_FORM: MaintenanceTypeForm = {
  name: '',
  description: '',
  defaultIntervalDays: '',
  defaultIntervalKm: '',
  intervalMode: 'KM',
};

/** Maintenance type manager — CRUD interface for service types. */
function MaintenanceTypesEditor({
  types,
  onAdd,
  onUpdate,
  onDelete,
  saving,
  canEdit,
}: {
  types: MaintenanceType[];
  onAdd: (data: Omit<MaintenanceType, 'id' | 'isActive'>) => Promise<void>;
  onUpdate: (id: string, data: Omit<MaintenanceType, 'id' | 'isActive'>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  saving: boolean;
  canEdit: boolean;
}) {
  const { t } = useTranslation('common');
  const { t: tp } = useTranslation('pages');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<MaintenanceTypeForm>(INITIAL_MT_FORM);

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error(t('toast.nameRequired'));
      return;
    }

    const payload = {
      name: form.name,
      description: form.description || undefined,
      defaultIntervalDays: form.defaultIntervalDays ? parseInt(form.defaultIntervalDays) : undefined,
      defaultIntervalKm: form.defaultIntervalKm ? parseInt(form.defaultIntervalKm) : undefined,
      intervalMode: form.intervalMode,
      isActive: true,
    };

    try {
      if (editingId) {
        await onUpdate(editingId, payload);
        toast.success(t('toast.savedSuccessfully'));
      } else {
        await onAdd(payload);
        toast.success(t('toast.savedSuccessfully'));
      }
      setForm(INITIAL_MT_FORM);
      setEditingId(null);
    } catch (err: any) {
      toast.error(apiError(err, t('toast.saveFailed')));
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
    setForm(INITIAL_MT_FORM);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirm({
      title: t('confirm.deleteMaintenanceTypeTitle'),
      description: t('confirm.deleteMaintenanceTypeBodyNamed', { name }),
      confirmText: t('actions.delete'),
      tone: 'destructive',
    }))) return;

    try {
      await onDelete(id);
      toast.success(t('toast.deleted'));
    } catch {
      toast.error(t('toast.deleteFailed'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Maintenance Service Types ({types.length})</CardTitle>
        <CardDescription>Configure service types available for vehicle maintenance tracking (Oil Change, Brake Service, TÜV Inspection, etc.)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Form Section */}
        <div className="border-b pb-6">
          <h3 className="text-sm font-semibold mb-4">{editingId ? 'Edit' : 'Add'} Maintenance Type</h3>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{tp('settings.maintenanceTypes.nameLabel')}</label>
              <Input
                placeholder="e.g. Oil Change, Brake Service, Annual Inspection"
                value={form.name}
                onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                className="mt-1"
                disabled={!canEdit}
              />
            </div>

            <div>
              <label className="text-sm font-medium">Description</label>
              <Textarea
                placeholder="e.g. Oil and filter change, check fluid levels"
                value={form.description}
                onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
                className="mt-1 h-20 resize-none"
                disabled={!canEdit}
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
                  disabled={!canEdit}
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
                  disabled={!canEdit}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">{tp('settings.maintenanceTypes.intervalModeLabel')}</label>
              <Select value={form.intervalMode} onValueChange={(v: any) => setForm(prev => ({ ...prev, intervalMode: v }))}>
                <SelectTrigger className="mt-1" disabled={!canEdit}>
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
              <Button onClick={handleSave} disabled={saving || !canEdit} className="gap-2">
                <Save className="w-4 h-4" />
                {saving ? 'Saving…' : editingId ? 'Update' : 'Add'}
              </Button>
              {editingId && (
                <Button variant="outline" onClick={handleCancel} className="gap-2" disabled={!canEdit}>
                  <X className="w-4 h-4" /> Cancel
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* List Section */}
        {types.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">{tp('settings.maintenanceTypes.empty')}</p>
        ) : (
          <div className="space-y-2">
            {types.map((mt) => (
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
                      disabled={editingId === mt.id || !canEdit}
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDelete(mt.id, mt.name)}
                      disabled={!canEdit}
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
  );
}

export function VehicleSettings() {
  const { t: tv } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canEdit } = usePermissions();
  const isAdmin = canEdit('settings');
  const [data, setData] = useState<Record<LookupKey, string[]> | null>(null);
  const [original, setOriginal] = useState<Record<LookupKey, string[]> | null>(null);
  const [maintenanceTypes, setMaintenanceTypes] = useState<MaintenanceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      settingsApi.getVehicleSettings(),
      vehiclesApi.listMaintenanceTypes(),
    ])
      .then(([res, mtypes]) => {
        const safe: any = {};
        SECTIONS.flatMap((s) => s.items).forEach((d) => {
          safe[d.key] = Array.isArray((res as any)[d.key]) ? (res as any)[d.key] : [];
        });
        setData(safe);
        setOriginal(JSON.parse(JSON.stringify(safe)));
        setMaintenanceTypes(mtypes);
      })
      .catch(() => toast.error(tc('toast.loadFailed')))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const dirtyKeys = (() => {
    if (!data || !original) return [] as LookupKey[];
    const out: LookupKey[] = [];
    for (const def of SECTIONS.flatMap((s) => s.items)) {
      const a = data[def.key] ?? [];
      const b = original[def.key] ?? [];
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) out.push(def.key);
    }
    return out;
  })();

  const setList = (key: LookupKey) => (next: string[]) => {
    setData((d) => (d ? { ...d, [key]: next } : d));
  };

  const handleSave = async () => {
    if (!data || dirtyKeys.length === 0) return;
    setSaving(true);
    try {
      // Sequential saves keep the audit log per-list and surface a clear
      // error if one specific list rejects (e.g. validation later on).
      for (const key of dirtyKeys) {
        await settingsApi.updateVehicleSetting(key, data[key]);
      }
      toast.success(tc('toast.savedListsCount', { count: dirtyKeys.length }));
      setOriginal(JSON.parse(JSON.stringify(data)));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return <div className="text-center py-16 text-muted-foreground">{tv('settings.vehicleSettings.accessDenied')}</div>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/dashboard/settings"><ArrowLeft className="w-5 h-5" /></Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Truck className="w-6 h-6 text-blue-600" /> {tv('settings.vehicleSettings.title')}
            </h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Centralised configuration for every editable list shown on the vehicle form
            </p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={saving || dirtyKeys.length === 0} className="gap-2">
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : dirtyKeys.length > 0 ? `Save ${dirtyKeys.length} change${dirtyKeys.length === 1 ? '' : 's'}` : 'No changes'}
        </Button>
      </div>

      {loading || !data ? (
        <p className="text-sm text-muted-foreground">{tv('settings.vehicleSettings.loading')}</p>
      ) : (
        <Tabs defaultValue="common" className="w-full">
          <TabsList className="flex flex-wrap gap-1">
            {SECTIONS.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>{s.label}</TabsTrigger>
            ))}
            <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          </TabsList>

          {SECTIONS.map((s) => (
            <TabsContent key={s.id} value={s.id} className="space-y-4 mt-4">
              <p className="text-sm text-muted-foreground">{s.desc}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {s.items.map((def) => (
                  <LookupListEditor
                    key={def.key}
                    def={def}
                    values={data[def.key] ?? []}
                    onChange={setList(def.key)}
                    canEdit
                  />
                ))}
              </div>
            </TabsContent>
          ))}

          <TabsContent value="maintenance" className="space-y-4 mt-4">
            <p className="text-sm text-muted-foreground">
              Manage service types for vehicle maintenance tracking. Includes time-based and mileage-based maintenance intervals.
            </p>
            <MaintenanceTypesEditor
              types={maintenanceTypes}
              onAdd={async (payload) => {
                await vehiclesApi.createMaintenanceType(payload);
                await load();
              }}
              onUpdate={async (id, payload) => {
                await vehiclesApi.updateMaintenanceType(id, payload);
                await load();
              }}
              onDelete={async (id) => {
                await vehiclesApi.deleteMaintenanceType(id);
                await load();
              }}
              saving={saving}
              canEdit={isAdmin}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
