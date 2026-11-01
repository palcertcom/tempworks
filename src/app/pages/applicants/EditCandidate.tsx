import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { applicantsApi, settingsApi, agenciesApi, documentsApi } from '../../services/api';
import { apiError, fieldErrors as resolveFieldErrors, isValidationError } from '../../../i18n/apiError';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { ArrowLeft, ChevronRight, ChevronLeft, Save, ShieldOff } from 'lucide-react';
import { SuperUserTenantField, isSuperUser } from '../../components/ui/super-user-tenant-field';
import { toast } from 'sonner';
import { usePermissions } from '../../hooks/usePermissions';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');
import { ApplicantFormSteps, EMPTY_FORM, getVisibleTabs, StepIndicator, FormSettings, DEFAULT_FORM_SETTINGS, ApplicantFormData } from '../../components/applicants/ApplicantFormSteps';
import { joinPhone } from '../../data/phoneCodes';

export function EditCandidate() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const { id } = useParams();
  const { canEdit } = usePermissions();
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [formData, setFormData] = useState<ApplicantFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [jobTypes, setJobTypes] = useState<any[]>([]);
  const [settings, setSettings] = useState<FormSettings>(DEFAULT_FORM_SETTINGS);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [existingPhotoUrl, setExistingPhotoUrl] = useState<string | undefined>();
  const [agencies, setAgencies] = useState<any[]>([]);
  const [agencyId, setAgencyId] = useState<string>('');
  const [tenantId, setTenantId] = useState<string>('');
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});

  const visibleTabs = useMemo(() => getVisibleTabs(formData), [formData.hasDrivingLicense]);

  useEffect(() => {
    Promise.all([
      settingsApi.getJobTypes().then(setJobTypes).catch(() => {}),
      settingsApi.getAll().then((res: any) => {
        const arr: any[] = Array.isArray(res.form) ? res.form : [];
        if (arr.length > 0) {
          const formSettings = arr.reduce((acc: any, item: any) => {
            const key = String(item.key).replace(/^form\./, '');
            try { acc[key] = JSON.parse(item.value); } catch { acc[key] = item.value; }
            return acc;
          }, {});
          setSettings((prev: any) => ({ ...prev, ...formSettings }));
        }
      }).catch(() => {}),
      agenciesApi.list({ limit: 100 }).then((res: any) => setAgencies(res?.data ?? [])).catch(() => {}),
    ]);
  }, []);

  useEffect(() => {
    if (!id) return;
    applicantsApi.get(id).then((applicant) => {
      const appData = applicant.applicationData || EMPTY_FORM;
      setFormData(appData);
      setAgencyId(applicant.agencyId || '');
      setTenantId(applicant.tenantId || '');
      if (applicant.photoUrl) setExistingPhotoUrl(applicant.photoUrl.startsWith('http') ? applicant.photoUrl : `${API_BASE}${applicant.photoUrl}`);
    }).catch(() => {
      toast.error(t('applicants.toast.loadFailed'));
    }).finally(() => setLoading(false));
  }, [id]);

  const handleUpdate = (updater: (prev: ApplicantFormData) => ApplicantFormData) => {
    setFormData(updater);
  };

  const handleNext = () => {
    if (currentStep < visibleTabs.length) {
      setCurrentStep(s => s + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(s => s - 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const buildPayload = () => ({
    firstName: formData.firstName,
    middleName: formData.middleName,
    lastName: formData.lastName,
    email: formData.email,
    phone: joinPhone(formData.phoneCode, formData.phone),
    citizenship: formData.citizenship,
    gender: formData.gender,
    dateOfBirth: formData.dateOfBirth,
    countryOfBirth: formData.countryOfBirth,
    cityOfBirth: formData.cityOfBirth,
    hasDrivingLicense: formData.hasDrivingLicense === 'yes',
    preferredStartDate: formData.preferredStartDate || undefined,
    availability: formData.availability || 'Immediate',
    willingToRelocate: formData.willingToRelocate,
    jobTypeId: formData.jobTypeId || undefined,
    agencyId: agencyId && agencyId !== 'none' ? agencyId : null,
    applicationData: formData,
    // SUPER USER only — backend ignores/strips for everyone else.
    ...(isSuperUser() ? { tenantId } : {}),
  });

  const uploadPhotoIfNeeded = async () => {
    if (!photoFile || !id) return;
    try {
      const updated = await applicantsApi.uploadPhoto(id, photoFile);
      const resolvedUrl = updated.photoUrl?.startsWith('http')
        ? updated.photoUrl
        : `${API_BASE}${updated.photoUrl}`;
      setExistingPhotoUrl(resolvedUrl);
      setPhotoFile(null);
    } catch (photoErr: any) {
      toast.error(t('applicants.toast.savedButPhotoFailed', { error: photoErr?.message ?? tc('toast.errorGeneric') }));
      throw photoErr;
    }
  };

  /**
   * Mirror of EditApplicant.uploadAttachedDocumentsIfNeeded — persists
   * any newly attached Document Uploads on Save. Items whose Document
   * Type cannot be resolved against the settings catalogue are skipped
   * with a toast so the rest of the save still completes.
   */
  const uploadAttachedDocumentsIfNeeded = async () => {
    if (!id) return;
    const pending = uploadedFiles.filter((f: any) => f && f.file);
    if (pending.length === 0) return;
    let docTypes: any[] = [];
    try { docTypes = await settingsApi.getDocumentTypes(); } catch { docTypes = []; }
    const skipped: string[] = [];
    let uploaded = 0;
    for (const item of pending) {
      const wantedName: string = (item.type || '').trim();
      const docType = docTypes.find((d: any) =>
        d.name?.toLowerCase() === wantedName.toLowerCase()
        || d.name?.toLowerCase().includes(wantedName.toLowerCase())
      );
      if (!docType?.id) { skipped.push(item.file.name); continue; }
      const fd = new FormData();
      fd.append('file', item.file);
      fd.append('name', wantedName || item.file.name);
      fd.append('documentTypeId', docType.id);
      fd.append('entityType', 'APPLICANT');
      fd.append('entityId', id);
      try {
        await documentsApi.upload(fd);
        uploaded++;
      } catch {
        skipped.push(item.file.name);
      }
    }
    if (uploaded > 0) {
      setUploadedFiles((prev: any[]) =>
        prev.map((f) => (f.file ? { ...f, file: null, savedName: f.file.name } : f)),
      );
      toast.success(t('applicants.toast.documentsUploaded', { count: uploaded, defaultValue: `${uploaded} document(s) uploaded` }));
    }
    if (skipped.length) {
      toast.warning(t('applicants.toast.documentsSkipped', {
        defaultValue: `${skipped.length} document(s) skipped — pick a Document Type for each upload.`,
      }));
    }
  };

  const handleSave = async () => {
    if (!id) return;
    setSubmitting(true);
    try {
      await applicantsApi.update(id, buildPayload());
      await uploadPhotoIfNeeded();
      await uploadAttachedDocumentsIfNeeded();
      toast.success(tc('toast.savedSuccessfully'));
    } catch (err: any) {
      if (!err?.message?.includes('photo upload failed')) {
        if (isValidationError(err)) setFieldErrs(resolveFieldErrors(err));
        toast.error(apiError(err, tc('toast.saveFailed')));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!id) return;
    setSubmitting(true);
    try {
      await applicantsApi.update(id, buildPayload());
      await uploadPhotoIfNeeded();
      await uploadAttachedDocumentsIfNeeded();
      toast.success(tc('toast.savedSuccessfully'));
      navigate(`/dashboard/candidates/${id}`);
    } catch (err: any) {
      if (!err?.message?.includes('photo upload failed')) {
        if (isValidationError(err)) setFieldErrs(resolveFieldErrors(err));
        toast.error(apiError(err, tc('toast.saveFailed')));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">{tc('states.loading')}</div>;
  }

  if (!canEdit('applicants')) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
        <ShieldOff className="w-12 h-12 opacity-30" />
        <p className="text-lg font-semibold">{tc('permissions.accessDenied')}</p>
        <p className="text-sm">{tc('permissions.noPermission')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/candidates/${id}`}>
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold">{t('applicants.edit.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('applicants.editPage.candidateSubtitle', { id })}</p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 pb-6">
          <div className="max-w-sm">
            <div className="mb-4">
              <SuperUserTenantField
                value={tenantId}
                onChange={(v) => {
                  setTenantId(v);
                  const a = agencies.find((x) => x.id === agencyId);
                  if (v && a?.tenantId && a.tenantId !== v) setAgencyId('');
                }}
              />
            </div>
            <Label htmlFor="agencyId" className="mb-2 block">{t('applicants.addPage.agencyLabel')} <span className="text-muted-foreground font-normal">{t('applicants.addPage.agencyOptional')}</span></Label>
            <Select value={agencyId || 'none'} onValueChange={(v) => setAgencyId(v === 'none' ? '' : v)}>
              <SelectTrigger id="agencyId">
                <SelectValue placeholder={t('applicants.addPage.selectAgencyPh')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('applicants.addPage.noAgency')}</SelectItem>
                {agencies
                  .filter((a) => !isSuperUser() || !tenantId || a.tenantId === tenantId || !a.tenantId)
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}{!a.tenantId ? ' — (no tenant)' : ''}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <StepIndicator currentStep={currentStep} visibleTabs={visibleTabs} onStepClick={(step) => { setCurrentStep(step); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-8">
          <ApplicantFormSteps
            currentStep={currentStep}
            visibleTabs={visibleTabs}
            formData={formData}
            onChange={handleUpdate}
            jobTypes={jobTypes}
            uploadedFiles={uploadedFiles}
            onFilesChange={setUploadedFiles}
            settings={settings}
            photoFile={photoFile}
            onPhotoChange={setPhotoFile}
            existingPhotoUrl={existingPhotoUrl}
            fieldErrors={fieldErrs}
          />

          <div className="flex justify-between pt-8 border-t mt-8">
            {currentStep > 1 && (
              <Button variant="outline" onClick={handleBack} className="gap-2">
                <ChevronLeft className="w-4 h-4" />
                Back
              </Button>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleSave}
                disabled={submitting}
                className="gap-2"
              >
                <Save className="w-4 h-4" />
                {submitting ? 'Saving...' : 'Save'}
              </Button>
              {currentStep < visibleTabs.length ? (
                <Button onClick={handleNext} className="gap-2 bg-blue-600 hover:bg-blue-700">
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Button>
              ) : (
                <Button onClick={handleSubmit} disabled={submitting} className="gap-2 bg-green-600 hover:bg-green-700">
                  <Save className="w-4 h-4" />
                  {submitting ? 'Saving...' : 'Save & Close'}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
