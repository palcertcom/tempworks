import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ShieldOff, Upload, X, FileText, Download } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { usePermissions } from '../../hooks/usePermissions';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
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
import { SuperUserTenantField } from '../../components/ui/super-user-tenant-field';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { agenciesApi, documentsApi, resolveAssetUrl, settingsApi, getCurrentUser, usersApi } from '../../services/api';
import { formatDate } from '../../../i18n/formatters';

function looksLikeWebsite(v: string): boolean {
  if (!v) return true;
  const s = v.trim();
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
  isSystem: boolean;
};

export function EditAgency() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canEdit } = usePermissions();
  const { id } = useParams();
  const navigate = useNavigate();
  const currentRole = getCurrentUser()?.role;
  const isSystemAdmin = currentRole === 'System Admin';
  // Agency Manager can edit profile fields of their own agency but
  // not the business-identity fields (name, country, status). The
  // backend strips these from the payload regardless; the UI locks
  // them so nothing is silently ignored.
  const isAgencyManager = currentRole === 'Agency Manager';
  // Phase 3.15 — Tenancy Scope is a PlatformAdmin SUPER-only control.
  // The field is fetched from the viewer's own user record; while it
  // resolves the section stays hidden.
  const currentUserId = getCurrentUser()?.id;
  const [viewerIsSuperPa, setViewerIsSuperPa] = useState(false);
  useEffect(() => {
    if (!currentUserId) return;
    usersApi.get(currentUserId)
      .then((u: any) => setViewerIsSuperPa(u?.platformAdmin?.level === 'SUPER'))
      .catch(() => setViewerIsSuperPa(false));
  }, [currentUserId]);

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();

  const [form, setForm] = useState<FormShape>({
    name: '', country: '', contactFirstName: '', contactMiddleName: '', contactLastName: '',
    email: '', phone: '', whatsapp: '', status: 'ACTIVE', website: '',
    addressLine1: '', addressLine2: '', city: '', stateRegion: '', postalCode: '',
    notes: '', isSystem: false,
  });
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  // Phase 3 (#27) — SUPER PlatformAdmin can reassign the agency to a
  // different tenant from this screen. The backend re-checks SUPER
  // before honoring tenantId; this state is a UI affordance only.
  const [tenantId, setTenantId] = useState<string>('');

  // Attached documents (contract, etc.) via the shared /documents flow.
  const [documents, setDocuments] = useState<any[]>([]);
  const [docTypes, setDocTypes] = useState<any[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [newDocTypeId, setNewDocTypeId] = useState<string>('');
  const [newDocName, setNewDocName] = useState<string>('');

  const loadDocs = useCallback(() => {
    if (!id) return;
    documentsApi.list({ entityType: 'AGENCY', entityId: id, limit: 100 })
      .then((res: any) => setDocuments(res?.data ?? []))
      .catch(() => setDocuments([]));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    agenciesApi.get(id)
      .then((agency: any) => {
        // Fallback to splitting legacy contactPerson into first/last pieces.
        let first = agency.contactFirstName ?? '';
        let middle = agency.contactMiddleName ?? '';
        let last  = agency.contactLastName ?? '';
        if (!first && !last && agency.contactPerson) {
          const parts = String(agency.contactPerson).trim().split(/\s+/);
          if (parts.length === 1) { first = parts[0]; }
          else if (parts.length === 2) { first = parts[0]; last = parts[1]; }
          else { first = parts[0]; last = parts[parts.length - 1]; middle = parts.slice(1, -1).join(' '); }
        }
        setForm({
          name: agency.name ?? '',
          country: agency.country ?? '',
          contactFirstName: first,
          contactMiddleName: middle,
          contactLastName: last,
          email: agency.email ?? '',
          phone: agency.phone ?? '',
          whatsapp: agency.whatsapp ?? '',
          status: agency.status ?? 'ACTIVE',
          website: agency.website ?? '',
          addressLine1: agency.addressLine1 ?? '',
          addressLine2: agency.addressLine2 ?? '',
          city: agency.city ?? '',
          stateRegion: agency.stateRegion ?? '',
          postalCode: agency.postalCode ?? '',
          notes: agency.notes ?? '',
          isSystem: Boolean(agency.isSystem),
        });
        setLogoUrl(agency.logoUrl ?? null);
        setTenantId(agency.tenantId ?? '');
      })
      .catch(() => toast.error(t('agencies.edit.loadFailed')))
      .finally(() => setLoading(false));

    loadDocs();
    settingsApi.getDocumentTypes().then((res: any) => {
      setDocTypes(Array.isArray(res) ? res : (res?.data ?? []));
    }).catch(() => setDocTypes([]));
  }, [id, loadDocs]);

  if (!canEdit('agencies')) {
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

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f || !id) return;
    if (f.size > 5 * 1024 * 1024) { toast.error(tc('toast.logoTooLarge')); return; }
    if (!/^image\/(jpe?g|png|webp|svg\+xml)$/i.test(f.type)) {
      toast.error(t('agencies.add.validation.logoFormat')); return;
    }
    setUploadingLogo(true);
    try {
      const updated = await agenciesApi.uploadLogo(id, f);
      setLogoUrl(updated.logoUrl ?? null);
      toast.success(t('agencies.edit.logoUpdated'));
    } catch (err: any) {
      toast.error(apiError(err, t('agencies.edit.logoFailed')));
    } finally {
      setUploadingLogo(false);
      // Allow selecting the same file again later
      (e.target as HTMLInputElement).value = '';
    }
  };

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f || !id) return;
    if (!newDocTypeId) { toast.error(t('agencies.edit.chooseDocType')); (e.target as HTMLInputElement).value = ''; return; }
    const fd = new FormData();
    fd.append('file', f);
    fd.append('entityType', 'AGENCY');
    fd.append('entityId', id);
    fd.append('documentTypeId', newDocTypeId);
    fd.append('name', newDocName.trim() || f.name);
    setUploadingDoc(true);
    try {
      await documentsApi.upload(fd);
      toast.success(t('agencies.edit.documentUploaded'));
      setNewDocName('');
      setNewDocTypeId('');
      loadDocs();
    } catch (err: any) {
      toast.error(apiError(err, t('agencies.edit.documentUploadFailed')));
    } finally {
      setUploadingDoc(false);
      (e.target as HTMLInputElement).value = '';
    }
  };

  const handleDocDelete = async (doc: any) => {
    if (!(await confirm({
      title: t('agencies.edit.removeDocTitle'),
      description: t('agencies.edit.removeDocBody', { name: doc.name }),
      confirmText: tc('actions.remove'), tone: 'destructive',
    }))) return;
    try {
      await documentsApi.delete(doc.id);
      toast.success(t('agencies.edit.documentRemoved'));
      loadDocs();
    } catch (err: any) {
      toast.error(apiError(err, t('agencies.edit.documentRemoveFailed')));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFieldErrors();
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
        contactPerson: [form.contactFirstName, form.contactMiddleName, form.contactLastName]
          .map(s => s.trim()).filter(Boolean).join(' '),
      };
      // Tenancy Scope (isSystem) is a SUPER PlatformAdmin-only switch.
      // The backend strips it defensively, but drop it from the wire
      // payload too unless the viewer is SUPER so nothing drifts in
      // the audit log.
      if (!viewerIsSuperPa) delete payload.isSystem;
      // Phase 3 (#27) — SUPER-only tenant reassignment. A blank value
      // means "no change"; the backend re-validates SUPER.
      if (viewerIsSuperPa && tenantId) payload.tenantId = tenantId;
      else delete payload.tenantId;
      await agenciesApi.update(id!, payload);
      toast.success(t('agencies.edit.updateSuccess'));
      navigate(`/dashboard/agencies/${id}`);
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('agencies.edit.updateFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8 text-muted-foreground">{tc('states.loading')}</div>;

  const logoSrc = logoUrl ? resolveAssetUrl(logoUrl) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/agencies/${id}`}><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('agencies.edit.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('agencies.edit.subtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-w-3xl space-y-6">
          <ValidationSummary errors={fieldErrs} />
          {/* SUPER tenancy controls — surfaced at the top so SUPER admins
              can reassign the agency's tenant without scrolling through
              the whole form. Hidden for everyone else. */}
          {viewerIsSuperPa && (
            <Card className="border-blue-200">
              <CardHeader><CardTitle>{t('agencies.edit.tenancyTitle', { defaultValue: 'Tenancy' })}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <SuperUserTenantField value={tenantId} onChange={setTenantId} />
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    id="isSystem"
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-input text-primary focus-visible:ring-2 focus-visible:ring-ring"
                    checked={form.isSystem}
                    onChange={e => setField('isSystem', e.target.checked)}
                  />
                  <div className="space-y-1">
                    <div className="font-medium text-[#0F172A]">{t('agencies.edit.tenancyToggle', { defaultValue: 'Mark as Tempworks root' })}</div>
                    <p className="text-sm text-muted-foreground">
                      {t('agencies.edit.tenancyHelp', { defaultValue: 'When on, this agency’s users see global data instead of being scoped to one tenant.' })}
                    </p>
                  </div>
                </label>
              </CardContent>
            </Card>
          )}
          {/* Identity */}
          <Card>
            <CardHeader><CardTitle>{t('agencies.add.agencyInfoTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2 col-span-2">
                  <Label htmlFor="name">{t('agencies.add.agencyName')}</Label>
                  <Input id="name" value={form.name} onChange={e => setField('name', e.target.value)} required disabled={isAgencyManager}
                    aria-invalid={!!fieldErrs.name}
                    className={fieldErrs.name ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                  <FieldError errors={fieldErrs} name="name" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">{t('agencies.add.country')}</Label>
                  <CountrySelect value={form.country} onChange={v => setField('country', v)} required disabled={isAgencyManager} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">{t('agencies.add.status')}</Label>
                  <Select value={form.status} onValueChange={v => setField('status', v)} disabled={isAgencyManager}>
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
            </CardContent>
          </Card>

          {/* Logo */}
          <Card>
            <CardHeader><CardTitle>{t('agencies.add.logoTitle')}</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <div className="w-20 h-20 rounded-lg border border-dashed border-border bg-muted/40 overflow-hidden flex items-center justify-center">
                  {logoSrc
                    ? <img src={logoSrc} alt={t('agencies.edit.logoAlt')} className="w-full h-full object-contain" />
                    : <Upload className="w-6 h-6 text-muted-foreground" />}
                </div>
                <Button type="button" variant="outline" size="sm" asChild disabled={uploadingLogo}>
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/svg+xml"
                      className="sr-only"
                      onChange={handleLogoUpload}
                      disabled={uploadingLogo}
                    />
                    {uploadingLogo ? t('agencies.edit.uploading') : logoSrc ? t('agencies.edit.replaceLogo') : t('agencies.edit.uploadLogo')}
                  </label>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {t('agencies.edit.logoHelp')}
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
                  <Input id="email" type="email" value={form.email} onChange={e => setField('email', e.target.value)} required
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

          {/* Tenancy card was moved to the top of the form. */}

          {/* Attached documents */}
          <Card>
            <CardHeader><CardTitle>{t('agencies.add.documentsTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {documents.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('agencies.edit.noDocuments')}</p>
              )}
              {documents.length > 0 && (
                <div className="divide-y rounded-md border">
                  {documents.map(doc => (
                    <div key={doc.id} className="flex items-center gap-3 p-3">
                      <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{doc.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {doc.documentType?.name ?? '—'}
                          {doc.expiryDate ? t('agencies.edit.expiresPrefix', { date: formatDate(doc.expiryDate) }) : ''}
                        </p>
                      </div>
                      {doc.fileUrl && (
                        <Button type="button" variant="ghost" size="sm" asChild>
                          <a href={resolveAssetUrl(doc.fileUrl)} target="_blank" rel="noopener noreferrer">
                            <Download className="w-4 h-4" />
                          </a>
                        </Button>
                      )}
                      <Button type="button" variant="ghost" size="sm" onClick={() => handleDocDelete(doc)} className="text-red-600 hover:text-red-700">
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                <div className="space-y-2">
                  <Label>{t('agencies.edit.documentType')}</Label>
                  <Select value={newDocTypeId} onValueChange={setNewDocTypeId}>
                    <SelectTrigger><SelectValue placeholder={t('agencies.edit.documentTypePh')} /></SelectTrigger>
                    <SelectContent>
                      {docTypes.map((dt: any) => (
                        <SelectItem key={dt.id} value={dt.id}>{dt.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t('agencies.edit.documentName')}</Label>
                  <Input value={newDocName} onChange={e => setNewDocName(e.target.value)} placeholder={t('agencies.edit.documentNamePh')} />
                </div>
                <Button type="button" variant="outline" size="sm" asChild disabled={uploadingDoc || !newDocTypeId}>
                  <label className="cursor-pointer">
                    <input type="file" className="sr-only" onChange={handleDocUpload} disabled={uploadingDoc || !newDocTypeId} />
                    <Upload className="w-4 h-4 me-1.5" />
                    {uploadingDoc ? t('agencies.edit.uploading') : t('agencies.edit.uploadButton')}
                  </label>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('agencies.edit.documentsModuleHelp')}
              </p>
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="submit" className="flex-1" disabled={submitting}>
              {submitting ? t('agencies.edit.saving') : t('agencies.edit.saveChanges')}
            </Button>
            <Button type="button" variant="outline" className="flex-1" asChild>
              <Link to={`/dashboard/agencies/${id}`}>{tc('actions.cancel')}</Link>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
