import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { vehiclesApi, settingsApi, tenantsApi, getCurrentUser } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { enumLabel } from '../../../i18n/enumLabel';
import { DateInput } from '../../components/ui/date-input';

type VehicleLookups = Record<string, string[]>;

// Type-specific sections key off the configured vehicle type by matching
// well-known keywords in its name, so admins can rename a type ("Lorry"
// for "Truck") or add new ones ("Refrigerated Van") without losing the
// associated form sections.
const isTruckLike = (t: string) => /truck|trailer|lorry/i.test(t);
const isTankerLike = (t: string) => /tanker/i.test(t);
const isVanLike = (t: string) => /\bvan\b/i.test(t);
const isCarLike = (t: string) => /\bcar\b/i.test(t);
const isRefrigeratedLike = (t: string) => /refrigerat/i.test(t);
const isSpecialtyLike = (t: string) => /special/i.test(t);

type FormData = {
  registrationNumber: string;
  licensePlate: string;
  type: string;
  make: string;
  model: string;
  status: string;
  tenantId: string;
  year: string;
  color: string;
  vin: string;
  fuelType: string;
  fuelCapacity: string;
  currentMileage: string;
  motExpiryDate: string;
  taxExpiryDate: string;
  registrationExpiryDate: string;
  insuranceExpiryDate: string;
  notes: string;
  // Purchase info
  purchaseOrder: string;
  purchaseDate: string;
  purchaseCost: string;
  purchaseContract: string;
  vendorName: string;
  vendorAddress: string;
  // Insurance
  insurancePolicyNumber: string;
  insuranceCompany: string;
  insuranceType: string;
  insuranceStartDate: string;
  // Truck/Trailer specs
  grossWeight: string;
  payloadCapacity: string;
  numberOfAxles: string;
  tareWeight: string;
  bodyType: string;
  hitchType: string;
  lengthM: string;
  widthM: string;
  heightM: string;
  euroEmissionClass: string;
  tachographSerial: string;
  tachographCalibrationExpiry: string;
  trailerLength: string;
  // Van specs
  seatingCapacity: string;
  loadVolume: string;
  partitionFitted: boolean;
  // Car specs
  vinSubType: string;
  insuranceGroup: string;
  // Tanker specs
  tankMaterial: string;
  adrClass: string;
  unNumbers: string;
  lastPressureTestDate: string;
  nextPressureTestDate: string;
  tankerCapacity: string;
  // Refrigerated trailer specs
  refrigerationUnit: string;
  refrigerationModel: string;
  tempMin: string;
  tempMax: string;
  atpCertificateNumber: string;
  atpCertificateExpiry: string;
  // Specialty
  equipmentDescription: string;
};

const EMPTY: FormData = {
  registrationNumber: '', licensePlate: '', type: '', make: '', model: '', status: 'ACTIVE', tenantId: '',
  year: '', color: '', vin: '', fuelType: '', fuelCapacity: '', currentMileage: '',
  motExpiryDate: '', taxExpiryDate: '', registrationExpiryDate: '', insuranceExpiryDate: '', notes: '',
  purchaseOrder: '', purchaseDate: '', purchaseCost: '', purchaseContract: '', vendorName: '', vendorAddress: '',
  insurancePolicyNumber: '', insuranceCompany: '', insuranceType: '', insuranceStartDate: '',
  grossWeight: '', payloadCapacity: '', numberOfAxles: '', tareWeight: '', bodyType: '', hitchType: '',
  lengthM: '', widthM: '', heightM: '', euroEmissionClass: '', tachographSerial: '', tachographCalibrationExpiry: '',
  trailerLength: '', seatingCapacity: '', loadVolume: '', partitionFitted: false,
  vinSubType: '', insuranceGroup: '', tankMaterial: '', adrClass: '', unNumbers: '',
  lastPressureTestDate: '', nextPressureTestDate: '', tankerCapacity: '',
  refrigerationUnit: '', refrigerationModel: '', tempMin: '', tempMax: '', atpCertificateNumber: '', atpCertificateExpiry: '',
  equipmentDescription: '',
};

