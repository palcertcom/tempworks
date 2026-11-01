import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Upload, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { toast } from 'sonner';
import { documentsApi, employeesApi, settingsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { DateInput } from '../../components/ui/date-input';
import { Checkbox } from '../../components/ui/checkbox';
import { getRequiredDocumentMetadataFields } from '../../utils/documentMetadataRules';

export function DocumentUpload() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const [employees, setEmployees] = useState<any[]>([]);
  const [docTypes, setDocTypes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    entityId: '',
    documentTypeId: '',
    name: '',
    expiryDate: '',
    issueDate: '',
    documentNumber: '',
    issuer: '',
    notes: '',
  });
  const [file, setFile] = useState<File | null>(null);
  // "Open-ended" toggle for documents that don't have an end date
  // (work contracts, indefinite agreements, …). When ticked we clear
  // and disable the expiry field and skip it on submit. Required-expiry
  // doc types (Visa / Passport / Work Permit) still demand a date — the
  // checkbox is hidden there.
  const [noExpiry, setNoExpiry] = useState(false);
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors } = useValidationErrors();
  // Client-side metadata errors (e.g. Passport missing dates). The backend
  // re-validates, so this is purely for fast inline feedback.
  const [metaErrs, setMetaErrs] = useState<Record<string, string>>({});

  const selectedType = useMemo(
    () => docTypes.find(dt => dt.id === form.documentTypeId),
    [docTypes, form.documentTypeId],
  );
  const requiredFields = useMemo(() => getRequiredDocumentMetadataFields(selectedType), [selectedType]);
  const shownErrs = { ...metaErrs, ...fieldErrs };

  useEffect(() => {
    Promise.all([
      employeesApi.list({ limit: 500 }),
      settingsApi.getDocumentTypes(),
    ]).then(([empResult, types]) => {
      setEmployees((empResult as any)?.data ?? []);
      setDocTypes(Array.isArray(types) ? types : []);
    }).catch(() => toast.error(t('documents.upload.loadFailed')))
      .finally(() => setLoading(false));
  }, [t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFieldErrors();
    setMetaErrs({});
    if (!file) { toast.error(t('documents.upload.fileRequired')); return; }
    if (!form.entityId) { toast.error(t('documents.upload.employeeRequired')); return; }
    if (!form.documentTypeId) { toast.error(t('documents.upload.docTypeRequired')); return; }
    if (!form.name.trim()) { toast.error(t('documents.upload.nameRequired')); return; }

    // Per-type required metadata (Passport → issue + expiry date, etc.).
    const docTypeName = selectedType?.name ?? '';
    const me: Record<string, string> = {};
    if (requiredFields.includes('issueDate') && !form.issueDate)
      me.issueDate = t('validation.ISSUE_DATE_REQUIRED', { ns: 'errors', docType: docTypeName, defaultValue: 'Issue date is required.' });
    // The "no expiry" checkbox satisfies the expiry-required rule only
    // for non-canonical (operator-configurable) types — Passport / Visa
    // / Work Permit are still mandatorily dated even when the operator
    // would prefer otherwise.
    if (requiredFields.includes('expiryDate') && !form.expiryDate && !noExpiry)
      me.expiryDate = t('validation.EXPIRY_DATE_REQUIRED', { ns: 'errors', docType: docTypeName, defaultValue: 'Expiry date is required.' });
    if (requiredFields.includes('documentNumber') && !form.documentNumber.trim())
      me.documentNumber = t('validation.DOCUMENT_NUMBER_REQUIRED', { ns: 'errors', docType: docTypeName, defaultValue: 'Document number is required.' });
    if (Object.keys(me).length) { setMetaErrs(me); toast.error(t('documents.upload.uploadFailed')); return; }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', form.name);
      formData.append('documentTypeId', form.documentTypeId);
      formData.append('entityType', 'EMPLOYEE');
      formData.append('entityId', form.entityId);
      // Open-ended document: explicitly skip expiryDate so the
      // backend stores NULL. If the operator typed something and then
      // ticked the box, we honour the box and ignore the typed value.
      if (!noExpiry && form.expiryDate) formData.append('expiryDate', form.expiryDate);
      if (form.issueDate) formData.append('issueDate', form.issueDate);
      if (form.documentNumber) formData.append('documentNumber', form.documentNumber);
      if (form.issuer) formData.append('issuer', form.issuer);
      if (form.notes) formData.append('notes', form.notes);

      await documentsApi.upload(formData);
      toast.success(t('documents.upload.uploadSuccess'));
      navigate('/dashboard/documents-compliance');
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('documents.upload.uploadFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8 text-muted-foreground">{tc('states.loading')}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/documents-compliance">
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('documents.upload.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('documents.upload.subtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-w-2xl space-y-6">
          <ValidationSummary errors={shownErrs} />
          <Card>
            <CardHeader><CardTitle>{t('documents.upload.infoCardTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">

              <div className="space-y-2">
                <Label htmlFor="employee">{t('documents.upload.selectEmployee')}</Label>
                <Select value={form.entityId} onValueChange={val => setForm(prev => ({ ...prev, entityId: val }))}>
                  <SelectTrigger id="employee">
                    <SelectValue placeholder={t('documents.upload.chooseEmployeePh')} />
                  </SelectTrigger>
                  <SelectContent>
                    {employees.map(emp => (
                      <SelectItem key={emp.id} value={emp.id}>
                        {emp.firstName} {emp.lastName}
                        {emp.employeeNumber && <span className="ms-2 font-mono text-xs text-muted-foreground">{emp.employeeNumber}</span>}
                        {emp.email && <span className="ms-2 text-muted-foreground text-xs">— {emp.email}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="docType">{t('documents.upload.documentType')}</Label>
                <Select value={form.documentTypeId} onValueChange={val => setForm(prev => ({ ...prev, documentTypeId: val }))}>
                  <SelectTrigger id="docType">
                    <SelectValue placeholder={t('documents.upload.selectDocTypePh')} />
                  </SelectTrigger>
                  <SelectContent>
                    {docTypes.map(dt => (
                      <SelectItem key={dt.id} value={dt.id}>{dt.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">{t('documents.upload.documentName')}</Label>
                <Input
                  id="name"
                  placeholder={t('documents.upload.documentNamePh')}
                  value={form.name}
                  onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                  aria-invalid={!!fieldErrs.name}
                  className={fieldErrs.name ? 'border-red-500 focus-visible:ring-red-500' : ''}
                />
                <FieldError errors={fieldErrs} name="name" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="issueDate">
                    {t('documents.upload.issueDate')}
                    {requiredFields.includes('issueDate') && <span className="text-red-500 ms-0.5">*</span>}
                  </Label>
                  <DateInput id="issueDate" value={form.issueDate} onChange={e => { setMetaErrs(p => { const n = { ...p }; delete n.issueDate; return n; }); setForm(prev => ({ ...prev, issueDate: e.target.value })); }} />
                  <FieldError errors={shownErrs} name="issueDate" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="expiryDate">
                    {t('documents.upload.expiryDate')}
                    {requiredFields.includes('expiryDate') && !noExpiry && <span className="text-red-500 ms-0.5">*</span>}
                  </Label>
                  <DateInput
                    id="expiryDate"
                    value={noExpiry ? '' : form.expiryDate}
                    disabled={noExpiry}
                    onChange={e => { setMetaErrs(p => { const n = { ...p }; delete n.expiryDate; return n; }); setForm(prev => ({ ...prev, expiryDate: e.target.value })); }}
                  />
                  {/* "Unexpired" toggle — hidden for types that always
                       require an expiry date (Passport / Visa / Work Permit). */}
                  {!requiredFields.includes('expiryDate') && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
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
                      {t('documents.upload.noExpiry', { defaultValue: 'No expiry date (open-ended)' })}
                    </label>
                  )}
                  <FieldError errors={shownErrs} name="expiryDate" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="documentNumber">
                    {t('documents.upload.documentNumber')}
                    {requiredFields.includes('documentNumber') && <span className="text-red-500 ms-0.5">*</span>}
                  </Label>
                  <Input id="documentNumber" placeholder={t('documents.upload.documentNumberPh')} value={form.documentNumber} onChange={e => { setMetaErrs(p => { const n = { ...p }; delete n.documentNumber; return n; }); setForm(prev => ({ ...prev, documentNumber: e.target.value })); }} />
                  <FieldError errors={shownErrs} name="documentNumber" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="issuer">{t('documents.upload.issuer')}</Label>
                  <Input id="issuer" placeholder={t('documents.upload.issuerPh')} value={form.issuer} onChange={e => setForm(prev => ({ ...prev, issuer: e.target.value }))} />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">{t('documents.upload.notes')}</Label>
                <Input id="notes" placeholder={t('documents.upload.notesPh')} value={form.notes} onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="file">{t('documents.upload.uploadFile')}</Label>
                <div className="border-2 border-dashed rounded-lg p-8 text-center hover:border-[#2563EB] transition-colors">
                  {file ? (
                    <div className="flex items-center justify-center gap-3">
                      <FileText className="w-8 h-8 text-[#2563EB]" />
                      <div className="text-start">
                        <p className="font-medium">{file.name}</p>
                        <p className="text-sm text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <Upload className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                      <p className="text-sm text-muted-foreground mb-2">{t('documents.upload.clickOrDrag')}</p>
                      <p className="text-xs text-muted-foreground">{t('documents.upload.fileTypesHelp')}</p>
                    </>
                  )}
                  <Input
                    id="file"
                    type="file"
                    className="mt-4"
                    accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    onChange={e => setFile(e.target.files?.[0] ?? null)}
                  />
                </div>
              </div>

            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="submit" className="flex-1" disabled={submitting}>
              <Upload className="w-4 h-4 me-2" />
              {submitting ? t('documents.upload.uploading') : t('documents.upload.uploadButton')}
            </Button>
            <Button type="button" variant="outline" className="flex-1" asChild>
              <Link to="/dashboard/documents-compliance">{tc('actions.cancel')}</Link>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
