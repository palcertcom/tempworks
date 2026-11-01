import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { tenantsApi, getCurrentUser, type TenantRecord } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { toast } from 'sonner';

// Phase 3.15 — Tenant create/edit form.
// @tenant-reviewed: phase315-tenant-management-module
function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

interface Props { mode: 'create' | 'edit' }

export function TenantForm({ mode }: Props) {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();
  const { id } = useParams();
  const me = getCurrentUser();
  const isSuper = me?.platformAdmin?.level === 'SUPER';

  const [loading, setLoading] = useState(mode === 'edit');
  const [saving, setSaving]   = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);

  const [form, setForm] = useState<Partial<TenantRecord>>({
    name: '', slug: '', customDomain: '',
    status: 'ACTIVE', region: 'eu',
    primaryColor: '#2563eb', timezone: '', locale: 'en',
    contactEmail: '', contactPhone: '', address: '', notes: '',
    logoUrl: '',
  });

  useEffect(() => {
    if (mode === 'edit' && id) {
      tenantsApi.get(id).then((t) => { setForm(t); setSlugTouched(true); })
        .catch((err) => toast.error(apiError(err)))
        .finally(() => setLoading(false));
    }
  }, [mode, id]);

  const setField = <K extends keyof TenantRecord>(k: K, v: TenantRecord[K]) =>
    setForm(prev => ({ ...prev, [k]: v }));

  const onNameChange = (v: string) => {
    setField('name', v);
    if (!slugTouched && mode === 'create') setField('slug', slugify(v));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Partial<TenantRecord> = { ...form };
      if (payload.customDomain === '') payload.customDomain = null;
      if (mode === 'create') {
        const created = await tenantsApi.create(payload);
        toast.success(t('tenants.toastCreated'));
        navigate(`/dashboard/tenants/${created.id}`);
      } else {
        const updated = await tenantsApi.update(id!, payload);
        toast.success(t('tenants.toastUpdated'));
        navigate(`/dashboard/tenants/${updated.id}`);
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally { setSaving(false); }
  };

  if (loading) return <div className="p-6 text-muted-foreground">{t('tenants.list.loading')}</div>;

  const slugReadOnly = mode === 'edit' && !isSuper;

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">
          {mode === 'create' ? t('tenants.form.titleCreate') : t('tenants.form.titleEdit')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('tenants.form.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="py-6 space-y-4">
          <h2 className="font-medium">{t('tenants.form.sections.general')}</h2>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label>{t('tenants.fields.name')} *</Label>
              <Input required value={form.name ?? ''} onChange={(e) => onNameChange(e.target.value)} />
            </div>
            <div>
              <Label>{t('tenants.fields.slug')} *</Label>
              <Input
                required
                value={form.slug ?? ''}
                readOnly={slugReadOnly}
                onChange={(e) => { setSlugTouched(true); setField('slug', e.target.value.toLowerCase()); }}
                pattern="^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
                title={t('tenants.form.slugHelp')}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {slugReadOnly ? t('tenants.form.slugImmutable') : t('tenants.form.slugHelp')}
              </p>
            </div>
            <div>
              <Label>{t('tenants.fields.customDomain')}</Label>
              <Input value={form.customDomain ?? ''} onChange={(e) => setField('customDomain', e.target.value)} placeholder="acme.example.com" />
            </div>
            <div>
              <Label>{t('tenants.fields.status')}</Label>
              <Select value={form.status ?? 'ACTIVE'} onValueChange={(v) => setField('status', v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">{t('tenants.statuses.active')}</SelectItem>
                  <SelectItem value="SUSPENDED">{t('tenants.statuses.suspended')}</SelectItem>
                  <SelectItem value="INACTIVE">{t('tenants.statuses.inactive')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-6 space-y-4">
          <h2 className="font-medium">{t('tenants.form.sections.branding')}</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label>{t('tenants.fields.logoUrl')}</Label>
              <Input value={form.logoUrl ?? ''} onChange={(e) => setField('logoUrl', e.target.value)} placeholder="https://…" />
            </div>
            <div>
              <Label>{t('tenants.fields.primaryColor')}</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.primaryColor ?? '#2563eb'} onChange={(e) => setField('primaryColor', e.target.value)} className="h-10 w-12 rounded border" />
                <Input value={form.primaryColor ?? ''} onChange={(e) => setField('primaryColor', e.target.value)} />
              </div>
            </div>
            <div>
              <Label>{t('tenants.fields.locale')}</Label>
              <Select value={form.locale ?? 'en'} onValueChange={(v) => setField('locale', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['en', 'ar', 'de', 'ru', 'sk', 'tr'].map(c => <SelectItem key={c} value={c}>{c.toUpperCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('tenants.fields.timezone')}</Label>
              <Input value={form.timezone ?? ''} onChange={(e) => setField('timezone', e.target.value)} placeholder="Europe/Berlin" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-6 space-y-4">
          <h2 className="font-medium">{t('tenants.form.sections.contact')}</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label>{t('tenants.fields.contactEmail')}</Label>
              <Input type="email" value={form.contactEmail ?? ''} onChange={(e) => setField('contactEmail', e.target.value)} />
            </div>
            <div>
              <Label>{t('tenants.fields.contactPhone')}</Label>
              <Input value={form.contactPhone ?? ''} onChange={(e) => setField('contactPhone', e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Label>{t('tenants.fields.address')}</Label>
              <Input value={form.address ?? ''} onChange={(e) => setField('address', e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Label>{t('tenants.fields.notes')}</Label>
              <Textarea value={form.notes ?? ''} onChange={(e) => setField('notes', e.target.value)} rows={3} />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => navigate(-1)}>{t('tenants.form.cancel')}</Button>
        <Button type="submit" disabled={saving}>{saving ? t('tenants.form.saving') : t('tenants.form.save')}</Button>
      </div>
    </form>
  );
}
