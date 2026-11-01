import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Briefcase, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { toast } from 'sonner';
import { publicApplicationApi, publicJobAdsApi, resolveAssetUrl } from '../../services/api';
import { useBranding } from '../../hooks/useBranding';
import { ApplicantFormSteps, EMPTY_FORM, getVisibleTabs, getStepErrors, getStepFieldErrors, StepIndicator, FormSettings, DEFAULT_FORM_SETTINGS, ApplicantFormData } from '../../components/applicants/ApplicantFormSteps';
import { ReCaptchaV2 } from '../../components/ui/ReCaptchaV2';
import { LanguageSwitcher } from '../../../i18n/LanguageSwitcher';
import { apiError } from '../../../i18n/apiError';
import { joinPhone } from '../../data/phoneCodes';

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string;

export function PublicEmployeeApplication() {
  const branding = useBranding();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('public');
  const [searchParams] = useSearchParams();
  const jobAdId = searchParams.get('jobAdId') || undefined;
  const jobSlug = searchParams.get('jobSlug') || undefined;
  const jobCategory = searchParams.get('jobCategory') || undefined;
  const jobAdTitle = searchParams.get('jobTitle') || undefined;
  const [requiredDocs, setRequiredDocs] = useState<string[]>(() => {
    try { return JSON.parse(searchParams.get('requiredDocs') || '[]'); } catch { return []; }
  });
  const [currentStep, setCurrentStep] = useState(1);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formData, setFormData] = useState<ApplicantFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [jobTypes, setJobTypes] = useState<{ id: string; name: string }[]>([]);
  const [settings, setSettings] = useState<FormSettings>(DEFAULT_FORM_SETTINGS);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>(() => {
    try {
      const docs: string[] = JSON.parse(searchParams.get('requiredDocs') || '[]');
      return docs.map((name: string) => ({
        id: crypto.randomUUID(),
        type: name,
        file: null,
        sectionKey: `required:${name}`,
      }));
    } catch { return []; }
  });
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  const visibleTabs = useMemo(() => getVisibleTabs(formData), [formData.hasDrivingLicense]);

  // Re-fetch job categories when the UI language changes so the backend can
  // return localized `name`/`description` for the active locale (Accept-Language
  // is forwarded by `apiFetch`). The `jobCategory` URL-param match still
  // operates on the canonical English name returned alongside any localization.
  useEffect(() => {
    publicApplicationApi.getJobCategories().then((types) => {
      setJobTypes(types);
      if (jobCategory) {
        const match = types.find((t) => t.name === jobCategory);
        if (match) setFormData(prev => ({ ...prev, jobTypeId: match.id }));
      }
    });
  }, [i18n.language, jobCategory]);

  useEffect(() => {
    publicApplicationApi.getFormSettings().then((raw: any) => {
      if (!raw || typeof raw !== 'object') return;
      const parsed: Record<string, any> = {};
      for (const [k, v] of Object.entries(raw)) {
        parsed[k.replace(/^form\./, '')] = v;
      }
      setSettings(prev => ({ ...prev, ...parsed }));
    }).catch(() => {});
  }, []);

  // Fetch authoritative required documents from the job ad API.
  // The URL param is only an initial hint for instant rendering; the API response is
  // the single source of truth and always overrides — including an empty list, so that
  // removing a required document from the job ad is reflected immediately for the applicant.
  useEffect(() => {
    if (!jobSlug) return;
    publicJobAdsApi.getBySlug(jobSlug)
      .then((job: any) => {
        if (Array.isArray(job.requiredDocuments)) {
          setRequiredDocs(job.requiredDocuments);
        }
      })
      .catch(() => {}); // On network failure keep the URL-param value as fallback
  }, [jobSlug]);

  // Sync the required-document slots in uploadedFiles whenever requiredDocs changes
  useEffect(() => {
    setUploadedFiles(prev => {
      const nonRequired = prev.filter((f: any) => !f.sectionKey?.startsWith('required:'));
      const newRequired = requiredDocs.map((name: string) => {
        const existing = prev.find((f: any) => f.sectionKey === `required:${name}`);
        return existing ?? { id: crypto.randomUUID(), type: name, file: null, sectionKey: `required:${name}` };
      });
      return [...newRequired, ...nonRequired];
    });
  }, [requiredDocs]);

  const handleUpdate = (updater: (prev: ApplicantFormData) => ApplicantFormData) => {
    setFormData(updater);
  };

  const handleNext = () => {
    if (currentStep < visibleTabs.length) {
      const actualTab = visibleTabs[currentStep - 1];
      const errors = getStepErrors(actualTab, formData, uploadedFiles, photoFile, requiredDocs);
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
      if (currentStep === visibleTabs.length) setCaptchaToken(null);
      setCurrentStep(s => s - 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleSubmit = useCallback(async () => {
    if (!photoFile) {
      toast.error(t('apply.errors.photoRequired'));
      return;
    }
    if (!formData.declarationAccepted || !formData.agreeDataProcessing || !formData.agreeBackground || !formData.agreeDataSharing) {
      toast.error(t('apply.errors.agreementsRequired'));
      return;
    }
    if (!captchaToken) {
      toast.error(t('apply.errors.captchaRequired'));
      return;
    }

    if (requiredDocs.length > 0) {
      const missing = requiredDocs.filter((name: string) =>
        !uploadedFiles.some((f: any) => f.sectionKey === `required:${name}` && f.file)
      );
      if (missing.length > 0) {
        toast.error(t('apply.errors.missingDocs', { docs: missing.join(', ') }));
        return;
      }
    }

    setSubmitting(true);
    try {
      const payload = {
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
        preferredLocations: formData.preferredLocations || undefined,
        salaryExpectation: formData.salaryExpectation || undefined,
        jobTypeId: formData.jobTypeId || undefined,
        jobAdId: jobAdId || undefined,
        applicationData: formData,
        recaptchaToken: captchaToken,
      };

      const applicant = await publicApplicationApi.submit(payload);

      if (photoFile && applicant?.id) {
        await publicApplicationApi.uploadDocument(applicant.id, photoFile, 'Profile Photo', 'Profile Photo').catch(() => {
          toast.warning(t('apply.errors.photoUploadFailed'));
        });
      }

      const fileItems = uploadedFiles.filter((f: any) => f.file);
      if (fileItems.length > 0 && applicant?.id) {
        const results = await Promise.allSettled(
          fileItems.map((item: any) => {
            const rawType: string = item.type || item.file!.name;
            const docTypeName = rawType.replace(/^Upload\s+/i, '').trim() || 'Other';
            return publicApplicationApi.uploadDocument(applicant.id, item.file!, rawType, docTypeName, item.sectionKey);
          }),
        );
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
          toast.warning(t('apply.errors.documentsUploadFailed', { count: failed }));
        }
      }

      navigate('/application-success');
    } catch (err: any) {
      toast.error(apiError(err, t('apply.errors.submitFailed')));
    } finally {
      setSubmitting(false);
    }
  }, [formData, photoFile, captchaToken, uploadedFiles, jobAdId, navigate, requiredDocs, t]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b shadow-sm">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center overflow-hidden">
              {branding.logoUrl ? (
                <img src={resolveAssetUrl(branding.logoUrl)} alt="Logo" className="w-full h-full object-cover" />
              ) : (
                <Briefcase className="w-5 h-5 text-white" />
              )}
            </div>
            <div>
              <p className="font-bold text-gray-900 leading-tight">{branding.companyName}</p>
              <p className="text-xs text-gray-500">{t('apply.headerTitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Link to="/" className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900">
              <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
              {t('apply.backToHome')}
            </Link>
          </div>
        </div>
      </header>

      {jobAdId && (
        <div className="bg-blue-50 border-b border-blue-100">
          <div className="max-w-5xl mx-auto px-6 py-3 flex items-center gap-2 text-sm text-blue-700">
            <Briefcase className="w-4 h-4 flex-shrink-0" />
            <span>
              {t('apply.specificPositionPrefix')}{' '}
              <Link to="/jobs" className="underline hover:text-blue-900">{t('apply.browseAllJobs')}</Link>
            </span>
          </div>
        </div>
      )}

      <div className="bg-white border-b">
        <div className="max-w-5xl mx-auto px-6 py-5">
          <StepIndicator currentStep={currentStep} visibleTabs={visibleTabs} onStepClick={(step) => {
            // Only allow navigating back to a completed step — never skip forward past validation
            if (step >= currentStep) return;
            if (step === visibleTabs.length) setCaptchaToken(null);
            setCurrentStep(step);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }} />
        </div>
      </div>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">
        <div className="bg-white rounded-xl shadow-sm border p-8">
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
            jobAdTitle={jobAdTitle}
            requiredDocuments={requiredDocs}
            fieldErrors={fieldErrors}
          />

          {/* reCAPTCHA v2 "I am not a robot" checkbox — last step only */}
          {currentStep === visibleTabs.length && (
            <div className="mt-8">
              <ReCaptchaV2
                siteKey={RECAPTCHA_SITE_KEY}
                onVerify={(token) => setCaptchaToken(token)}
                onExpired={() => setCaptchaToken(null)}
              />
            </div>
          )}

          <div className="flex justify-between pt-8 border-t mt-8">
            {currentStep > 1 ? (
              <button
                type="button"
                onClick={handleBack}
                className="flex items-center gap-2 px-5 py-2.5 border-2 border-gray-300 text-gray-700 rounded-lg font-medium hover:border-gray-400 transition-colors"
              >
                <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
                {t('apply.back')}
              </button>
            ) : <div />}

            {currentStep < visibleTabs.length ? (
              <button
                type="button"
                onClick={handleNext}
                className="ms-auto flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
              >
                {t('apply.next')}
                <ChevronRight className="w-4 h-4 rtl:rotate-180" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !captchaToken}
                className="ms-auto flex items-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={!captchaToken ? t('apply.captchaTitle') : undefined}
              >
                <Check className="w-4 h-4" />
                {submitting ? t('apply.submitting') : t('apply.submit')}
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
