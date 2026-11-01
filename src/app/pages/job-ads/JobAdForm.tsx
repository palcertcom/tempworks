import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { jobAdsApi, settingsApi, tenantsApi, getCurrentUser } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { CountrySelect } from '../../components/ui/CountrySelect';
import { Checkbox } from '../../components/ui/checkbox';

interface Constants {
  statuses:      string[];
  contractTypes: string[];
  currencies:    string[];
}

const DEFAULT_CONSTANTS: Constants = {
  statuses:      ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  contractTypes: ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Seasonal'],
  currencies:    ['GBP', 'EUR', 'USD', 'PLN'],
};

const EMPTY_FORM = {
  title:        '',
  category:     '',
  description:  '',
  city:         '',
  country:      '',
  contractType: 'Full-time',
  salaryMin:    '',
  salaryMax:    '',
  currency:     'GBP',
  status:       'DRAFT',
  tenantId:     '',
};

export function JobAdForm() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);

  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();

  const [form, setForm] = useState(EMPTY_FORM);
  const [constants, setConstants] = useState<Constants>(DEFAULT_CONSTANTS);
  const [categories, setCategories] = useState<string[]>([]);
  const [docTypes, setDocTypes] = useState<string[]>([]);
  const [requiredDocuments, setRequiredDocuments] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const cityInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    jobAdsApi.getConstants()
      .then((c: any) => setConstants(c))
      .catch(() => {});

    settingsApi.getJobTypes()
      .then((types: any[]) => setCategories(types.filter((t: any) => t.isActive).map((t: any) => t.name)))
      .catch(() => {});

    settingsApi.getDocumentTypes()
      .then((types: any[]) => {
        const names = types.filter((t: any) => t.isActive !== false).map((t: any) => t.name).filter(Boolean);
        if (names.length > 0) setDocTypes(names);
      })
      .catch(() => {});

    if (isEdit && id) {
      jobAdsApi.get(id).then((ad: any) => {
        setForm({
          title:        ad.title        ?? '',
          category:     ad.category     ?? '',
          description:  ad.description  ?? '',
          city:         ad.city         ?? '',
          country:      ad.country      ?? '',
          contractType: ad.contractType ?? 'Full-time',
          salaryMin:    ad.salaryMin    != null ? String(ad.salaryMin)  : '',
          salaryMax:    ad.salaryMax    != null ? String(ad.salaryMax)  : '',
          currency:     ad.currency     ?? 'GBP',
          status:       ad.status       ?? 'DRAFT',
          tenantId:     ad.tenantId     ?? '',
        });
        setRequiredDocuments(Array.isArray(ad.requiredDocuments) ? ad.requiredDocuments : []);
      }).catch(() => {
        toast.error(tc('toast.loadFailed'));
        navigate('/dashboard/job-ads');
      }).finally(() => setLoading(false));
    }
  }, [id]);

  // Phase 3.18 — load the tenants list once for SUPER PlatformAdmin
  // viewers so the form can offer a Tenant select. Other viewers never
  // hit the endpoint (the backend rejects it without SUPER anyway).
  // @tenant-reviewed: phase318-tenant-public-jobs
  const me = getCurrentUser();
  const isSuper = me?.platformAdmin?.level === 'SUPER';
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  useEffect(() => {
    if (!isSuper) return;
    tenantsApi.list({ limit: 200 })
      .then((res) => setTenantOptions(res.data.map(t => ({ id: t.id, name: t.name, slug: t.slug }))))
      .catch(() => setTenantOptions([]));
  }, [isSuper]);

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm(prev => ({ ...prev, [field]: e.target.value }));
    if (fieldErrs[field]) clearError(field);
  };

  const handleSave = async (publishNow = false) => {
    setSubmitAttempted(true);
    clearFieldErrors();
    if (!form.title.trim())       return toast.error(tc('toast.titleRequired'));
    if (!form.category.trim())    return toast.error(tc('toast.categoryRequired'));
    if (!form.description.trim()) return toast.error(tc('toast.descriptionRequired'));
    if (!form.city.trim()) {
      toast.error(t('jobAds.form.cityRequired'));
      cityInputRef.current?.focus();
      return;
    }
    if (!form.country.trim())     return toast.error(t('jobAds.form.countryRequired'));

    setSaving(true);
    try {
      const payload: Record<string, any> = {
        title:             form.title,
        category:          form.category,
        description:       form.description,
        city:              form.city,
        country:           form.country,
        contractType:      form.contractType,
        currency:          form.currency,
        status:            publishNow ? 'PUBLISHED' : form.status,
        requiredDocuments: requiredDocuments,
        ...(form.salaryMin !== '' ? { salaryMin: Number(form.salaryMin) } : {}),
        ...(form.salaryMax !== '' ? { salaryMax: Number(form.salaryMax) } : {}),
        // Phase 3.18 — SUPER PlatformAdmin only. Backend strips it
        // silently for everyone else, but we drop it here too to keep
        // the wire payload tidy.
        ...(isSuper && form.tenantId ? { tenantId: form.tenantId } : {}),
      };

      if (isEdit && id) {
        await jobAdsApi.update(id, payload);
        toast.success(tc('toast.savedSuccessfully'));
      } else {
        await jobAdsApi.create(payload);
        toast.success(publishNow ? tc('toast.published') : tc('toast.savedSuccessfully'));
      }
      navigate('/dashboard/job-ads');
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 text-center text-muted-foreground">{t('jobAds.form.loading')}</div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard/job-ads')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {isEdit ? t('jobAds.form.editTitle') : t('jobAds.form.addTitle')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isEdit ? t('jobAds.form.editSubtitle') : t('jobAds.form.addSubtitle')}
          </p>
        </div>
      </div>

      <ValidationSummary errors={fieldErrs} />

      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('jobAds.form.basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('jobAds.form.title')} <span className="text-destructive">*</span></Label>
            <Input
              value={form.title}
              onChange={set('title')}
              placeholder={t('jobAds.form.titlePh')}
              aria-invalid={!!fieldErrs.title}
              className={fieldErrs.title ? 'border-red-500 focus-visible:ring-red-500' : ''}
            />
            <FieldError errors={fieldErrs} name="title" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>{t('jobAds.form.category')} <span className="text-destructive">*</span></Label>
              <Select value={form.category} onValueChange={v => { setForm(p => ({ ...p, category: v })); if (fieldErrs.category) clearError('category'); }}>
                <SelectTrigger aria-invalid={!!fieldErrs.category}
                  className={fieldErrs.category ? 'border-red-500 focus-visible:ring-red-500' : ''}>
                  <SelectValue placeholder={t('jobAds.form.categoryPh')} />
                </SelectTrigger>
                <SelectContent>
                  {categories.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={fieldErrs} name="category" />
            </div>
            <div>
              <Label>{t('jobAds.form.contractType')}</Label>
              <Select value={form.contractType} onValueChange={v => setForm(p => ({ ...p, contractType: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {constants.contractTypes.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="city">{t('jobAds.form.city')} <span className="text-destructive">*</span></Label>
              <Input
                id="city"
                ref={cityInputRef}
                value={form.city}
                onChange={set('city')}
                placeholder={t('jobAds.form.cityPh')}
                required
                aria-required="true"
                aria-invalid={(submitAttempted && !form.city.trim()) || !!fieldErrs.city}
                className={(submitAttempted && !form.city.trim()) || fieldErrs.city ? 'border-destructive focus-visible:ring-destructive' : ''}
              />
              {submitAttempted && !form.city.trim() && (
                <p className="text-xs text-destructive mt-1">{t('jobAds.form.cityRequired')}</p>
              )}
              <FieldError errors={fieldErrs} name="city" />
            </div>
            <div>
              <Label>{t('jobAds.form.country')} <span className="text-destructive">*</span></Label>
              <CountrySelect
                value={form.country}
                onChange={v => { setForm(p => ({ ...p, country: v })); if (fieldErrs.country) clearError('country'); }}
                placeholder={t('jobAds.form.countryPh')}
                required
              />
              {submitAttempted && !form.country.trim() && (
                <p className="text-xs text-destructive mt-1">{t('jobAds.form.countryRequired')}</p>
              )}
              <FieldError errors={fieldErrs} name="country" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Description */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('jobAds.form.jobDescription')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Label>{t('jobAds.form.description')} <span className="text-destructive">*</span></Label>
          <textarea
            value={form.description}
            onChange={set('description')}
            rows={10}
            placeholder={t('jobAds.form.descriptionPh')}
            aria-invalid={!!fieldErrs.description}
            className={`mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y ${
              fieldErrs.description ? 'border-red-500 focus-visible:ring-red-500' : 'border-input'
            }`}
          />
          <FieldError errors={fieldErrs} name="description" />
        </CardContent>
      </Card>

      {/* Salary & Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('jobAds.form.salaryStatus')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label>{t('jobAds.form.minSalary')}</Label>
              <Input
                type="number" min="0"
                value={form.salaryMin}
                onChange={set('salaryMin')}
                placeholder={t('jobAds.form.minSalaryPh')}
              />
            </div>
            <div>
              <Label>{t('jobAds.form.maxSalary')}</Label>
              <Input
                type="number" min="0"
                value={form.salaryMax}
                onChange={set('salaryMax')}
                placeholder={t('jobAds.form.maxSalaryPh')}
              />
            </div>
            <div>
              <Label>{t('jobAds.form.currency')}</Label>
              <Select value={form.currency} onValueChange={v => setForm(p => ({ ...p, currency: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {constants.currencies.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>{t('jobAds.form.status')}</Label>
            <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {constants.statuses.map(s => (
                  <SelectItem key={s} value={s}>
                    {s === 'DRAFT' ? t('jobAds.list.draft')
                      : s === 'PUBLISHED' ? t('jobAds.list.published')
                      : s === 'ARCHIVED' ? t('jobAds.list.archived')
                      : s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Phase 3.18 — Tenant assignment, SUPER PlatformAdmin only. */}
          {isSuper && (
            <div>
              <Label>{t('jobAds.form.tenant', { defaultValue: 'Tenant' })}</Label>
              <Select
                value={form.tenantId || '__none__'}
                onValueChange={v => setForm(p => ({ ...p, tenantId: v === '__none__' ? '' : v }))}
              >
                <SelectTrigger className="w-72">
                  <SelectValue placeholder={t('jobAds.form.tenantPlaceholder', { defaultValue: 'Select tenant' })} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    {t('jobAds.form.tenantNone', { defaultValue: 'No tenant (global)' })}
                  </SelectItem>
                  {tenantOptions.map((tn) => (
                    <SelectItem key={tn.id} value={tn.id}>
                      {tn.name} <span className="text-xs text-muted-foreground">/{tn.slug}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {t('jobAds.form.tenantHelp', { defaultValue: 'Moves this Job Ad to a different tenant. SUPER PlatformAdmin only.' })}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Required Documents */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('jobAds.form.requiredDocuments')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('jobAds.form.requiredDocsHelp')}
          </p>
          {docTypes.length === 0 && (
            <p className="text-sm text-muted-foreground italic">{t('jobAds.form.loadingDocTypes')}</p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {docTypes.map(name => (
              <label key={name} className="flex items-center gap-2.5 cursor-pointer select-none rounded-md px-3 py-2 hover:bg-muted transition-colors">
                <Checkbox
                  checked={requiredDocuments.includes(name)}
                  onCheckedChange={checked => {
                    setRequiredDocuments(prev =>
                      checked ? [...prev, name] : prev.filter(d => d !== name)
                    );
                  }}
                />
                <span className="text-sm">{name}</span>
              </label>
            ))}
          </div>
          {requiredDocuments.length > 0 && (
            <p className="text-xs text-blue-600 font-medium">
              {t('jobAds.form.docsRequired', { count: requiredDocuments.length, list: requiredDocuments.join(', ') })}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        <Button variant="outline" onClick={() => navigate('/dashboard/job-ads')}>
          {t('jobAds.form.cancel')}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => handleSave(false)}
            disabled={saving}
          >
            <Save className="w-4 h-4 me-2" />
            {t('jobAds.form.saveAsDraft')}
          </Button>
          {form.status !== 'PUBLISHED' && (
            <Button
              onClick={() => handleSave(true)}
              disabled={saving}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Eye className="w-4 h-4 me-2" />
              {isEdit ? t('jobAds.form.savePublish') : t('jobAds.form.createPublish')}
            </Button>
          )}
          {form.status === 'PUBLISHED' && (
            <Button
              onClick={() => handleSave(false)}
              disabled={saving}
            >
              <Save className="w-4 h-4 me-2" />
              {t('jobAds.form.saveChanges')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