export function VehicleForm() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation(['pages', 'common']);
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormData>(EMPTY);
  const [lookups, setLookups] = useState<VehicleLookups | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);

  // Phase 3.19 — SUPER PlatformAdmin tenant reassignment.
  const me = getCurrentUser();
  const isSuper = me?.platformAdmin?.level === 'SUPER';
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  useEffect(() => {
    if (!isSuper) return;
    tenantsApi.list({ limit: 200 })
      .then((res) => setTenantOptions(res.data.map((t) => ({ id: t.id, name: t.name, slug: t.slug }))))
      .catch(() => setTenantOptions([]));
  }, [isSuper]);
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();

  useEffect(() => {
    settingsApi.getVehicleSettings()
      .then((data) => setLookups(data))
      .catch((err) => toast.error(apiError(err, t('pages:vehicles.form.toast.settingsLoadFailed'))));
  }, [t]);

  useEffect(() => {
    if (!isEdit) return;
    vehiclesApi.getOne(id!).then((v) => {
      setForm({
        registrationNumber: v.registrationNumber ?? '',
        licensePlate: v.licensePlate ?? '',
        type: v.type ?? '',
        make: v.make ?? '',
        model: v.model ?? '',
        status: v.status ?? 'ACTIVE',
        tenantId: (v as any).tenantId ?? '',
        year: v.year ? String(v.year) : '',
        color: v.color ?? '',
        vin: v.vin ?? '',
        fuelType: v.fuelType ?? '',
        fuelCapacity: v.fuelCapacity ? String(v.fuelCapacity) : '',
        currentMileage: v.currentMileage ? String(v.currentMileage) : '',
        motExpiryDate: v.motExpiryDate ? v.motExpiryDate.split('T')[0] : '',
        taxExpiryDate: v.taxExpiryDate ? v.taxExpiryDate.split('T')[0] : '',
        registrationExpiryDate: v.registrationExpiryDate ? v.registrationExpiryDate.split('T')[0] : '',
        insuranceExpiryDate: v.insuranceExpiryDate ? v.insuranceExpiryDate.split('T')[0] : '',
        notes: v.notes ?? '',
        purchaseOrder: v.purchaseOrder ?? '',
        purchaseDate: v.purchaseDate ? v.purchaseDate.split('T')[0] : '',
        purchaseCost: v.purchaseCost ? String(v.purchaseCost) : '',
        purchaseContract: v.purchaseContract ?? '',
        vendorName: v.vendorName ?? '',
        vendorAddress: v.vendorAddress ?? '',
        insurancePolicyNumber: v.insurancePolicyNumber ?? '',
        insuranceCompany: v.insuranceCompany ?? '',
        insuranceType: v.insuranceType ?? '',
        insuranceStartDate: v.insuranceStartDate ? v.insuranceStartDate.split('T')[0] : '',
        grossWeight: v.grossWeight ? String(v.grossWeight) : '',
        payloadCapacity: v.payloadCapacity ? String(v.payloadCapacity) : '',
        numberOfAxles: v.numberOfAxles ? String(v.numberOfAxles) : '',
        tareWeight: v.tareWeight ? String(v.tareWeight) : '',
        bodyType: v.bodyType ?? '',
        hitchType: v.hitchType ?? '',
        lengthM: v.lengthM ? String(v.lengthM) : '',
        widthM: v.widthM ? String(v.widthM) : '',
        heightM: v.heightM ? String(v.heightM) : '',
        euroEmissionClass: v.euroEmissionClass ?? '',
        tachographSerial: v.tachographSerial ?? '',
        tachographCalibrationExpiry: v.tachographCalibrationExpiry ? v.tachographCalibrationExpiry.split('T')[0] : '',
        trailerLength: v.trailerLength ? String(v.trailerLength) : '',
        seatingCapacity: v.seatingCapacity ? String(v.seatingCapacity) : '',
        loadVolume: v.loadVolume ? String(v.loadVolume) : '',
        partitionFitted: v.partitionFitted ?? false,
        vinSubType: v.vinSubType ?? '',
        insuranceGroup: v.insuranceGroup ?? '',
        tankMaterial: v.tankMaterial ?? '',
        adrClass: v.adrClass ?? '',
        unNumbers: v.unNumbers ?? '',
        lastPressureTestDate: v.lastPressureTestDate ? v.lastPressureTestDate.split('T')[0] : '',
        nextPressureTestDate: v.nextPressureTestDate ? v.nextPressureTestDate.split('T')[0] : '',
        tankerCapacity: v.tankerCapacity ? String(v.tankerCapacity) : '',
        refrigerationUnit: v.refrigerationUnit ?? '',
        refrigerationModel: v.refrigerationModel ?? '',
        tempMin: v.tempMin ? String(v.tempMin) : '',
        tempMax: v.tempMax ? String(v.tempMax) : '',
        atpCertificateNumber: v.atpCertificateNumber ?? '',
        atpCertificateExpiry: v.atpCertificateExpiry ? v.atpCertificateExpiry.split('T')[0] : '',
        equipmentDescription: v.equipmentDescription ?? '',
      });
    }).catch((err) => toast.error(apiError(err, t('pages:vehicles.form.toast.loadFailed')))).finally(() => setLoading(false));
  }, [id, isEdit, t]);

  const set = (key: keyof FormData, value: string | boolean) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (fieldErrs[key as string]) clearError(key as string);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFieldErrors();
    if (!form.registrationNumber.trim()) { toast.error(t('pages:vehicles.form.validation.registrationRequired')); return; }
    if (!form.type) { toast.error(t('pages:vehicles.form.validation.typeRequired')); return; }
    if (!form.make.trim()) { toast.error(t('pages:vehicles.form.validation.makeRequired')); return; }
    if (!form.model.trim()) { toast.error(t('pages:vehicles.form.validation.modelRequired')); return; }

    setSaving(true);
    try {
      const payload: any = {
        registrationNumber: form.registrationNumber.trim(),
        licensePlate: form.licensePlate || undefined,
        type: form.type,
        make: form.make.trim(),
        model: form.model.trim(),
        status: form.status || undefined,
        // Phase 3.19 — only send tenantId when the SUPER PlatformAdmin
        // explicitly picked one. The backend re-checks SUPER and
        // ignores the field for anyone else.
        ...(isSuper && form.tenantId ? { tenantId: form.tenantId } : {}),
        year: form.year ? parseInt(form.year) : undefined,
        color: form.color || undefined,
        vin: form.vin || undefined,
        fuelType: form.fuelType || undefined,
        fuelCapacity: form.fuelCapacity ? parseFloat(form.fuelCapacity) : undefined,
        currentMileage: form.currentMileage ? parseInt(form.currentMileage) : undefined,
        motExpiryDate: form.motExpiryDate || undefined,
        taxExpiryDate: form.taxExpiryDate || undefined,
        registrationExpiryDate: form.registrationExpiryDate || undefined,
        insuranceExpiryDate: form.insuranceExpiryDate || undefined,
        notes: form.notes || undefined,
        purchaseOrder: form.purchaseOrder || undefined,
        purchaseDate: form.purchaseDate || undefined,
        purchaseCost: form.purchaseCost ? parseFloat(form.purchaseCost) : undefined,
        purchaseContract: form.purchaseContract || undefined,
        vendorName: form.vendorName || undefined,
        vendorAddress: form.vendorAddress || undefined,
        insurancePolicyNumber: form.insurancePolicyNumber || undefined,
        insuranceCompany: form.insuranceCompany || undefined,
        insuranceType: form.insuranceType || undefined,
        insuranceStartDate: form.insuranceStartDate || undefined,
        grossWeight: form.grossWeight ? parseFloat(form.grossWeight) : undefined,
        payloadCapacity: form.payloadCapacity ? parseFloat(form.payloadCapacity) : undefined,
        numberOfAxles: form.numberOfAxles ? parseInt(form.numberOfAxles) : undefined,
        tareWeight: form.tareWeight ? parseFloat(form.tareWeight) : undefined,
        bodyType: form.bodyType || undefined,
        hitchType: form.hitchType || undefined,
        lengthM: form.lengthM ? parseFloat(form.lengthM) : undefined,
        widthM: form.widthM ? parseFloat(form.widthM) : undefined,
        heightM: form.heightM ? parseFloat(form.heightM) : undefined,
        euroEmissionClass: form.euroEmissionClass || undefined,
        tachographSerial: form.tachographSerial || undefined,
        tachographCalibrationExpiry: form.tachographCalibrationExpiry || undefined,
        trailerLength: form.trailerLength ? parseFloat(form.trailerLength) : undefined,
        seatingCapacity: form.seatingCapacity ? parseInt(form.seatingCapacity) : undefined,
        loadVolume: form.loadVolume ? parseFloat(form.loadVolume) : undefined,
        partitionFitted: form.partitionFitted ?? undefined,
        vinSubType: form.vinSubType || undefined,
        insuranceGroup: form.insuranceGroup || undefined,
        tankMaterial: form.tankMaterial || undefined,
        adrClass: form.adrClass || undefined,
        unNumbers: form.unNumbers || undefined,
        lastPressureTestDate: form.lastPressureTestDate || undefined,
        nextPressureTestDate: form.nextPressureTestDate || undefined,
        tankerCapacity: form.tankerCapacity ? parseFloat(form.tankerCapacity) : undefined,
        refrigerationUnit: form.refrigerationUnit || undefined,
        refrigerationModel: form.refrigerationModel || undefined,
        tempMin: form.tempMin ? parseFloat(form.tempMin) : undefined,
        tempMax: form.tempMax ? parseFloat(form.tempMax) : undefined,
        atpCertificateNumber: form.atpCertificateNumber || undefined,
        atpCertificateExpiry: form.atpCertificateExpiry || undefined,
        equipmentDescription: form.equipmentDescription || undefined,
      };

      if (isEdit) {
        await vehiclesApi.update(id!, payload);
        toast.success(t('pages:vehicles.form.toast.updated'));
      } else {
        const created = await vehiclesApi.create(payload);
        toast.success(t('pages:vehicles.form.toast.created'));
        navigate(`/dashboard/vehicles/${created.id}`);
        return;
      }
      navigate(`/dashboard/vehicles/${id}`);
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('pages:vehicles.form.toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-6 text-muted-foreground">{t('common:states.loading')}</div>;

  const notSpecified = t('pages:vehicles.form.fields.notSpecified');

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {t('common:actions.back')}
        </Button>
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Truck className="w-5 h-5 text-primary" />
            {isEdit ? t('pages:vehicles.form.editTitle') : t('pages:vehicles.form.addTitle')}
          </h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <ValidationSummary errors={fieldErrs} />
        {/* Vehicle Details */}
        <Card>
          <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.details')}</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.registrationNumber')} *</Label>
              <Input value={form.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value.toUpperCase())} placeholder={t('pages:vehicles.form.fields.registrationNumberPh')}
                aria-invalid={!!fieldErrs.registrationNumber}
                className={fieldErrs.registrationNumber ? 'border-red-500 focus-visible:ring-red-500' : ''} />
              <FieldError errors={fieldErrs} name="registrationNumber" />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.licensePlate')}</Label>
              <Input value={form.licensePlate} onChange={(e) => set('licensePlate', e.target.value)} placeholder={t('pages:vehicles.form.fields.licensePlatePh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.vehicleType')} *</Label>
              <Select value={form.type || 'none'} onValueChange={(v) => set('type', v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.vehicleTypePh')} /></SelectTrigger>
                <SelectContent>
                  {lookups?.vehicleTypes?.map((tp) => <SelectItem key={tp} value={tp}>{tp}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.status')}</Label>
              <Select value={form.status || 'ACTIVE'} onValueChange={(v) => set('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {lookups?.statuses?.map((s) => <SelectItem key={s} value={s}>{enumLabel('maintenanceStatus', s) || s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* Phase 3.19 — SUPER PlatformAdmin only: move this vehicle
                to a different tenant. Hidden for everyone else; the
                backend re-checks SUPER and ignores the field. */}
            {isSuper && (
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.tenant', { defaultValue: 'Tenant' })}</Label>
                <Select
                  value={form.tenantId || '__none__'}
                  onValueChange={(v) => set('tenantId', v === '__none__' ? '' : v)}
                >
                  <SelectTrigger><SelectValue placeholder="Select tenant" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No tenant (global)</SelectItem>
                    {tenantOptions.map((tn) => (
                      <SelectItem key={tn.id} value={tn.id}>{tn.name} <span className="text-xs text-muted-foreground">/{tn.slug}</span></SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">SUPER PlatformAdmin only.</p>
              </div>
            )}
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.make')} *</Label>
              <Input value={form.make} onChange={(e) => set('make', e.target.value)} placeholder={t('pages:vehicles.form.fields.makePh')}
                aria-invalid={!!fieldErrs.make}
                className={fieldErrs.make ? 'border-red-500 focus-visible:ring-red-500' : ''} />
              <FieldError errors={fieldErrs} name="make" />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.model')} *</Label>
              <Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder={t('pages:vehicles.form.fields.modelPh')}
                aria-invalid={!!fieldErrs.model}
                className={fieldErrs.model ? 'border-red-500 focus-visible:ring-red-500' : ''} />
              <FieldError errors={fieldErrs} name="model" />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.year')}</Label>
              <Input type="number" value={form.year} onChange={(e) => set('year', e.target.value)} placeholder={t('pages:vehicles.form.fields.yearPh')} min={1950} max={2100} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.color')}</Label>
              <Input value={form.color} onChange={(e) => set('color', e.target.value)} placeholder={t('pages:vehicles.form.fields.colorPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.vin')}</Label>
              <Input value={form.vin} onChange={(e) => set('vin', e.target.value.toUpperCase())} placeholder={t('pages:vehicles.form.fields.vinPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.fuelType')}</Label>
              <Select value={form.fuelType || 'none'} onValueChange={(v) => set('fuelType', v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.fuelTypePh')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{notSpecified}</SelectItem>
                  {lookups?.fuelTypes?.map((f) => <SelectItem key={f} value={f}>{enumLabel('fuelType', f) || f}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.fuelCapacity')}</Label>
              <Input type="number" step="0.1" value={form.fuelCapacity} onChange={(e) => set('fuelCapacity', e.target.value)} placeholder={t('pages:vehicles.form.fields.fuelCapacityPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.currentMileage')}</Label>
              <Input type="number" value={form.currentMileage} onChange={(e) => set('currentMileage', e.target.value)} placeholder={t('pages:vehicles.form.fields.currentMileagePh')} min={0} />
            </div>
            <div className="col-span-full space-y-1">
              <Label>{t('pages:vehicles.form.fields.notes')}</Label>
              <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder={t('pages:vehicles.form.fields.notesPh')} rows={3} />
            </div>
          </CardContent>
        </Card>

        {/* Compliance Dates */}
        <Card>
          <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.compliance')}</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.motExpiry')}</Label>
              <DateInput value={form.motExpiryDate} onChange={(e) => set('motExpiryDate', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.taxExpiry')}</Label>
              <DateInput value={form.taxExpiryDate} onChange={(e) => set('taxExpiryDate', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.registrationExpiry')}</Label>
              <DateInput value={form.registrationExpiryDate} onChange={(e) => set('registrationExpiryDate', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.insuranceExpiry')}</Label>
              <DateInput value={form.insuranceExpiryDate} onChange={(e) => set('insuranceExpiryDate', e.target.value)} />
            </div>
          </CardContent>
        </Card>

        {/* Purchase Information */}
        <Card>
          <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.purchase')}</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.purchaseOrder')}</Label>
              <Input value={form.purchaseOrder} onChange={(e) => set('purchaseOrder', e.target.value)} placeholder={t('pages:vehicles.form.fields.purchaseOrderPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.purchaseDate')}</Label>
              <DateInput value={form.purchaseDate} onChange={(e) => set('purchaseDate', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.purchaseCost')}</Label>
              <Input type="number" step="0.01" value={form.purchaseCost} onChange={(e) => set('purchaseCost', e.target.value)} placeholder={t('pages:vehicles.form.fields.purchaseCostPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.purchaseContract')}</Label>
              <Input value={form.purchaseContract} onChange={(e) => set('purchaseContract', e.target.value)} placeholder={t('pages:vehicles.form.fields.purchaseContractPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.vendorName')}</Label>
              <Input value={form.vendorName} onChange={(e) => set('vendorName', e.target.value)} placeholder={t('pages:vehicles.form.fields.vendorNamePh')} />
            </div>
            <div className="col-span-full space-y-1">
              <Label>{t('pages:vehicles.form.fields.vendorAddress')}</Label>
              <Textarea value={form.vendorAddress} onChange={(e) => set('vendorAddress', e.target.value)} placeholder={t('pages:vehicles.form.fields.vendorAddressPh')} rows={2} />
            </div>
          </CardContent>
        </Card>

        {/* Insurance Information */}
        <Card>
          <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.insurance')}</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.policyNumber')}</Label>
              <Input value={form.insurancePolicyNumber} onChange={(e) => set('insurancePolicyNumber', e.target.value)} placeholder={t('pages:vehicles.form.fields.policyNumberPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.insuranceCompany')}</Label>
              <Input value={form.insuranceCompany} onChange={(e) => set('insuranceCompany', e.target.value)} placeholder={t('pages:vehicles.form.fields.insuranceCompanyPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.insuranceTypeLabel')}</Label>
              <Select value={form.insuranceType || 'none'} onValueChange={(v) => set('insuranceType', v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.insuranceTypePh')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{notSpecified}</SelectItem>
                  {lookups?.insuranceTypes?.map((tp) => <SelectItem key={tp} value={tp}>{tp}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.form.fields.insuranceStartDate')}</Label>
              <DateInput value={form.insuranceStartDate} onChange={(e) => set('insuranceStartDate', e.target.value)} />
            </div>
          </CardContent>
        </Card>

        {/* Truck & Trailer Specifications */}
        {(isTruckLike(form.type) || isRefrigeratedLike(form.type)) && (
          <Card>
            <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.truck')}</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.grossWeight')}</Label>
                <Input type="number" step="0.1" value={form.grossWeight} onChange={(e) => set('grossWeight', e.target.value)} placeholder={t('pages:vehicles.form.fields.grossWeightPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.payloadCapacity')}</Label>
                <Input type="number" step="0.1" value={form.payloadCapacity} onChange={(e) => set('payloadCapacity', e.target.value)} placeholder={t('pages:vehicles.form.fields.payloadCapacityPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.tareWeight')}</Label>
                <Input type="number" step="0.1" value={form.tareWeight} onChange={(e) => set('tareWeight', e.target.value)} placeholder={t('pages:vehicles.form.fields.tareWeightPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.numberOfAxles')}</Label>
                <Input type="number" value={form.numberOfAxles} onChange={(e) => set('numberOfAxles', e.target.value)} placeholder={t('pages:vehicles.form.fields.numberOfAxlesPh')} min={1} max={12} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.bodyType')}</Label>
                <Select value={form.bodyType || 'none'} onValueChange={(v) => set('bodyType', v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.bodyTypePh')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{notSpecified}</SelectItem>
                    {lookups?.bodyTypes?.map((tp) => <SelectItem key={tp} value={tp}>{tp}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.hitchType')}</Label>
                <Select value={form.hitchType || 'none'} onValueChange={(v) => set('hitchType', v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.hitchTypePh')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{notSpecified}</SelectItem>
                    {lookups?.hitchTypes?.map((tp) => <SelectItem key={tp} value={tp}>{tp}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.lengthM')}</Label>
                <Input type="number" step="0.1" value={form.lengthM} onChange={(e) => set('lengthM', e.target.value)} placeholder={t('pages:vehicles.form.fields.lengthMPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.widthM')}</Label>
                <Input type="number" step="0.1" value={form.widthM} onChange={(e) => set('widthM', e.target.value)} placeholder={t('pages:vehicles.form.fields.widthMPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.heightM')}</Label>
                <Input type="number" step="0.1" value={form.heightM} onChange={(e) => set('heightM', e.target.value)} placeholder={t('pages:vehicles.form.fields.heightMPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.euroEmission')}</Label>
                <Select value={form.euroEmissionClass || 'none'} onValueChange={(v) => set('euroEmissionClass', v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.euroEmissionPh')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{notSpecified}</SelectItem>
                    {lookups?.euroEmissionClasses?.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.tachographSerial')}</Label>
                <Input value={form.tachographSerial} onChange={(e) => set('tachographSerial', e.target.value)} placeholder={t('pages:vehicles.form.fields.tachographSerialPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.tachographCalibrationExpiry')}</Label>
                <DateInput value={form.tachographCalibrationExpiry} onChange={(e) => set('tachographCalibrationExpiry', e.target.value)} />
              </div>
              {(/trailer/i.test(form.type) || isRefrigeratedLike(form.type)) && (
                <div className="space-y-1">
                  <Label>{t('pages:vehicles.form.fields.trailerLength')}</Label>
                  <Input type="number" step="0.1" value={form.trailerLength} onChange={(e) => set('trailerLength', e.target.value)} placeholder={t('pages:vehicles.form.fields.trailerLengthPh')} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Van Specifications */}
        {isVanLike(form.type) && (
          <Card>
            <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.van')}</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.seatingCapacity')}</Label>
                <Input type="number" value={form.seatingCapacity} onChange={(e) => set('seatingCapacity', e.target.value)} placeholder={t('pages:vehicles.form.fields.seatingCapacityPh')} min={1} max={20} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.loadVolume')}</Label>
                <Input type="number" step="0.1" value={form.loadVolume} onChange={(e) => set('loadVolume', e.target.value)} placeholder={t('pages:vehicles.form.fields.loadVolumePh')} />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Checkbox checked={form.partitionFitted} onCheckedChange={(v) => set('partitionFitted', !!v)} id="partition" />
                <Label htmlFor="partition" className="font-normal cursor-pointer">{t('pages:vehicles.form.fields.partitionFitted')}</Label>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Car Specifications */}
        {isCarLike(form.type) && (
          <Card>
            <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.car')}</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.vinSubType')}</Label>
                <Select value={form.vinSubType || 'none'} onValueChange={(v) => set('vinSubType', v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.vinSubTypePh')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{notSpecified}</SelectItem>
                    {lookups?.vinSubTypes?.map((tp) => <SelectItem key={tp} value={tp}>{tp}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.insuranceGroup')}</Label>
                <Select value={form.insuranceGroup || 'none'} onValueChange={(v) => set('insuranceGroup', v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.insuranceGroupPh')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{notSpecified}</SelectItem>
                    {lookups?.insuranceGroups?.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tanker Specifications */}
        {isTankerLike(form.type) && (
          <Card>
            <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.tanker')}</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.tankerCapacity')}</Label>
                <Input type="number" value={form.tankerCapacity} onChange={(e) => set('tankerCapacity', e.target.value)} placeholder={t('pages:vehicles.form.fields.tankerCapacityPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.tankMaterial')}</Label>
                <Select value={form.tankMaterial || 'none'} onValueChange={(v) => set('tankMaterial', v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.tankMaterialPh')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{notSpecified}</SelectItem>
                    {lookups?.tankMaterials?.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.adrClass')}</Label>
                <Select value={form.adrClass || 'none'} onValueChange={(v) => set('adrClass', v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder={t('pages:vehicles.form.fields.adrClassPh')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{notSpecified}</SelectItem>
                    {lookups?.adrClasses?.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.unNumbers')}</Label>
                <Input value={form.unNumbers} onChange={(e) => set('unNumbers', e.target.value)} placeholder={t('pages:vehicles.form.fields.unNumbersPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.lastPressureTest')}</Label>
                <DateInput value={form.lastPressureTestDate} onChange={(e) => set('lastPressureTestDate', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.nextPressureTest')}</Label>
                <DateInput value={form.nextPressureTestDate} onChange={(e) => set('nextPressureTestDate', e.target.value)} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Refrigerated Trailer Specifications */}
        {isRefrigeratedLike(form.type) && (
          <Card>
            <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.refrigerated')}</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.refrigerationUnit')}</Label>
                <Input value={form.refrigerationUnit} onChange={(e) => set('refrigerationUnit', e.target.value)} placeholder={t('pages:vehicles.form.fields.refrigerationUnitPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.refrigerationModel')}</Label>
                <Input value={form.refrigerationModel} onChange={(e) => set('refrigerationModel', e.target.value)} placeholder={t('pages:vehicles.form.fields.refrigerationModelPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.tempMin')}</Label>
                <Input type="number" step="0.1" value={form.tempMin} onChange={(e) => set('tempMin', e.target.value)} placeholder={t('pages:vehicles.form.fields.tempMinPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.tempMax')}</Label>
                <Input type="number" step="0.1" value={form.tempMax} onChange={(e) => set('tempMax', e.target.value)} placeholder={t('pages:vehicles.form.fields.tempMaxPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.atpCertificateNumber')}</Label>
                <Input value={form.atpCertificateNumber} onChange={(e) => set('atpCertificateNumber', e.target.value)} placeholder={t('pages:vehicles.form.fields.atpCertificateNumberPh')} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.atpCertificateExpiry')}</Label>
                <DateInput value={form.atpCertificateExpiry} onChange={(e) => set('atpCertificateExpiry', e.target.value)} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Specialty Equipment */}
        {isSpecialtyLike(form.type) && (
          <Card>
            <CardHeader><CardTitle className="text-base">{t('pages:vehicles.form.sections.specialty')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label>{t('pages:vehicles.form.fields.equipmentDescription')}</Label>
                <Textarea value={form.equipmentDescription} onChange={(e) => set('equipmentDescription', e.target.value)} placeholder={t('pages:vehicles.form.fields.equipmentDescriptionPh')} rows={4} />
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex gap-3 justify-end">
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>{t('common:actions.cancel')}</Button>
          <Button type="submit" disabled={saving}>
            <Save className="w-4 h-4 me-2" />
            {saving ? t('common:states.saving') : isEdit ? t('pages:vehicles.form.saveChanges') : t('pages:vehicles.form.createButton')}
          </Button>
        </div>
      </form>
    </div>
  );
}
