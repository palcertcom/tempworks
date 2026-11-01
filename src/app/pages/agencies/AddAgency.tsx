import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ShieldOff, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { SuperUserTenantField, isSuperUser } from '../../components/ui/super-user-tenant-field';
import { getCurrentUser } from '../../services/api';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { CountrySelect } from '../../components/ui/CountrySelect';
import { PhoneInput } from '../../components/ui/PhoneInput';
import { toast } from 'sonner';
import { agenciesApi } from '../../services/api';

// Lightweight website validator — mirrors the backend's IsUrl(require_protocol: false)
// which tolerates "www.example.com" as well as "https://example.com".
function looksLikeWebsite(v: string): boolean {
  if (!v) return true;
  const s = v.trim();
  // Accept bare domain (no protocol) OR http(s)://host
  return /^(https?:\/\/)?[^\s.]+\.[^\s]+$/i.test(s);
}

type FormShape = {
  name: string;
  country: string;
  contactFirstName: string;
  contactMiddleName: string;
  contactLastName: string;
  email: string;
  phone: string;
  whatsapp: string;
  status: string;
  website: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  notes: string;
};

const EMPTY: FormShape = {
  name: '', country: '', contactFirstName: '', contactMiddleName: '', contactLastName: '',
  email: '', phone: '', whatsapp: '', status: 'ACTIVE',
  website: '', addressLine1: '', addressLine2: '', city: '', stateRegion: '', postalCode: '',
  notes: '',
};

