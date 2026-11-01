import { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from 'sonner';
import { documentsApi, settingsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { ErrorBanner } from '../../components/ui/error-banner';
import { DateInput } from '../../components/ui/date-input';
import { Checkbox } from '../../components/ui/checkbox';
import { getRequiredDocumentMetadataFields } from '../../utils/documentMetadataRules';

export function EditDocument() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { id } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  // When the fetch fails (network, 403, 404) we must NOT fall through to
  // an empty editable form — saving it would wipe the real metadata.
  // Track the failure and render a top error + Back instead.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [documentTypes, setDocumentTypes] = useState<{ id: string; name: string; code?: string | null }[]>([]);
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors } = useValidationErrors();
  const [metaErrs, setMetaErrs] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    name: '',
    documentTypeId: '',
    expiryDate: '',
    issueDate: '',
    documentNumber: '',
    issuer: '',
    notes: '',
  });
  // "Open-ended" (no expiry) toggle — mirrors DocumentUpload. Seeded
  // from the loaded doc: if the stored expiryDate is null and the type
  // does not require expiry, treat the row as open-ended.
  const [noExpiry, setNoExpiry] = useState(false);

  const selectedType = useMemo(
    () => documentTypes.find(dt => dt.id === form.documentTypeId),
    [documentTypes, form.documentTypeId],
  );
  const requiredFields = useMemo(() => getRequiredDocumentMetadataFields(selectedType), [selectedType]);
  const shownErrs = { ...metaErrs, ...fieldErrs };

  useEffect(() => {
    settingsApi.getDocumentTypes().then((types: any[]) => setDocumentTypes(types)).catch(() => {});
    documentsApi.get(id!).then((doc: any) => {
      setForm({
        name: doc.name ?? '',
        documentTypeId: doc.documentTypeId ?? doc.documentType?.id ?? '',
        expiryDate: doc.expiryDate ? String(doc.expiryDate).slice(0, 10) : '',
        issueDate: doc.issueDate ? String(doc.issueDate).slice(0, 10) : '',
        documentNumber: doc.documentNumber ?? '',
        issuer: doc.issuer ?? '',
        notes: doc.notes ?? '',
      });
      // Seed the toggle from the loaded row: null expiry == open-ended.
      setNoExpiry(!doc.expiryDate);
    }).catch((err: any) => {
      setLoadError(apiError(err, t('documents.edit.loadFailed')));
    })
      .finally(() => setLoading(false));
  }, [id, t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFieldErrors();
    setMetaErrs({});

    // Per-type required metadata (Passport → issue + expiry date, etc.).
    const docTypeName = selectedType?.name ?? '';
    const me: Record<string, string> = {};
    if (requiredFields.includes('issueDate') && !form.issueDate)
      me.issueDate = t('validation.ISSUE_DATE_REQUIRED', { ns: 'errors', docType: docTypeName, defaultValue: 'Issue date is required.' });
    if (requiredFields.includes('expiryDate') && !form.expiryDate && !noExpiry)
      me.expiryDate = t('validation.EXPIRY_DATE_REQUIRED', { ns: 'errors', docType: docTypeName, defaultValue: 'Expiry date is required.' });
    if (requiredFields.includes('documentNumber') && !form.documentNumber.trim())
      me.documentNumber = t('validation.DOCUMENT_NUMBER_REQUIRED', { ns: 'errors', docType: docTypeName, defaultValue: 'Document number is required.' });
    if (Object.keys(me).length) { setMetaErrs(me); toast.error(t('documents.edit.updateFailed')); return; }

    setSubmitting(true);
    try {
      // The form only renders after a successful load (see loadError
      // guard), so each field already mirrors the stored value — an
      // empty field is therefore an intentional clear, not a premature
      // blank. Send metadata verbatim so clearing works; the backend
      // converts empty dates to null and leaves omitted keys untouched.
      // documentTypeId stays guarded — it's a NOT NULL FK that must
      // never be sent empty.
      const payload: any = {
        name: form.name,
        documentTypeId: form.documentTypeId || undefined,
        documentNumber: form.documentNumber,
        issuer: form.issuer,
        notes: form.notes,
        // Open-ended: clear stored expiry by sending '' (backend turns
        // empty into null per the comment above).
        expiryDate: noExpiry ? '' : form.expiryDate,
        issueDate: form.issueDate,
      };
      await documentsApi.update(id!, payload);
      toast.success(t('documents.edit.updateSuccess'));
      navigate(`/dashboard/documents/${id}`);
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('documents.edit.updateFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8 text-muted-foreground">{tc('states.loading')}</div>;

  // Load failed — show the error at the top and do NOT render the
  // editable form. A blank form here could be saved over the real
  // metadata, which the task explicitly forbids.
  if (loadError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link to={`/dashboard/documents/${id}`}><ArrowLeft className="w-5 h-5" /></Link>
          </Button>
          <div>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{t('documents.edit.title')}</h1>
            <p className="text-muted-foreground mt-1">{t('documents.edit.subtitle')}</p>
          </div>
        </div>
        <div className="max-w-2xl">
          <ErrorBanner message={loadError} onRetry={() => window.location.reload()} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/documents/${id}`}><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('documents.edit.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('documents.edit.subtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-w-2xl space-y-6">
          <ValidationSummary errors={shownErrs} />
          <Card>
            <CardHeader><CardTitle>{t('documents.edit.infoTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">

              <div className="space-y-2">
                <Label htmlFor="name">{t('documents.edit.name')}</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                  required
                  aria-invalid={!!fieldErrs.name}
                  className={fieldErrs.name ? 'border-red-500 focus-visible:ring-red-500' : ''}
                />
                <FieldError errors={fieldErrs} name="name" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="documentTypeId">{t('documents.edit.documentType')}</Label>
                <select
                  id="documentTypeId"
                  value={form.documentTypeId}
                  onChange={e => setForm(prev => ({ ...prev, documentTypeId: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('documents.edit.selectTypePh')}</option>
                  {documentTypes.map(dt => (
                    <option key={dt.id} value={dt.id}>{dt.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="issueDate">
                    {t('documents.edit.issueDate')}
                    {requiredFields.includes('issueDate') && <span className="text-red-500 ms-0.5">*</span>}
                  </Label>
                  <DateInput
                    id="issueDate"
                    value={form.issueDate}
                    onChange={e => { setMetaErrs(p => { const n = { ...p }; delete n.issueDate; return n; }); setForm(prev => ({ ...prev, issueDate: e.target.value })); }}
                  />
                  <FieldError errors={shownErrs} name="issueDate" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="expiryDate">
                    {t('documents.edit.expiryDate')}
                    {requiredFields.includes('expiryDate') && !noExpiry && <span className="text-red-500 ms-0.5">*</span>}
                  </Label>
                  <DateInput
                    id="expiryDate"
                    value={noExpiry ? '' : form.expiryDate}
                    disabled={noExpiry}
                    onChange={e => { setMetaErrs(p => { const n = { ...p }; delete n.expiryDate; return n; }); setForm(prev => ({ ...prev, expiryDate: e.target.value })); }}
                  />
                  {!requiredFields.includes('expiryDate') && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none mt-1">
                      <Checkbox
                        checked={noExpiry}
                        onCheckedChange={(v) => {
                          const on = !!v;
                          setNoExpiry(on);
                          if (on) {
                            setForm(prev => ({ ...prev, expiryDate: '' }));
                            setMetaErrs(p => { const n = { ...p }; delete n.expiryDate; return n; });
                          }
                        }}
                      />
                      {t('documents.edit.noExpiry', { defaultValue: 'No expiry date (open-ended)' })}
                    </label>
                  )}
                  <FieldError errors={shownErrs} name="expiryDate" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="documentNumber">
                    {t('documents.edit.documentNumber')}
                    {requiredFields.includes('documentNumber') && <span className="text-red-500 ms-0.5">*</span>}
                  </Label>
                  <Input
                    id="documentNumber"
                    placeholder={t('documents.edit.documentNumberPh')}
                    value={form.documentNumber}
                    onChange={e => { setMetaErrs(p => { const n = { ...p }; delete n.documentNumber; return n; }); setForm(prev => ({ ...prev, documentNumber: e.target.value })); }}
                  />
                  <FieldError errors={shownErrs} name="documentNumber" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="issuer">{t('documents.edit.issuer')}</Label>
                  <Input
                    id="issuer"
                    placeholder={t('documents.edit.issuerPh')}
                    value={form.issuer}
                    onChange={e => setForm(prev => ({ ...prev, issuer: e.target.value }))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">{t('documents.edit.notes')}</Label>
                <Input
                  id="notes"
                  placeholder={t('documents.edit.notesPh')}
                  value={form.notes}
                  onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
                />
              </div>

            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="submit" className="flex-1" disabled={submitting}>
              <Save className="w-4 h-4 me-2" />
              {submitting ? t('documents.edit.saving') : t('documents.edit.saveChanges')}
            </Button>
            <Button type="button" variant="outline" className="flex-1" asChild>
              <Link to={`/dashboard/documents/${id}`}>{tc('actions.cancel')}</Link>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
