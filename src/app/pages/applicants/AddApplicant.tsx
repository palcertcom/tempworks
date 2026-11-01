import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { applicationDraftsApi, settingsApi, agenciesApi, getCurrentUser, resolveAssetUrl } from '../../services/api';
import { SuperUserTenantField, isSuperUser } from '../../components/ui/super-user-tenant-field';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { ArrowLeft, ChevronRight, ChevronLeft, UserPlus, ShieldOff, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { apiError, fieldErrors as resolveFieldErrors, isValidationError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { ApplicantFormSteps, EMPTY_FORM, getVisibleTabs, getStepErrors, getStepFieldErrors, StepIndicator, FormSettings, DEFAULT_FORM_SETTINGS, ApplicantFormData } from '../../components/applicants/ApplicantFormSteps';
import { joinPhone } from '../../data/phoneCodes';

export function AddApplicant() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<ApplicantFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [jobTypes, setJobTypes] = useState<any[]>([]);
  const [settings, setSettings] = useState<FormSettings>(DEFAULT_FORM_SETTINGS);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [agencies, setAgencies] = useState<any[]>([]);
  const [agencyId, setAgencyId] = useState<string>('');
  // Phase 1B (#11 #23) — SUPER USER tenant default + agency filter.
  const _addApplicantInitialTenantId =
    (getCurrentUser() as any)?.activeTenantId
    ?? (getCurrentUser() as any)?.primaryTenantId
    ?? (getCurrentUser()?.memberships?.[0]?.tenantId)
    ?? '';
  const [tenantId, setTenantId] = useState<string>(_addApplicantInitialTenantId);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Set once a saved draft has been hydrated so we can show the
  // "Resumed draft" affordance + a Discard button. Null means either
  // no draft existed on load or it has been submitted/discarded.
  const [draftId, setDraftId] = useState<string | null>(null);
  // Photo URL persisted on the draft (served from the backend). The
  // preview falls back to this when `photoFile` is null.
  const [draftPhotoUrl, setDraftPhotoUrl] = useState<string | null>(null);

  // Tracks the previous uploadedFiles array so we can diff on each
  // change and push new picks / deletes to the draft endpoints.
  const prevFilesRef = useRef<any[]>([]);

  // System users creating an applicant from the dashboard skip the
  // final Review + Declaration page — it exists for the self-service
  // /apply flow where the applicant has to agree to data processing.
  const visibleTabs = useMemo(() => getVisibleTabs(formData, true), [formData.hasDrivingLicense]);

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
      // Hydrate an existing draft if the caller has one open. No
      // Applicant row has been created yet; this is the user's
      // own saved progress from a previous session.
      applicationDraftsApi.getMine()
        .then((draft: any) => {
          if (!draft) return;
          setDraftId(draft.id);
          const saved = (draft.formData ?? {}) as Partial<ApplicantFormData>;
          setFormData(prev => ({ ...prev, ...saved }));

          // Photo — preview served from the backend static-files route.
          if (draft.photoUrl) {
            setDraftPhotoUrl(resolveAssetUrl(draft.photoUrl));
          }

          // Supporting documents — re-slot them into the form by their
          // sectionKey so the upload row shows a "saved" state.
          const docs: any[] = Array.isArray(draft.documents) ? draft.documents : [];
          if (docs.length > 0) {
            const restored = docs.map(d => ({
              id: d.id,
              type: d.typeName || d.name,
              sectionKey: d.sectionKey,
              file: null,
              url: resolveAssetUrl(d.url ?? ''),
              savedName: d.name,
              draftDocId: d.id,
            }));
            setUploadedFiles(restored);
            prevFilesRef.current = restored;
          }

          toast.info(t('applicants.toast.draftResumed'));
        })
        .catch(() => { /* no draft, quiet fall-through */ }),
    ]);
  }, []);

  const handleUpdate = (updater: (prev: ApplicantFormData) => ApplicantFormData) => {
    setFormData(updater);
  };

  // Photo picker — uploads immediately to the draft so the file
  // survives a page refresh. Passing null removes the photo.
  const handlePhotoChange = (file: File | null) => {
    setPhotoFile(file);
    if (file) {
      applicationDraftsApi.uploadPhoto(file)
        .then((d: any) => {
          if (d?.id) setDraftId(d.id);
          if (d?.photoUrl) {
            setDraftPhotoUrl(resolveAssetUrl(d.photoUrl));
          }
        })
        .catch(() => toast.error(t('applicants.toast.photoUploadFailedDraft')));
    } else if (draftPhotoUrl) {
      setDraftPhotoUrl(null);
      applicationDraftsApi.deletePhoto().catch(() => {});
    }
  };

  // Document list — diff against the previous state. Any entry that
  // gained a `file` is a fresh pick → push to server. Any entry that
  // lost its draft-persisted file (no file object, no url anymore) is
  // a removal → delete from server. Updates are applied back into
  // state so the row shows its `savedName` + `draftDocId`.
  const handleFilesChange = (next: any[]) => {
    setUploadedFiles(next);
    const prev = prevFilesRef.current;
    prevFilesRef.current = next;

    // 1. Fresh file picks
    for (const item of next) {
      if (!item.file) continue;
      const before = prev.find((p: any) => p.sectionKey === item.sectionKey);
      if (before?.file === item.file) continue; // unchanged
      // upload and update the list in place with server metadata
      applicationDraftsApi.uploadDocument(item.file, item.type, item.type, item.sectionKey || '')
        .then((draft: any) => {
          if (draft?.id) setDraftId(draft.id);
          const entry = (draft?.documents ?? []).find((d: any) => d.sectionKey === item.sectionKey);
          if (!entry) return;
          setUploadedFiles(cur => cur.map(f =>
            f.sectionKey === item.sectionKey
              ? {
                  ...f,
                  file: null,
                  url: resolveAssetUrl(entry.url),
                  savedName: entry.name,
                  draftDocId: entry.id,
                }
              : f,
          ));
          prevFilesRef.current = prevFilesRef.current.map((f: any) =>
            f.sectionKey === item.sectionKey
              ? { ...f, file: null, draftDocId: entry.id, url: entry.url, savedName: entry.name }
              : f,
          );
        })
        .catch(() => toast.error(t('applicants.toast.documentUploadFailedDraft')));
    }

    // 2. Removals — items that were in `prev` with a draftDocId but
    //    are either gone from `next` or now have no file AND no url.
    for (const before of prev) {
      if (!before.draftDocId) continue;
      const after = next.find((n: any) => n.sectionKey === before.sectionKey);
      const stillSaved = !!after && (after.file || after.url || after.draftDocId);
      if (!stillSaved) {
        applicationDraftsApi.deleteDocument(before.draftDocId).catch(() => {});
      }
    }
  };

  const handleNext = () => {
    if (currentStep < visibleTabs.length) {
      const actualTab = visibleTabs[currentStep - 1];
      const errors = getStepErrors(actualTab, formData, uploadedFiles, photoFile);
      const fErrs  = getStepFieldErrors(actualTab, formData);
      setFieldErrors(fErrs);
      if (errors.length > 0) {
        errors.forEach(msg => toast.error(msg));
        return;
      }
      setFieldErrors({});
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

  // Build the Applicant create payload from the current form state.
  // Shared between "Save for Later" (partial OK) and "Submit" (final).
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
    ...(agencyId && agencyId !== 'none' ? { agencyId } : {}),
    // Phase 1B (#23) — backend ignores tenantId for non-SUPER callers.
    ...(isSuperUser() && tenantId ? { tenantId } : {}),
    applicationData: formData,
  });

  // Save for Later — persists the raw formData. No Applicant is
  // created. Draft is user-scoped, at most one open per user.
  const handleSaveDraft = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      const saved = await applicationDraftsApi.saveMine({ formData });
      setDraftId(saved.id);
      toast.success(t('applicants.toast.draftSaved'));
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save draft');
    } finally {
      setSavingDraft(false);
    }
  };

  // Discard the saved draft and reset the form. Lets the user start a
  // fresh application when they change their mind about the one in
  // progress.
  const handleDiscardDraft = async () => {
    const ok = await confirm({
      title: t('applicants.addPage.discardTitle'),
      description: t('applicants.addPage.discardBody'),
      confirmText: t('applicants.addPage.discardConfirm'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await applicationDraftsApi.deleteMine();
      setFormData(EMPTY_FORM);
      setAgencyId('');
      setUploadedFiles([]);
      setPhotoFile(null);
      setCurrentStep(1);
      setDraftId(null);
      toast.success(t('applicants.addPage.discardSuccess'));
    } catch (err: any) {
      toast.error(err?.message || 'Failed to discard draft');
    }
  };

  // Final submit — creates the Applicant and deletes the draft in
  // one backend call (POST /application-drafts/mine/submit). The
  // "submitting" gate guards against double-click.
  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await applicationDraftsApi.submitMine(buildPayload());
      setDraftId(null);
      setFieldErrors({});
      toast.success(tc('toast.savedSuccessfully'));
      // Agency submissions land on the Candidates queue (pending
      // Tempworks approval). Tempworks-staff submissions stay on
      // the Applicants (Leads) list.
      const role = getCurrentUser()?.role;
      const isAgency = role === 'Agency User' || role === 'Agency Manager';
      navigate(isAgency ? '/dashboard/candidates' : '/dashboard/applicants');
    } catch (err: any) {
      // Backend validation errors → replace inline field map so step
      // components highlight the offending inputs. Otherwise keep the
      // existing toast-style error rendering.
      if (isValidationError(err)) {
        setFieldErrors(resolveFieldErrors(err));
      }
      toast.error(apiError(err, 'Failed to create applicant'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate('applicants')) {
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
          <Link to="/dashboard/applicants">
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold">{t('applicants.add.title')}</h1>
          <p className="text-muted-foreground mt-1">
            {draftId
              ? t('applicants.addPage.draftSubtitle')
              : t('applicants.addPage.formSubtitle')}
          </p>
        </div>
        {draftId && (
          <Button variant="outline" size="sm" onClick={handleDiscardDraft} className="gap-2 text-red-600 hover:text-red-700">
            <Trash2 className="w-4 h-4" />
            {t('applicants.addPage.discardButton')}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6 pb-6">
          <div className="max-w-sm">
            <Label htmlFor="agencyId" className="mb-2 block">{t('applicants.addPage.agencyLabel')} <span className="text-muted-foreground font-normal">{t('applicants.addPage.agencyOptional')}</span></Label>
            <Select value={agencyId} onValueChange={setAgencyId}>
              <SelectTrigger id="agencyId">
                <SelectValue placeholder={t('applicants.addPage.selectAgencyPh')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('applicants.addPage.noAgency')}</SelectItem>
                {agencies
                  .filter((a) => isSuperUser() ? (!!tenantId && a.tenantId === tenantId) : true)
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <div className="mt-4">
              <SuperUserTenantField
                value={tenantId}
                onChange={(v) => {
                  setTenantId(v);
                  // Drop an agency that doesn't belong to the new tenant.
                  const a = agencies.find((x) => x.id === agencyId);
                  if (v && a?.tenantId && a.tenantId !== v) setAgencyId('');
                }}
              />
            </div>
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
            onFilesChange={handleFilesChange}
            settings={settings}
            photoFile={photoFile}
            onPhotoChange={handlePhotoChange}
            existingPhotoUrl={draftPhotoUrl ?? undefined}
            fieldErrors={fieldErrors}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 pt-8 border-t mt-8">
            {currentStep > 1 ? (
              <Button variant="outline" onClick={handleBack} className="gap-2">
                <ChevronLeft className="w-4 h-4" />
                Back
              </Button>
            ) : <div />}

            <div className="flex flex-wrap items-center gap-2 ms-auto">
              {/* Save for Later — partial persistence, no Applicant
                  row. Available at every step (including step 1). */}
              <Button
                variant="outline"
                onClick={handleSaveDraft}
                disabled={savingDraft || submitting}
                className="gap-2"
                title="Save your progress; no applicant is created until you submit."
              >
                <Save className="w-4 h-4" />
                {savingDraft ? 'Saving…' : 'Save for Later'}
              </Button>

              {currentStep < visibleTabs.length ? (
                <Button onClick={handleNext} className="gap-2 bg-blue-600 hover:bg-blue-700">
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Button>
              ) : (
                <Button onClick={handleSubmit} disabled={submitting || savingDraft} className="gap-2 bg-green-600 hover:bg-green-700">
                  <UserPlus className="w-4 h-4" />
                  {submitting ? 'Creating…' : 'Create Applicant'}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
