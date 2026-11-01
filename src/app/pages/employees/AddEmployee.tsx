import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ShieldOff } from 'lucide-react';
import { usePermissions } from '../../hooks/usePermissions';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { CountrySelect } from '../../components/ui/CountrySelect';
import { PhoneInput } from '../../components/ui/PhoneInput';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { toast } from 'sonner';
import { employeesApi, agenciesApi, getCurrentUser } from '../../services/api';
import { SuperUserTenantField, isSuperUser } from '../../components/ui/super-user-tenant-field';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { DateInput } from '../../components/ui/date-input';

export function AddEmployee() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const [agencies, setAgencies] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Phase 1B (#11 #23) — SUPER USER tenant default + agency filter.
  const [tenantId, setTenantId] = useState<string>(
    (getCurrentUser() as any)?.activeTenantId
    ?? (getCurrentUser() as any)?.primaryTenantId
    ?? (getCurrentUser()?.memberships?.[0]?.tenantId)
    ?? '',
  );
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '',
    nationality: '', dateOfBirth: '',
    agencyId: '',
    addressLine1: '', city: '', country: '', postalCode: '',
    licenseNumber: '', licenseCategory: '', yearsExperience: '',
    emergencyContact: '', emergencyPhone: '', notes: '',
    status: 'PENDING',
  });

  useEffect(() => {
    agenciesApi.list({ limit: 200 })
      .then((res: any) => setAgencies(res?.data ?? []))
      .catch(() => {});
  }, []);

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(prev => ({ ...prev, [field]: e.target.value }));
    if (fieldErrs[field]) clearError(field);
  };
  // Sibling helper for components that emit a raw string (CountrySelect,
  // PhoneInput) instead of a synthetic ChangeEvent.
  const setValue = (field: string) => (value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (fieldErrs[field]) clearError(field);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFieldErrors();
    setSubmitting(true);
    try {
      const payload: any = {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        nationality: form.nationality,
        dateOfBirth: form.dateOfBirth,
        addressLine1: form.addressLine1,
        city: form.city,
        country: form.country,
        postalCode: form.postalCode,
        status: form.status,
      };
      if (form.agencyId) payload.agencyId = form.agencyId;
      if (isSuperUser() && tenantId) payload.tenantId = tenantId;
      if (form.licenseNumber) payload.licenseNumber = form.licenseNumber;
      if (form.licenseCategory) payload.licenseCategory = form.licenseCategory;
      if (form.yearsExperience) payload.yearsExperience = parseInt(form.yearsExperience, 10);
      if (form.emergencyContact) payload.emergencyContact = form.emergencyContact;
      if (form.emergencyPhone) payload.emergencyPhone = form.emergencyPhone;
      if (form.notes) payload.notes = form.notes;

      const created = await employeesApi.create(payload);
      toast.success(t('employees.add.addSuccess'));
      navigate(`/dashboard/employees/${created.id}`);
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('employees.add.addFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate('employees')) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
        <ShieldOff className="w-12 h-12 opacity-30" />
        <p className="text-lg font-semibold text-[#0F172A]">{tc('permissions.accessDenied')}</p>
        <p className="text-sm">{tc('permissions.noPermission')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/employees"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('employees.add.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('employees.add.subtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <ValidationSummary errors={fieldErrs} className="mb-4" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">

            <Card>
              <CardHeader><CardTitle>{t('employees.add.personalInfoTitle')}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">{t('employees.add.firstName')}</Label>
                    <Input id="firstName" placeholder={t('employees.add.firstNamePh')} value={form.firstName} onChange={set('firstName')} required
                      aria-invalid={!!fieldErrs.firstName}
                      className={fieldErrs.firstName ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                    <FieldError errors={fieldErrs} name="firstName" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName">{t('employees.add.lastName')}</Label>
                    <Input id="lastName" placeholder={t('employees.add.lastNamePh')} value={form.lastName} onChange={set('lastName')} required
                      aria-invalid={!!fieldErrs.lastName}
                      className={fieldErrs.lastName ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                    <FieldError errors={fieldErrs} name="lastName" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('employees.add.email')}</Label>
                    <Input id="email" type="email" placeholder={t('employees.add.emailPh')} value={form.email} onChange={set('email')} required
                      aria-invalid={!!fieldErrs.email}
                      className={fieldErrs.email ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                    <FieldError errors={fieldErrs} name="email" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">{t('employees.add.phone')}</Label>
                    <PhoneInput
                      id="phone"
                      value={form.phone}
                      onChange={setValue('phone')}
                      placeholder={t('employees.add.phonePh')}
                      required
                    />
                    <FieldError errors={fieldErrs} name="phone" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="dateOfBirth">{t('employees.add.dateOfBirth')}</Label>
                    <DateInput id="dateOfBirth" value={form.dateOfBirth} onChange={set('dateOfBirth')} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="nationality">{t('employees.add.citizenship')}</Label>
                    <CountrySelect
                      value={form.nationality}
                      onChange={setValue('nationality')}
                      placeholder={t('employees.add.citizenshipPh')}
                      required
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="emergencyContact">{t('employees.add.emergencyContact')}</Label>
                    <Input id="emergencyContact" placeholder={t('employees.add.emergencyContactPh')} value={form.emergencyContact} onChange={set('emergencyContact')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="emergencyPhone">{t('employees.add.emergencyPhone')}</Label>
                    <PhoneInput
                      id="emergencyPhone"
                      value={form.emergencyPhone}
                      onChange={setValue('emergencyPhone')}
                      placeholder={t('employees.add.emergencyPhonePh')}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>{t('employees.add.addressInfoTitle')}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="addressLine1">{t('employees.add.streetAddress')}</Label>
                  <Input id="addressLine1" placeholder={t('employees.add.streetAddressPh')} value={form.addressLine1} onChange={set('addressLine1')} required />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="city">{t('employees.add.city')}</Label>
                    <Input id="city" placeholder={t('employees.add.cityPh')} value={form.city} onChange={set('city')} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="postalCode">{t('employees.add.postalCode')}</Label>
                    <Input id="postalCode" placeholder={t('employees.add.postalCodePh')} value={form.postalCode} onChange={set('postalCode')} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="country">{t('employees.add.country')}</Label>
                    <CountrySelect
                      value={form.country}
                      onChange={setValue('country')}
                      placeholder={t('employees.add.countryPh')}
                      required
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>{t('employees.add.professionalInfoTitle')}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="agencyId">{t('employees.add.agency')}</Label>
                  <Select value={form.agencyId} onValueChange={val => setForm(prev => ({ ...prev, agencyId: val === '__none__' ? '' : val }))}>
                    <SelectTrigger id="agencyId">
                      <SelectValue placeholder={t('employees.add.agencyPh')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t('employees.add.directHire')}</SelectItem>
                      {agencies
                        .filter(a => isSuperUser() ? (!!tenantId && a.tenantId === tenantId) : true)
                        .map(a => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <div className="mt-3">
                    <SuperUserTenantField
                      value={tenantId}
                      onChange={(v) => {
                        setTenantId(v);
                        const a = agencies.find(x => x.id === form.agencyId);
                        if (v && a?.tenantId && a.tenantId !== v) setForm(prev => ({ ...prev, agencyId: '' }));
                      }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="licenseNumber">{t('employees.add.licenseNumber')}</Label>
                    <Input id="licenseNumber" placeholder={t('employees.add.licenseNumberPh')} value={form.licenseNumber} onChange={set('licenseNumber')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="licenseCategory">{t('employees.add.licenseCategory')}</Label>
                    <Input id="licenseCategory" placeholder={t('employees.add.licenseCategoryPh')} value={form.licenseCategory} onChange={set('licenseCategory')} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="yearsExperience">{t('employees.add.yearsExperience')}</Label>
                  <Input id="yearsExperience" type="number" min="0" placeholder="0" value={form.yearsExperience} onChange={set('yearsExperience')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notes">{t('employees.add.notes')}</Label>
                  <Input id="notes" placeholder={t('employees.add.notesPh')} value={form.notes} onChange={set('notes')} />
                </div>
              </CardContent>
            </Card>

          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle>{t('employees.add.statusTitle')}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="status">{t('employees.add.initialStatus')}</Label>
                  <Select value={form.status} onValueChange={val => setForm(prev => ({ ...prev, status: val }))}>
                    <SelectTrigger id="status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">{t('employees.add.statusOptions.pending')}</SelectItem>
                      <SelectItem value="ONBOARDING">{t('employees.add.statusOptions.onboarding')}</SelectItem>
                      <SelectItem value="ACTIVE">{t('employees.add.statusOptions.active')}</SelectItem>
                      <SelectItem value="INACTIVE">{t('employees.add.statusOptions.inactive')}</SelectItem>
                      <SelectItem value="ON_LEAVE">{t('employees.add.statusOptions.onLeave')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-[#EFF6FF] border-[#2563EB]">
              <CardHeader><CardTitle className="text-sm">{t('employees.add.nextStepsTitle')}</CardTitle></CardHeader>
              <CardContent>
                <ul className="text-sm space-y-2 text-muted-foreground">
                  <li>• {t('employees.add.nextSteps1')}</li>
                  <li>• {t('employees.add.nextSteps2')}</li>
                  <li>• {t('employees.add.nextSteps3')}</li>
                  <li>• {t('employees.add.nextSteps4')}</li>
                </ul>
              </CardContent>
            </Card>

            <div className="flex flex-col gap-3">
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? t('employees.add.adding') : t('employees.add.addButton')}
              </Button>
              <Button type="button" variant="outline" className="w-full" asChild>
                <Link to="/dashboard/employees">{tc('actions.cancel')}</Link>
              </Button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