export function AddAgency() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canCreate } = usePermissions();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormShape>(EMPTY);
  // Phase 1B (#11 #23) — SUPER USER tenant default for new agencies.
  const [tenantId, setTenantId] = useState<string>(
    (getCurrentUser() as any)?.activeTenantId
    ?? (getCurrentUser() as any)?.primaryTenantId
    ?? (getCurrentUser()?.memberships?.[0]?.tenantId)
    ?? '',
  );
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();

  // Logo is picked up front but only sent *after* the agency record is
  // created — the backend needs an ID to attach the file to. We store
  // the File and a data-URL preview.
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  if (!canCreate('agencies')) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
        <ShieldOff className="w-12 h-12 opacity-30" />
        <p className="text-lg font-semibold text-[#0F172A]">{tc('permissions.accessDenied')}</p>
        <p className="text-sm">{tc('permissions.noPermission')}</p>
      </div>
    );
  }

  const setField = <K extends keyof FormShape>(key: K, value: FormShape[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
    if (fieldErrs[key as string]) clearError(key as string);
  };

  const handleLogoPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      toast.error(tc('toast.logoTooLarge'));
      return;
    }
    if (!/^image\/(jpe?g|png|webp|svg\+xml)$/i.test(f.type)) {
      toast.error(t('agencies.add.validation.logoFormat'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(f);
    setLogoFile(f);
  };

  const clearLogo = () => { setLogoFile(null); setLogoPreview(null); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFieldErrors();
    // Minimal required-field + URL validation mirrors the backend DTO.
    if (!form.name.trim())          return toast.error(t('agencies.add.validation.nameRequired'));
    if (!form.country)              return toast.error(t('agencies.add.validation.countryRequired'));
    if (!form.contactFirstName.trim() || !form.contactLastName.trim())
      return toast.error(t('agencies.add.validation.contactNameRequired'));
    if (!form.email.trim())         return toast.error(t('agencies.add.validation.emailRequired'));
    if (!form.phone.trim())         return toast.error(t('agencies.add.validation.phoneRequired'));
    if (form.website && !looksLikeWebsite(form.website))
      return toast.error(t('agencies.add.validation.websiteInvalid'));

    setSubmitting(true);
    try {
      const payload: any = {
        ...form,
        // Phase 1B (#23) — SUPER may pick a different tenant for the new
        // agency; backend ignores tenantId for everyone else.
        ...(isSuperUser() && tenantId ? { tenantId } : {}),
        contactPerson: [form.contactFirstName, form.contactMiddleName, form.contactLastName]
          .map(s => s.trim()).filter(Boolean).join(' '),
      };
      const created = await agenciesApi.create(payload);
      if (logoFile && created?.id) {
        try { await agenciesApi.uploadLogo(created.id, logoFile); }
        catch (err: any) { toast.warning(t('agencies.add.toast.logoUploadFailed', { error: apiError(err) })); }
      }
      toast.success(t('agencies.add.toast.addSuccess'));
      navigate(created?.id ? `/dashboard/agencies/${created.id}` : '/dashboard/agencies');
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('agencies.add.toast.addFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/agencies"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('agencies.add.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('agencies.add.subtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-w-3xl space-y-6">
          <ValidationSummary errors={fieldErrs} />
          {/* Identity */}
          <Card>
            <CardHeader><CardTitle>{t('agencies.add.agencyInfoTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2 col-span-2">
                  <Label htmlFor="name">{t('agencies.add.agencyName')}</Label>
                  <Input id="name" placeholder={t('agencies.add.agencyNamePh')} value={form.name} onChange={e => setField('name', e.target.value)} required
                    aria-invalid={!!fieldErrs.name}
                    className={fieldErrs.name ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                  <FieldError errors={fieldErrs} name="name" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">{t('agencies.add.country')}</Label>
                  <CountrySelect value={form.country} onChange={v => setField('country', v)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">{t('agencies.add.status')}</Label>
                  <Select value={form.status} onValueChange={v => setField('status', v)}>
                    <SelectTrigger id="status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">{tc('filters.active')}</SelectItem>
                      <SelectItem value="INACTIVE">{tc('filters.inactive')}</SelectItem>
                      <SelectItem value="SUSPENDED">{t('agencies.add.suspended', { defaultValue: 'Suspended' })}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="website">{t('agencies.add.website')}</Label>
                <Input id="website" placeholder={t('agencies.add.websitePh')} value={form.website} onChange={e => setField('website', e.target.value)} />
              </div>
              {/* Phase 1B (#11 #23) — SUPER tenant selector. Hidden for everyone else. */}
              <div className="mt-4">
                <SuperUserTenantField value={tenantId} onChange={setTenantId} />
              </div>
            </CardContent>
          </Card>

          {/* Logo */}
          <Card>
            <CardHeader><CardTitle>{t('agencies.add.logoTitle')}</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <div className="w-20 h-20 rounded-lg border border-dashed border-border bg-muted/40 overflow-hidden flex items-center justify-center">
                  {logoPreview
                    ? <img src={logoPreview} alt={t('agencies.add.logoPreviewAlt')} className="w-full h-full object-contain" />
                    : <Upload className="w-6 h-6 text-muted-foreground" />}
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" asChild>
                    <label className="cursor-pointer">
                      <input type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" className="sr-only" onChange={handleLogoPick} />
                      {logoPreview ? t('agencies.add.replaceLogo') : t('agencies.add.selectLogo')}
                    </label>
                  </Button>
                  {logoPreview && (
                    <Button type="button" variant="ghost" size="sm" onClick={clearLogo}>
                      <X className="w-4 h-4 me-1" /> {t('agencies.add.clearLogo')}
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {t('agencies.add.logoHelp')}
              </p>
            </CardContent>
          </Card>

          {/* Contact person */}
          <Card>
            <CardHeader><CardTitle>{t('agencies.add.contactTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contactFirstName">{t('agencies.add.firstName')}</Label>
                  <Input id="contactFirstName" value={form.contactFirstName} onChange={e => setField('contactFirstName', e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactMiddleName">{t('agencies.add.middleName')}</Label>
                  <Input id="contactMiddleName" value={form.contactMiddleName} onChange={e => setField('contactMiddleName', e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactLastName">{t('agencies.add.lastName')}</Label>
                  <Input id="contactLastName" value={form.contactLastName} onChange={e => setField('contactLastName', e.target.value)} required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t('agencies.add.email')}</Label>
                  <Input id="email" type="email" placeholder={t('agencies.add.emailPh')} value={form.email} onChange={e => setField('email', e.target.value)} required
                    aria-invalid={!!fieldErrs.email}
                    className={fieldErrs.email ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                  <FieldError errors={fieldErrs} name="email" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">{t('agencies.add.phone')}</Label>
                  <PhoneInput id="phone" value={form.phone} onChange={v => setField('phone', v)} required />
                  <FieldError errors={fieldErrs} name="phone" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="whatsapp">{t('agencies.add.whatsapp')}</Label>
                <PhoneInput id="whatsapp" value={form.whatsapp} onChange={v => setField('whatsapp', v)} placeholder={t('agencies.add.whatsappPh')} />
              </div>
            </CardContent>
          </Card>

          {/* HQ address */}
          <Card>
            <CardHeader><CardTitle>{t('agencies.add.hqTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="addressLine1">{t('agencies.add.addressLine1')}</Label>
                <Input id="addressLine1" value={form.addressLine1} onChange={e => setField('addressLine1', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="addressLine2">{t('agencies.add.addressLine2')}</Label>
                <Input id="addressLine2" value={form.addressLine2} onChange={e => setField('addressLine2', e.target.value)} />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="city">{t('agencies.add.city')}</Label>
                  <Input id="city" value={form.city} onChange={e => setField('city', e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="stateRegion">{t('agencies.add.stateRegion')}</Label>
                  <Input id="stateRegion" value={form.stateRegion} onChange={e => setField('stateRegion', e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="postalCode">{t('agencies.add.postalCode')}</Label>
                  <Input id="postalCode" value={form.postalCode} onChange={e => setField('postalCode', e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('agencies.add.addressCountryHelp')}
              </p>
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader><CardTitle>{t('agencies.add.notesTitle')}</CardTitle></CardHeader>
            <CardContent>
              <Textarea
                id="notes"
                rows={5}
                placeholder={t('agencies.add.notesPh')}
                value={form.notes}
                onChange={e => setField('notes', e.target.value)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('agencies.add.documentsTitle')}</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {t('agencies.add.documentsHelp')}
              </p>
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="submit" className="flex-1" disabled={submitting}>
              {submitting ? t('agencies.add.submitting') : t('agencies.add.submit')}
            </Button>
            <Button type="button" variant="outline" className="flex-1" asChild>
              <Link to="/dashboard/agencies">{tc('actions.cancel')}</Link>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
