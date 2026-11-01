import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Mail, Phone, Globe, Briefcase, Calendar, FileText,
  UserPlus, Edit, Trash2, Download, Upload, X, Eye,
  Shield, Clock, Award, ChevronRight, MapPin, Loader2, TrendingUp, History, DollarSign,
  Layers, Plus, CheckCircle2, XCircle, GraduationCap,
} from 'lucide-react';
import { usePermissions } from '../../hooks/usePermissions';
import { getCurrentUser, applicantsApi, documentsApi, settingsApi, employeeWorkflowApi, agenciesApi, workflowApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { enumLabel } from '../../../i18n/enumLabel';
import { formatDate } from '../../../i18n/formatters';
import { FinancialRecordsTab } from '../../components/finance/FinancialRecordsTab';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Checkbox } from '../../components/ui/checkbox';
import { Textarea } from '../../components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { ApplicantPdfExportButton } from '../../components/applicants/ApplicantPdfExport';
import { ApplicationDataView } from '../../components/applicants/ApplicationDataView';
import { WhatsAppButton } from '../../components/WhatsAppButton';
import { DateInput } from '../../components/ui/date-input';
import { formatPhoneDisplay } from '../../data/phoneCodes';
import { getDocumentDisplayName } from '../../utils/documentDisplay';
import { ProfileNotesList } from '../../components/profile-notes/ProfileNotesList';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');

const statusBadgeClass = (status: string) => {
  switch (status?.toUpperCase()) {
    case 'NEW': return 'bg-[#2563EB]';
    case 'SCREENING': return 'bg-[#F59E0B]';
    case 'INTERVIEW': return 'bg-[#8B5CF6]';
    case 'OFFER': return 'bg-[#06B6D4]';
    case 'ACCEPTED': case 'ONBOARDING': return 'bg-[#22C55E]';
    case 'REJECTED': case 'WITHDRAWN': return 'bg-[#EF4444]';
    default: return 'bg-gray-500';
  }
};

const docStatusClass = (status: string) => {
  if (status === 'VERIFIED' || status === 'Verified') return 'bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]';
  if (status === 'EXPIRING_SOON') return 'bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]';
  if (status === 'EXPIRED' || status === 'REJECTED' || status === 'Rejected') return 'bg-[#FEE2E2] text-[#EF4444] border-[#EF4444]';
  return 'bg-[#F8FAFC] text-[#0F172A] border-[#E2E8F0]';
};

export function ApplicantProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete, canView, can } = usePermissions();
  const { t, i18n } = useTranslation(['pages', 'common']);
  const dir = i18n.dir();
  const currentUser = getCurrentUser();
  // Permission-based — `finance:read` is the seeded key for Finance,
  // HR Manager, and any custom role granted finance view.
  const isFinanceOrAdmin = canView('finance');
  const isAgencyUser = currentUser?.role === 'Agency User' || currentUser?.role === 'Agency Manager';
  const [applicantData, setApplicantData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<any[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docTypes, setDocTypes] = useState<any[]>([]);
  const [allStages, setAllStages] = useState<any[]>([]);
  const [changingStage, setChangingStage] = useState(false);
  const [candidateAssignment, setCandidateAssignment] = useState<any>(null);
  const [allWorkflows, setAllWorkflows] = useState<any[]>([]);
  const [showAssignWorkflow, setShowAssignWorkflow] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('overview');
  const scrollToSection = (id: string) => {
    setActiveTab('overview');
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const [assignWorkflowId, setAssignWorkflowId] = useState('');
  const [assigningWorkflow, setAssigningWorkflow] = useState(false);
  const [settingStage, setSettingStage] = useState(false);
  const [expandedStageId, setExpandedStageId] = useState<string | null>(null);
  const [approvingProgressId, setApprovingProgressId] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<any[]>([]);
  const [changingAgency, setChangingAgency] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadForm, setUploadForm] = useState({ documentTypeId: '', name: '', issueDate: '', expiryDate: '', noExpiry: false, documentNumber: '', issuer: '' });
  // Inline document actions — approve / reject / delete live directly
  // on each row in the Documents tab, using the same documentsApi.verify
  // contract as the Doc Compliance page.
  const [verifyingDocId, setVerifyingDocId] = useState<string | null>(null);
  const [rejectDocDialog, setRejectDocDialog] = useState<{ open: boolean; docId: string; docName: string }>({ open: false, docId: '', docName: '' });
  const [rejectDocReason, setRejectDocReason] = useState('');
  // Inline Notes editor — lets operators add/update the applicant
  // note without leaving view mode. Kept separate from the Edit page
  // so the flow stays quick.
  const [showConvertDialog, setShowConvertDialog] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertForm, setConvertForm] = useState({
    addressLine1: '', addressLine2: '', city: '', country: '', postalCode: '',
    licenseNumber: '', licenseCategory: '', yearsExperience: '', emergencyContact: '', emergencyPhone: '',
  });

  // Tier / financial / history state
  const [showConvertLeadDialog, setShowConvertLeadDialog] = useState(false);
  const [convertingLead, setConvertingLead] = useState(false);
  // After a successful promotion we flip the same dialog into a
  // confirmation panel instead of relying on a fleeting toast, so the
  // operator sees an explicit "done" message.
  const [promoteSuccess, setPromoteSuccess] = useState<{ newCandidateNumber?: string } | null>(null);
  // Agency picker in the Promote dialog — defaults to the applicant's
  // existing agency (if any) so the operator just confirms in the
  // common case; the backend falls back to the System Default Holding
  // Agency when neither is provided.
  const [promoteAgencyId, setPromoteAgencyId] = useState<string>('');
  const [financialProfile, setFinancialProfile] = useState<any>(null);
  const [financialLoading, setFinancialLoading] = useState(false);
  const [savingFinancial, setSavingFinancial] = useState(false);
  const [financialForm, setFinancialForm] = useState<any>({});
  const [agencyHistory, setAgencyHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadDocs = () => {
    if (!id) return;
    setDocsLoading(true);
    documentsApi.getByEntity('APPLICANT', id)
      .then((docs: any) => setDocuments(Array.isArray(docs) ? docs : docs?.data ?? []))
      .catch(() => {})
      .finally(() => setDocsLoading(false));
  };

  const loadCandidateWorkflow = () => {
    if (!id) return;
    workflowApi.getCandidateAssignments(id)
      .then(assignments => setCandidateAssignment(assignments?.[0] ?? null))
      .catch(() => {});
  };

  useEffect(() => { loadDocs(); }, [id]);

  useEffect(() => {
    settingsApi.getDocumentTypes().then(setDocTypes).catch(() => {});
    employeeWorkflowApi.getStages().then((stages: any) => setAllStages(Array.isArray(stages) ? stages : [])).catch(() => {});
    agenciesApi.list({ limit: 200 }).then((res: any) => setAgencies(res?.data ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    loadCandidateWorkflow();
    workflowApi.list().then(res => setAllWorkflows(Array.isArray(res) ? res : [])).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id) return;
    applicantsApi.get(id).then((applicant) => {
      let extra: Record<string, any> = {};
      try { extra = JSON.parse(applicant.notes || '{}'); } catch { /* ignore */ }

      // Map fields from applicationData JSON (submitted form) to profile display names
      const ad: Record<string, any> = (applicant as any).applicationData ?? {};
      const quals: any[] = ad.qualifications ?? [];
      const tachographQual = quals.find((q: any) => /tachograph/i.test(q.type ?? ''));
      const code95Qual = quals.find((q: any) => /code.?95|cpc/i.test(q.type ?? ''));
      const adrQual = quals.find((q: any) => /adr/i.test(q.type ?? ''));
      const langs: any[] = ad.languages ?? [];
      const findLang = (name: string) => langs.find((l: any) => l.language?.toLowerCase() === name.toLowerCase())?.proficiency ?? '';
      const otherLangs = langs.filter((l: any) => !['english','german','russian'].includes(l.language?.toLowerCase())).map((l: any) => `${l.language} (${l.proficiency})`).join(', ');
      const cats: string[] = ad.licenseCategories ?? [];

      const appDataMapped: Record<string, any> = {
        // Travel & Residence
        passportNumber: ad.passportNumber,
        passportValidUntil: ad.passportExpiryDate,
        hasEUVisa: ad.hasEuVisa === 'yes',
        hasWorkPermit: ad.hasWorkPermit === 'yes',
        hasResidenceCard: ad.hasEuResidence === 'yes',
        issuingCountry: ad.passportCountry,
        // EU Visa details (shown when hasEUVisa = true)
        euVisaType: ad.euVisaType,
        euVisaCountry: ad.euVisaCountry,
        euVisaNumber: ad.euVisaNumber,
        euVisaExpiryDate: ad.euVisaNoExpiry ? 'No Expiry' : ad.euVisaExpiryDate,
        // EU Residence details (shown when hasResidenceCard = true)
        euResidenceType: ad.euResidenceType,
        euResidenceNumber: ad.euResidenceNumber,
        euResidenceCountry: ad.euResidenceCountry,
        euResidenceCity: ad.euResidenceCity,
        euResidenceIssueDate: ad.euResidenceIssueDate,
        euResidenceExpiryDate: ad.euResidenceNoExpiry ? 'No Expiry' : ad.euResidenceExpiryDate,
        // Work Permit details (shown when hasWorkPermit = true)
        workPermitType: ad.workPermitType,
        workPermitNumber: ad.workPermitNumber,
        workPermitCountry: ad.workPermitCountry,
        workPermitIssueDate: ad.workPermitIssueDate,
        workPermitExpiryDate: ad.workPermitNoExpiry ? 'No Expiry' : ad.workPermitExpiryDate,
        // Driving
        drivingLicenseNumber: ad.licenseNumber,
        licenseIssuingCountry: ad.licenseCountry,
        licenseValidUntil: ad.licenseExpiryDate,
        categoryA: cats.includes('A') ? 'A' : '',
        categoryB: cats.includes('B') ? 'B' : '',
        categoryC: cats.some((c: string) => /^C/i.test(c)) ? 'C' : '',
        categoryE: cats.some((c: string) => /E/i.test(c)) ? 'E' : '',
        hasTachographCard: !!tachographQual,
        tachographNumber: tachographQual?.number ?? '',
        hasQualificationCard: !!code95Qual,
        qualificationValidUntil: code95Qual?.expiryDate ?? '',
        hasADR: !!adrQual,
        adrClasses: adrQual?.type ?? '',
        // International Experience
        hasEUExperience: ['eu','both'].includes(ad.drivingExpType ?? '') || Number(ad.euExpYears) > 0,
        yearsEUExperience: ad.euExpYears,
        totalCEExperience: ad.euExpKm ? `${ad.euExpKm} km` : ad.domesticExpYears ? `${ad.domesticExpYears} yrs domestic` : '',
        yearsActiveDriving: ad.domesticExpYears,
        drivenOtherCountries: !!(ad.euExpCountries),
        specifyCountries: ad.euExpCountries,
        // Languages
        englishLevel: findLang('english'),
        germanLevel: findLang('german'),
        russianLevel: findLang('russian'),
        otherLanguages: otherLangs,
        languageAtWork: langs.find((l: any) => l.proficiency === 'Native' || l.proficiency === 'Fluent')?.language ?? '',
        // Work Flexibility
        doubleCrewWillingness: (ad.workRegime ?? []).includes('Double Crew'),
        maxTourWeeks: '',
        weekendDriving: ad.weekendDriving,
        nightDriving: ad.nightDriving,
        preferredCountries: ad.preferredLocations,
        undesiredCountries: '',
        // Personal / Address
        permanentAddress: ad.homeAddress
          ? [ad.homeAddress.street, ad.homeAddress.city, ad.homeAddress.country].filter(Boolean).join(', ')
          : '',
        countryOfResidence: ad.homeAddress?.country ?? ad.currentAddress?.country ?? '',
        currentCountryOfResidence: ad.currentAddress?.country ?? ad.homeAddress?.country ?? '',
        howDidYouHear: ad.howDidYouHear,
        // Family / emergency contact — shown in the header contact card
        // so the user never has to dig into the applicationData blob.
        emergencyFullName: [ad.emergencyFirstName, ad.emergencyLastName].filter(Boolean).join(' '),
        emergencyRelation: ad.emergencyRelation,
        emergencyPhoneFull: [ad.emergencyPhoneCode, ad.emergencyPhone].filter(Boolean).join(' ').trim(),
        emergencyEmail: ad.emergencyEmail,
      };

      setApplicantData({
        ...applicant,
        ...appDataMapped,
        fullName: `${applicant.firstName} ${applicant.lastName}`.trim(),
        applicationDate: applicant.createdAt ? applicant.createdAt.slice(0, 10) : '',
        status: applicant.status || 'NEW',
        ...extra,
        id: applicant.id,
        email: applicant.email,
        phone: applicant.phone,
        nationality: applicant.nationality,
        dateOfBirth: applicant.dateOfBirth ? applicant.dateOfBirth.slice(0, 10) : '',
        preferredStartDate: applicant.preferredStartDate ? applicant.preferredStartDate.slice(0, 10) : '',
        jobType: applicant.jobType,
        agencyId: applicant.agencyId ?? null,
        agency: applicant.agency ?? null,
        currentWorkflowStageId: applicant.currentWorkflowStageId ?? null,
        currentWorkflowStage: applicant.currentWorkflowStage ?? null,
        // Lifecycle identifiers & conversion timestamps
        leadNumber: (applicant as any).leadNumber ?? null,
        candidateNumber: (applicant as any).candidateNumber ?? null,
        candidateConvertedAt: (applicant as any).candidateConvertedAt
          ? formatDate((applicant as any).candidateConvertedAt)
          : null,
        employeeConvertedAt: (applicant as any).employeeConvertedAt
          ? formatDate((applicant as any).employeeConvertedAt)
          : null,
        // Creation attribution surfaced on the Lifecycle card.
        source: (applicant as any).source ?? 'STAFF_CREATED',
        createdBy: (applicant as any).createdBy ?? null,
      });
    }).catch((err) => {
      toast.error(apiError(err, t('pages:applicants.profile.toast.loadFailed')));
      navigate('/dashboard/applicants');
    }).finally(() => setLoading(false));
  }, [id, navigate, t]);

  const handleStageChange = async (stageId: string) => {
    if (!stageId || !id) return;
    setChangingStage(true);
    try {
      const updated = await applicantsApi.setCurrentStage(id, stageId);
      setApplicantData((prev: any) => ({ ...prev, currentWorkflowStage: updated.currentWorkflowStage, currentWorkflowStageId: updated.currentWorkflowStageId }));
      toast.success(t('pages:applicants.profile.toast.stageUpdated'));
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.stageFailed')));
    } finally {
      setChangingStage(false);
    }
  };

  const handleAssignCandidateWorkflow = async () => {
    if (!assignWorkflowId || !id) return;
    setAssigningWorkflow(true);
    try {
      await workflowApi.assignCandidate({ candidateId: id, workflowId: assignWorkflowId });
      toast.success(t('pages:applicants.profile.toast.workflowConnected'));
      loadCandidateWorkflow();
      setShowAssignWorkflow(false);
      setAssignWorkflowId('');
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.workflowFailed')));
    } finally {
      setAssigningWorkflow(false);
    }
  };

  const handleDisconnectCandidateWorkflow = async () => {
    if (!id || !candidateAssignment) return;
    if (!(await confirm({
      title: t('pages:applicants.profile.confirmDisconnect.title'),
      description: t('pages:applicants.profile.confirmDisconnect.description'),
      confirmText: t('pages:applicants.profile.confirmDisconnect.confirm'),
    }))) return;
    try {
      await workflowApi.removeCandidateAssignment(id, candidateAssignment.id);
      setCandidateAssignment(null);
      toast.success(t('pages:applicants.profile.toast.workflowDisconnected'));
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.disconnectFailed')));
    }
  };

  const handleSetCandidateStage = async (stageId: string) => {
    if (!candidateAssignment) return;
    setSettingStage(true);
    try {
      await workflowApi.advanceToStage(candidateAssignment.id, stageId);
      loadCandidateWorkflow();
      toast.success(t('pages:applicants.profile.toast.currentStageUpdated'));
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.currentStageFailed')));
    } finally {
      setSettingStage(false);
    }
  };

  const handleApproveCandidateStage = async (progressId: string) => {
    setApprovingProgressId(progressId);
    try {
      await workflowApi.submitApproval(progressId, { decision: 'APPROVED' });
      loadCandidateWorkflow();
      toast.success(t('pages:applicants.profile.toast.stageApproved'));
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.stageApproveFailed')));
    } finally {
      setApprovingProgressId(null);
    }
  };

  const handleAgencyChange = async (value: string) => {
    if (!id) return;
    const newAgencyId = value === '__none__' ? null : value;
    setChangingAgency(true);
    try {
      const updated = await applicantsApi.update(id, { agencyId: newAgencyId });
      setApplicantData((prev: any) => ({ ...prev, agencyId: updated.agencyId, agency: updated.agency }));
      toast.success(t('pages:applicants.profile.toast.agencyUpdated'));
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.agencyFailed')));
    } finally {
      setChangingAgency(false);
    }
  };

  // ── Document row actions ───────────────────────────────────────────────
  const handleApproveDoc = async (doc: any) => {
    setVerifyingDocId(doc.id);
    try {
      const updated = await documentsApi.verify(doc.id, { action: 'VERIFY' });
      setDocuments((prev: any[]) => prev.map(d => d.id === doc.id ? updated : d));
      toast.success(t('pages:applicants.profile.toast.docApproved', { name: doc.name }));
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.docApproveFailed')));
    } finally {
      setVerifyingDocId(null);
    }
  };

  const handleRejectDocSubmit = async () => {
    if (!rejectDocReason.trim()) { toast.error(t('pages:applicants.profile.toast.rejectReasonRequired')); return; }
    setVerifyingDocId(rejectDocDialog.docId);
    try {
      const updated = await documentsApi.verify(rejectDocDialog.docId, { action: 'REJECT', reason: rejectDocReason.trim() });
      setDocuments((prev: any[]) => prev.map(d => d.id === rejectDocDialog.docId ? updated : d));
      toast.success(t('pages:applicants.profile.toast.docRejected', { name: rejectDocDialog.docName }));
      setRejectDocDialog({ open: false, docId: '', docName: '' });
      setRejectDocReason('');
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.docRejectFailed')));
    } finally {
      setVerifyingDocId(null);
    }
  };

  const handleDeleteDoc = async (doc: any) => {
    const ok = await confirm({
      title: t('pages:applicants.profile.confirmDeleteDoc.title'),
      description: t('pages:applicants.profile.confirmDeleteDoc.description', { name: doc.name }),
      confirmText: t('pages:applicants.profile.confirmDeleteDoc.confirm'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await documentsApi.delete(doc.id);
      setDocuments((prev: any[]) => prev.filter(d => d.id !== doc.id));
      toast.success(t('pages:applicants.profile.toast.docDeleted'));
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.docDeleteFailed')));
    }
  };

  const handleUpload = async () => {
    if (!uploadFile) { toast.error(t('pages:applicants.profile.toast.fileRequired')); return; }
    if (!uploadForm.documentTypeId) { toast.error(t('pages:applicants.profile.toast.typeRequired')); return; }
    if (!uploadForm.name.trim()) { toast.error(t('pages:applicants.profile.toast.nameRequired')); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('name', uploadForm.name);
      fd.append('documentTypeId', uploadForm.documentTypeId);
      fd.append('entityType', 'APPLICANT');
      fd.append('entityId', id!);
      if (uploadForm.issueDate) fd.append('issueDate', uploadForm.issueDate);
      // "No Expiry" wins over any stale date the user typed before
      // ticking the box — send an empty expiryDate so the backend
      // stores null and the UI treats it as perpetual.
      if (!uploadForm.noExpiry && uploadForm.expiryDate) fd.append('expiryDate', uploadForm.expiryDate);
      if (uploadForm.noExpiry) fd.append('noExpiry', 'true');
      if (uploadForm.documentNumber) fd.append('documentNumber', uploadForm.documentNumber);
      if (uploadForm.issuer) fd.append('issuer', uploadForm.issuer);
      await documentsApi.upload(fd);
      toast.success(t('pages:applicants.profile.toast.uploaded'));
      setShowUpload(false);
      setUploadFile(null);
      setUploadForm({ documentTypeId: '', name: '', issueDate: '', expiryDate: '', noExpiry: false, documentNumber: '', issuer: '' });
      loadDocs();
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.uploadFailed')));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!(await confirm({
      title: t('pages:applicants.profile.confirmDelete.title'),
      description: t('pages:applicants.profile.confirmDelete.description'),
      confirmText: t('pages:applicants.profile.confirmDelete.confirm'), tone: 'destructive',
    }))) return;
    try {
      await applicantsApi.delete(id);
      toast.success(t('pages:applicants.profile.toast.deleted'));
      navigate('/dashboard/applicants');
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.deleteFailed')));
    }
  };

  const handleConvertToEmployee = async () => {
    if (!id) return;
    if (!convertForm.addressLine1.trim() || !convertForm.city.trim() || !convertForm.country.trim() || !convertForm.postalCode.trim()) {
      toast.error(t('pages:applicants.profile.toast.addressRequired'));
      return;
    }
    setConverting(true);
    try {
      const payload: any = {
        addressLine1: convertForm.addressLine1.trim(),
        city: convertForm.city.trim(),
        country: convertForm.country.trim(),
        postalCode: convertForm.postalCode.trim(),
      };
      if (convertForm.addressLine2.trim()) payload.addressLine2 = convertForm.addressLine2.trim();
      if (convertForm.licenseNumber.trim()) payload.licenseNumber = convertForm.licenseNumber.trim();
      if (convertForm.licenseCategory.trim()) payload.licenseCategory = convertForm.licenseCategory.trim();
      if (convertForm.yearsExperience) payload.yearsExperience = Number(convertForm.yearsExperience);
      if (convertForm.emergencyContact.trim()) payload.emergencyContact = convertForm.emergencyContact.trim();
      if (convertForm.emergencyPhone.trim()) payload.emergencyPhone = convertForm.emergencyPhone.trim();

      const result = await applicantsApi.convertToEmployee(id, payload);
      toast.success(t('pages:applicants.profile.toast.convertedToEmployee'));
      setShowConvertDialog(false);
      navigate(`/dashboard/employees/${result.employee.id}`);
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.convertFailed')));
    } finally {
      setConverting(false);
    }
  };

  // Load financial profile and agency history when tab is opened
  const loadFinancialProfile = () => {
    if (!id || !isFinanceOrAdmin) return;
    setFinancialLoading(true);
    applicantsApi.getFinancialProfile(id)
      .then((data: any) => {
        setFinancialProfile(data);
        setFinancialForm(data ?? {});
      })
      .catch(() => {})
      .finally(() => setFinancialLoading(false));
  };

  const loadAgencyHistory = () => {
    if (!id) return;
    setHistoryLoading(true);
    applicantsApi.getAgencyHistory(id)
      .then((data: any) => setAgencyHistory(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  };

  const handleConvertLeadToCandidate = async () => {
    if (!id) return;
    setConvertingLead(true);
    try {
      // Pass the chosen responsible agency straight through — the
      // backend falls back to the default holding agency when blank.
      const payload = promoteAgencyId ? { agencyId: promoteAgencyId } : {};
      const updated = await applicantsApi.convertLeadToCandidate(id, payload);
      setApplicantData((prev: any) => ({
        ...prev,
        tier: 'CANDIDATE',
        agencyId: updated.agencyId,
        agency: updated.agency,
        candidateNumber: updated.candidateNumber ?? prev.candidateNumber,
      }));
      // Keep the dialog open but flip it into a confirmation panel so
      // the operator has to explicitly acknowledge the promotion.
      setPromoteSuccess({ newCandidateNumber: updated.candidateNumber });
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.promoteFailed')));
    } finally {
      setConvertingLead(false);
    }
  };

  const closePromoteDialog = () => {
    setShowConvertLeadDialog(false);
    setPromoteSuccess(null);
  };

  const handleSaveFinancial = async () => {
    if (!id) return;
    setSavingFinancial(true);
    try {
      const saved = await applicantsApi.upsertFinancialProfile(id, financialForm);
      setFinancialProfile(saved);
      toast.success(t('pages:applicants.profile.toast.financialSaved'));
    } catch (err) {
      toast.error(apiError(err, t('pages:applicants.profile.toast.financialFailed')));
    } finally {
      setSavingFinancial(false);
    }
  };

  const validDocs = documents.filter(d => d.status === 'VERIFIED' || d.status === 'Verified').length;
  const expiringSoon = documents.filter(d => d.status === 'EXPIRING_SOON').length;

  if (loading) return <div className="p-8 text-muted-foreground">{t('pages:applicants.profile.loading')}</div>;
  if (!applicantData) return <div className="p-8">{t('pages:applicants.profile.notFound')}</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/applicants"><ArrowLeft className="w-5 h-5 rtl:rotate-180" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('pages:applicants.profile.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('pages:applicants.profile.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Tier badge */}
          {applicantData && (
            <Badge className={applicantData.tier === 'CANDIDATE'
              ? 'bg-emerald-100 text-emerald-800 border border-emerald-200 text-sm px-3 py-1'
              : 'bg-amber-100 text-amber-800 border border-amber-200 text-sm px-3 py-1'}>
              {applicantData.tier ?? 'LEAD'}
            </Badge>
          )}
          {canEdit('applicants') && (
            <Button asChild variant="outline">
              <Link to={`/dashboard/applicants/${id}/edit`}>
                <Edit className="w-4 h-4 me-2" />{t('common:actions.edit')}
              </Link>
            </Button>
          )}
          {/* Promote Lead → Candidate */}
          {canEdit('applicants') && applicantData?.tier === 'LEAD' && (
            <Button
              variant="outline"
              className="text-emerald-700 border-emerald-300"
              onClick={() => {
                // Pre-select the applicant's existing agency so the
                // operator can just confirm in the common case.
                setPromoteAgencyId(applicantData?.agencyId ?? '');
                setShowConvertLeadDialog(true);
              }}
            >
              <TrendingUp className="w-4 h-4 me-2" />{t('pages:applicants.profile.promoteToCandidate')}
            </Button>
          )}
          {/* Convert Candidate → Employee */}
          {canEdit('applicants') && applicantData?.tier === 'CANDIDATE' && (
            <Button className="bg-[#22C55E] hover:bg-[#16a34a]" onClick={() => setShowConvertDialog(true)}>
              <UserPlus className="w-4 h-4 me-2" />{t('common:actions.convertToEmployee')}
            </Button>
          )}
          <ApplicantPdfExportButton applicant={applicantData} documents={documents} />
          {canDelete('applicants') && (
            <Button variant="outline" className="text-[#EF4444] border-[#EF4444]" onClick={handleDelete}>
              <Trash2 className="w-4 h-4 me-2" />{t('common:actions.delete')}
            </Button>
          )}
        </div>
      </div>

      {/* Hero Card */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start gap-6">
            <div className="w-24 h-24 rounded-full shrink-0 overflow-hidden bg-[#EFF6FF] flex items-center justify-center">
              {applicantData.photoUrl
                ? <img
                    src={applicantData.photoUrl.startsWith('http') ? applicantData.photoUrl : `${API_BASE}${applicantData.photoUrl}`}
                    alt={applicantData.fullName}
                    className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                : <span className="text-[#2563EB] text-3xl font-semibold">{applicantData.firstName?.[0]}{applicantData.lastName?.[0]}</span>
              }
            </div>
            <div className="flex-1">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-2xl font-semibold text-[#0F172A]">{applicantData.fullName}</h2>
                  {/* Lifecycle identifier — shows current active stage ID */}
                  <div className="flex items-center gap-2 mt-1">
                    {applicantData.tier === 'CANDIDATE' && applicantData.candidateNumber ? (
                      <span className="font-mono text-sm font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded px-2 py-0.5">
                        {applicantData.candidateNumber}
                      </span>
                    ) : applicantData.leadNumber ? (
                      <span className="font-mono text-sm font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">
                        {applicantData.leadNumber}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">{t('pages:applicants.profile.noIdentifierLegacy')}</span>
                    )}
                    {/* Also show lead number for candidates so traceability is visible */}
                    {applicantData.tier === 'CANDIDATE' && applicantData.leadNumber && (
                      <span className="text-xs text-muted-foreground">
                        {t('pages:applicants.profile.wasLeadPrefix', { leadNumber: applicantData.leadNumber })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {applicantData.approvalStatus === 'PENDING_APPROVAL' && (
                    <Badge className="bg-amber-100 text-amber-900 border border-amber-300">{t('pages:applicants.profile.candidateApproval.pendingBadge')}</Badge>
                  )}
                  {applicantData.approvalStatus === 'REJECTED' && (
                    <Badge className="bg-red-100 text-red-900 border border-red-300">{t('pages:applicants.profile.candidateApproval.rejectedBadge')}</Badge>
                  )}
                  <Badge className={statusBadgeClass(applicantData.status)}>
                    {enumLabel('applicantStatus', applicantData.status)}
                  </Badge>
                  {applicantData.applicationSource && (
                    <Badge
                      variant="outline"
                      className={
                        applicantData.applicationSource.kind === 'JOB_AD'   ? 'bg-blue-50 text-blue-800 border-blue-300'   :
                        applicantData.applicationSource.kind === 'PUBLIC'   ? 'bg-emerald-50 text-emerald-800 border-emerald-300' :
                        'bg-slate-50 text-slate-800 border-slate-300'
                      }
                      title={applicantData.applicationSource.label}
                    >
                      {applicantData.applicationSource.label}
                    </Badge>
                  )}
                </div>
              </div>

              {applicantData.approvalStatus === 'PENDING_APPROVAL' && (currentUser?.role === 'System Admin' || currentUser?.role === 'HR Manager') && (
                <div className="mt-4 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                  <div className="flex-1 text-sm">
                    <p className="font-medium text-amber-900">{t('pages:applicants.profile.candidateApproval.pendingTitle')}</p>
                    <p className="text-amber-800">{t('pages:applicants.profile.candidateApproval.pendingBody')}</p>
                  </div>
                  <Button size="sm" onClick={async () => {
                    try {
                      const updated = await applicantsApi.approve(applicantData.id);
                      setApplicantData(updated);
                      toast.success(t('pages:applicants.profile.candidateApproval.approved'));
                    } catch (err) { toast.error(apiError(err, t('pages:applicants.profile.candidateApproval.approveFailed'))); }
                  }}>{t('pages:applicants.profile.candidateApproval.approve')}</Button>
                  <Button size="sm" variant="outline" onClick={async () => {
                    if (!(await confirm({
                      title: t('pages:applicants.profile.candidateApproval.confirmReject.title'),
                      description: t('pages:applicants.profile.candidateApproval.confirmReject.description'),
                      confirmText: t('pages:applicants.profile.candidateApproval.confirmReject.confirm'), tone: 'destructive',
                    }))) return;
                    try {
                      const updated = await applicantsApi.reject(applicantData.id);
                      setApplicantData(updated);
                      toast.success(t('pages:applicants.profile.candidateApproval.rejected'));
                    } catch (err) { toast.error(apiError(err, t('pages:applicants.profile.candidateApproval.rejectFailed'))); }
                  }}>{t('pages:applicants.profile.candidateApproval.reject')}</Button>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.header.email')}</p>
                    <p className="text-sm font-medium">{applicantData.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.header.phone')}</p>
                    <p className="text-sm font-medium">{formatPhoneDisplay(applicantData.phone)}</p>
                  </div>
                  <WhatsAppButton phone={formatPhoneDisplay(applicantData.phone)} size="icon" />
                </div>
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.header.citizenship')}</p>
                    <p className="text-sm font-medium">{applicantData.nationality}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.header.applied')}</p>
                    <p className="text-sm font-medium">{applicantData.applicationDate ? formatDate(applicantData.applicationDate) : ''}</p>
                  </div>
                </div>
              </div>
              {/* Family / Emergency Contact — only rendered when the
                  applicant has filled in at least one field so we don't
                  leave blank dashes cluttering the card. */}
              {(applicantData.emergencyFullName || applicantData.emergencyPhoneFull || applicantData.emergencyEmail) && (
                <div className="mt-6 pt-4 border-t">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">{t('pages:applicants.profile.emergency.sectionTitle')}</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="flex items-center gap-2">
                      <UserPlus className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.emergency.name')}</p>
                        <p className="text-sm font-medium">{applicantData.emergencyFullName || '—'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Briefcase className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.emergency.relationship')}</p>
                        <p className="text-sm font-medium">{applicantData.emergencyRelation || '—'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Phone className="w-4 h-4 text-muted-foreground" />
                      <div className="flex-1">
                        <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.emergency.phone')}</p>
                        <p className="text-sm font-medium">{applicantData.emergencyPhoneFull || '—'}</p>
                      </div>
                      {applicantData.emergencyPhoneFull && <WhatsAppButton phone={applicantData.emergencyPhoneFull} size="icon" />}
                    </div>
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.emergency.email')}</p>
                        <p className="text-sm font-medium">{applicantData.emergencyEmail || '—'}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quick Nav */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t('pages:applicants.profile.quickNav.travel'),         icon: FileText,      target: 'section-travel' },
          { label: t('pages:applicants.profile.quickNav.driving'),        icon: Award,         target: 'section-driving' },
          { label: t('pages:applicants.profile.quickNav.education'),      icon: GraduationCap, target: 'section-education' },
          { label: t('pages:applicants.profile.quickNav.workExperience'), icon: Briefcase,     target: 'section-work-experience' },
        ].map(({ label, icon: Icon, target }) => (
          <Button key={label} variant="outline" className="justify-between" onClick={() => scrollToSection(target)}>
            <div className="flex items-center gap-2"><Icon className="w-4 h-4" /><span>{label}</span></div>
            <ChevronRight className="w-4 h-4 rtl:rotate-180" />
          </Button>
        ))}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6" dir={dir}>
        <TabsList>
          <TabsTrigger value="overview">{t('pages:applicants.profile.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="application">{t('pages:applicants.profile.tabs.application')}</TabsTrigger>
          <TabsTrigger value="documents">{t('pages:applicants.profile.tabs.documents', { count: documents.length })}</TabsTrigger>
          {/* Workflows bind to Candidates on the backend — hide the
              tab entirely while the profile is still a LEAD. */}
          {applicantData?.tier !== 'LEAD' && (
            <TabsTrigger value="workflow">{t('pages:applicants.profile.tabs.workflow')}</TabsTrigger>
          )}
          <TabsTrigger value="compliance">{t('pages:applicants.profile.tabs.docCompliance')}</TabsTrigger>
          {isFinanceOrAdmin && (
            <TabsTrigger
              value="financial"
              onClick={() => { loadFinancialProfile(); }}
            >
              <DollarSign className="w-3 h-3 me-1" />{t('pages:applicants.profile.tabs.financial')}
            </TabsTrigger>
          )}
          <TabsTrigger value="history" onClick={loadAgencyHistory}>
            <History className="w-3 h-3 me-1" />{t('pages:applicants.profile.tabs.agencyHistory')}
          </TabsTrigger>
          <TabsTrigger value="notes">{t('pages:applicants.profile.tabs.notes')}</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Personal Information */}
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle>{t('pages:applicants.profile.personal.title')}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  {[
                    [t('pages:applicants.profile.personal.fullName'), applicantData.fullName],
                    [t('pages:applicants.profile.personal.dateOfBirth'), applicantData.dateOfBirth ? formatDate(applicantData.dateOfBirth) : '—'],
                    [t('pages:applicants.profile.personal.citizenship'), applicantData.nationality],
                    [t('pages:applicants.profile.personal.licenseNumber'), applicantData.drivingLicenseNumber || '—'],
                    [t('pages:applicants.profile.personal.licenseCategory'), [applicantData.categoryC && 'C', applicantData.categoryE && 'E'].filter(Boolean).join('+') || '—'],
                    [t('pages:applicants.profile.personal.yearsEUExperience'), applicantData.yearsEUExperience || '—'],
                    [t('pages:applicants.profile.personal.permanentAddress'), applicantData.permanentAddress || '—'],
                    [t('pages:applicants.profile.personal.countryOfResidence'), applicantData.countryOfResidence || '—'],
                    [t('pages:applicants.profile.personal.currentCountry'), applicantData.currentCountryOfResidence || '—'],
                    [t('pages:applicants.profile.personal.appliedPosition'), applicantData.jobAd?.title || t('pages:applicants.profile.personal.general')],
                    [t('pages:applicants.profile.personal.preferredStartDate'), applicantData.preferredStartDate ? formatDate(applicantData.preferredStartDate) : '—'],
                    [t('pages:applicants.profile.personal.howTheyHeard'), applicantData.howDidYouHear || '—'],
                  ].map(([label, value]: any) => (
                    <div key={label}>
                      <p className="text-sm text-muted-foreground">{label}</p>
                      <p className="font-medium">{value}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Right sidebar */}
            <div className="space-y-6">
              {/* Quick Stats */}
              <Card>
                <CardHeader><CardTitle>{t('pages:applicants.profile.stats.title')}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  {[
                    { icon: FileText, color: 'text-[#2563EB]', bg: 'bg-[#EFF6FF]', value: documents.length, label: t('pages:applicants.profile.stats.documents') },
                    { icon: Shield, color: 'text-[#22C55E]', bg: 'bg-[#F0FDF4]', value: validDocs, label: t('pages:applicants.profile.stats.validDocs') },
                    { icon: Clock, color: 'text-[#F59E0B]', bg: 'bg-[#FEF3C7]', value: expiringSoon, label: t('pages:applicants.profile.stats.expiringSoon') },
                  ].map(({ icon: Icon, color, bg, value, label }) => (
                    <div key={label} className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-lg ${bg} flex items-center justify-center`}>
                        <Icon className={`w-5 h-5 ${color}`} />
                      </div>
                      <div>
                        <p className="text-2xl font-semibold">{value}</p>
                        <p className="text-sm text-muted-foreground">{label}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Lifecycle Identifiers */}
              <Card>
                <CardHeader><CardTitle>{t('pages:applicants.profile.lifecycle.title')}</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="space-y-2">
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{t('pages:applicants.profile.lifecycle.leadId')}</p>
                      {applicantData.leadNumber
                        ? <span className="font-mono font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">{applicantData.leadNumber}</span>
                        : <span className="text-muted-foreground italic text-xs">{t('pages:applicants.profile.lifecycle.notAssignedLegacy')}</span>}
                      <p className="text-xs text-muted-foreground mt-1">{t('pages:applicants.profile.lifecycle.createdLabel', { date: applicantData.applicationDate ? formatDate(applicantData.applicationDate) : '—' })}</p>
                    </div>
                    <div className="border-t pt-2">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{t('pages:applicants.profile.lifecycle.candidateId')}</p>
                      {applicantData.candidateNumber
                        ? <span className="font-mono font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded px-2 py-0.5">{applicantData.candidateNumber}</span>
                        : <span className="text-muted-foreground italic text-xs">{applicantData.tier === 'LEAD' ? t('pages:applicants.profile.lifecycle.notYetConverted') : t('pages:applicants.profile.lifecycle.notAssignedLegacy')}</span>}
                      {applicantData.candidateConvertedAt && (
                        <p className="text-xs text-muted-foreground mt-1">{t('pages:applicants.profile.lifecycle.convertedLabel', { date: applicantData.candidateConvertedAt })}</p>
                      )}
                    </div>
                    {/* Creation attribution — self-applied via public form vs
                        dashboard-created by a staff user. */}
                    <div className="border-t pt-2">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{t('pages:applicants.profile.lifecycle.createdBy')}</p>
                      {applicantData.source === 'SELF_APPLIED' ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-0.5">
                          {t('pages:applicants.profile.lifecycle.selfApplied')}
                        </span>
                      ) : applicantData.createdBy ? (
                        <p className="text-sm font-medium">
                          {[applicantData.createdBy.firstName, applicantData.createdBy.lastName].filter(Boolean).join(' ')}
                          {applicantData.createdBy.email && (
                            <span className="text-xs text-muted-foreground font-normal ms-1">· {applicantData.createdBy.email}</span>
                          )}
                        </p>
                      ) : (
                        <span className="text-muted-foreground italic text-xs">{t('pages:applicants.profile.lifecycle.unknownLegacy')}</span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Agency */}
              <Card>
                <CardHeader><CardTitle>{t('pages:applicants.profile.agency.title')}</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {applicantData.agency && (
                    <div className="flex items-center gap-3 pb-3 border-b">
                      <div className="w-8 h-8 rounded-lg bg-[#F8FAFC] flex items-center justify-center">
                        <Briefcase className="w-4 h-4 text-[#2563EB]" />
                      </div>
                      <p className="font-medium text-sm">{applicantData.agency.name}</p>
                    </div>
                  )}
                  {canEdit('applicants') && (
                    <Select
                      value={applicantData.agencyId ?? '__none__'}
                      onValueChange={handleAgencyChange}
                      disabled={changingAgency}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('pages:applicants.profile.agency.noAgency')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t('pages:applicants.profile.agency.noAgency')}</SelectItem>
                        {agencies.map((a: any) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Applicant-specific details */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Travel & Residence Documents */}
            <Card id="section-travel" className="scroll-mt-24">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5" />{t('pages:applicants.profile.travelDocs.title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <InfoRow label={t('pages:applicants.profile.travelDocs.passportNumber')} value={applicantData.passportNumber} />
                <InfoRow label={t('pages:applicants.profile.travelDocs.passportValidUntil')} value={applicantData.passportValidUntil} />
                <InfoRow label={t('pages:applicants.profile.travelDocs.issuingCountry')} value={applicantData.issuingCountry} />

                <InfoRow label={t('pages:applicants.profile.travelDocs.euVisa')} value={applicantData.hasEUVisa ? t('pages:applicants.profile.travelDocs.yes') : t('pages:applicants.profile.travelDocs.no')} />
                {applicantData.hasEUVisa && (
                  <div className="ps-4 border-s-2 border-blue-100 ms-1 space-y-2">
                    <InfoRow label={t('pages:applicants.profile.travelDocs.visaType')} value={applicantData.euVisaType} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.issuingCountry')} value={applicantData.euVisaCountry} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.visaNumber')} value={applicantData.euVisaNumber} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.validUntil')} value={applicantData.euVisaExpiryDate} />
                  </div>
                )}

                <InfoRow label={t('pages:applicants.profile.travelDocs.workPermitInEU')} value={applicantData.hasWorkPermit ? t('pages:applicants.profile.travelDocs.yes') : t('pages:applicants.profile.travelDocs.no')} />
                {applicantData.hasWorkPermit && (
                  <div className="ps-4 border-s-2 border-blue-100 ms-1 space-y-2">
                    <InfoRow label={t('pages:applicants.profile.travelDocs.permitType')} value={applicantData.workPermitType} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.permitNumber')} value={applicantData.workPermitNumber} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.issuingCountry')} value={applicantData.workPermitCountry} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.issueDate')} value={applicantData.workPermitIssueDate} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.validUntil')} value={applicantData.workPermitExpiryDate} />
                  </div>
                )}

                <InfoRow label={t('pages:applicants.profile.travelDocs.residenceCardInEU')} value={applicantData.hasResidenceCard ? t('pages:applicants.profile.travelDocs.yes') : t('pages:applicants.profile.travelDocs.no')} />
                {applicantData.hasResidenceCard && (
                  <div className="ps-4 border-s-2 border-blue-100 ms-1 space-y-2">
                    <InfoRow label={t('pages:applicants.profile.travelDocs.residenceType')} value={applicantData.euResidenceType} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.residenceNumber')} value={applicantData.euResidenceNumber} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.country')} value={applicantData.euResidenceCountry} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.city')} value={applicantData.euResidenceCity} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.issueDate')} value={applicantData.euResidenceIssueDate} />
                    <InfoRow label={t('pages:applicants.profile.travelDocs.validUntil')} value={applicantData.euResidenceExpiryDate} />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Driving Licence & Experience — merged drill-in page that
                keeps licence details, certifications, and international
                experience together instead of splitting them across two
                separate cards. Spans the full grid row so the two
                subsections sit side-by-side. */}
            <Card id="section-driving" className="lg:col-span-2 scroll-mt-24">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Award className="w-5 h-5" />{t('pages:applicants.profile.driving.title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* ── Licence + Certifications ── */}
                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('pages:applicants.profile.driving.licenceCertifications')}</p>
                    <InfoRow label={t('pages:applicants.profile.driving.licenseNumber')} value={applicantData.drivingLicenseNumber} />
                    <InfoRow label={t('pages:applicants.profile.driving.issuingCountry')} value={applicantData.licenseIssuingCountry} />
                    <InfoRow label={t('pages:applicants.profile.driving.validUntil')} value={applicantData.licenseValidUntil} />
                    <div className="pt-1">
                      <p className="text-sm text-muted-foreground mb-2">{t('pages:applicants.profile.driving.categories')}</p>
                      <div className="flex flex-wrap gap-2">
                        {applicantData.categoryA && applicantData.categoryA !== '-' && <Badge variant="outline">A</Badge>}
                        {applicantData.categoryB && applicantData.categoryB !== '-' && <Badge variant="outline">B</Badge>}
                        {applicantData.categoryC && applicantData.categoryC !== '-' && <Badge variant="outline" className="border-[#2563EB] text-[#2563EB]">C</Badge>}
                        {applicantData.categoryE && applicantData.categoryE !== '-' && <Badge variant="outline" className="border-[#2563EB] text-[#2563EB]">E</Badge>}
                      </div>
                    </div>
                    <div className="pt-2 border-t space-y-2">
                      <InfoRow label={t('pages:applicants.profile.driving.tachographCard')} value={applicantData.hasTachographCard ? t('pages:applicants.profile.driving.yesValue', { value: applicantData.tachographNumber || t('pages:applicants.profile.driving.yesNA') }) : t('pages:applicants.profile.driving.no')} />
                      <InfoRow label={t('pages:applicants.profile.driving.code95')} value={applicantData.hasQualificationCard ? t('pages:applicants.profile.driving.yesUntil', { date: applicantData.qualificationValidUntil || '—' }) : t('pages:applicants.profile.driving.no')} />
                      <InfoRow label={t('pages:applicants.profile.driving.adrCertificate')} value={applicantData.hasADR ? t('pages:applicants.profile.driving.yesValue', { value: applicantData.adrClasses || '—' }) : t('pages:applicants.profile.driving.no')} />
                    </div>
                  </div>

                  {/* ── International Experience ── */}
                  <div className="space-y-3 md:ps-6 md:border-s">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5" /> {t('pages:applicants.profile.driving.experienceTitle')}
                    </p>
                    <InfoRow label={t('pages:applicants.profile.driving.euExperience')} value={applicantData.hasEUExperience ? t('pages:applicants.profile.driving.yes') : t('pages:applicants.profile.driving.no')} />
                    <InfoRow label={t('pages:applicants.profile.driving.yearsInEU')} value={applicantData.yearsEUExperience} />
                    <InfoRow label={t('pages:applicants.profile.driving.totalCEExperience')} value={applicantData.totalCEExperience} />
                    <InfoRow label={t('pages:applicants.profile.driving.yearsActiveDriving')} value={applicantData.yearsActiveDriving} />
                    <InfoRow label={t('pages:applicants.profile.driving.drivenOtherCountries')} value={applicantData.drivenOtherCountries ? t('pages:applicants.profile.driving.yes') : t('pages:applicants.profile.driving.no')} />
                    {applicantData.specifyCountries && (
                      <div className="pt-2 border-t">
                        <p className="text-sm text-muted-foreground mb-1">{t('pages:applicants.profile.driving.countries')}</p>
                        <p className="font-medium">{applicantData.specifyCountries}</p>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Language Skills */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="w-5 h-5" />{t('pages:applicants.profile.languages.title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <InfoRow label={t('pages:applicants.profile.languages.english')} value={applicantData.englishLevel} />
                  <InfoRow label={t('pages:applicants.profile.languages.german')} value={applicantData.germanLevel} />
                  <InfoRow label={t('pages:applicants.profile.languages.russian')} value={applicantData.russianLevel} />
                  <InfoRow label={t('pages:applicants.profile.languages.otherLanguages')} value={applicantData.otherLanguages} />
                </div>
                <div className="mt-4 pt-4 border-t">
                  <InfoRow label={t('pages:applicants.profile.languages.languageAtWork')} value={applicantData.languageAtWork} />
                </div>
              </CardContent>
            </Card>

            {/* Work Flexibility */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="w-5 h-5" />{t('pages:applicants.profile.workFlex.title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <InfoRow label={t('pages:applicants.profile.workFlex.doubleCrew')} value={applicantData.doubleCrewWillingness ? t('pages:applicants.profile.workFlex.yes') : t('pages:applicants.profile.workFlex.no')} />
                  <InfoRow label={t('pages:applicants.profile.workFlex.maxTourLength')} value={applicantData.maxTourWeeks} />
                  <InfoRow label={t('pages:applicants.profile.workFlex.weekendDriving')} value={applicantData.weekendDriving ? t('pages:applicants.profile.workFlex.yes') : t('pages:applicants.profile.workFlex.no')} />
                  <InfoRow label={t('pages:applicants.profile.workFlex.nightDriving')} value={applicantData.nightDriving ? t('pages:applicants.profile.workFlex.yes') : t('pages:applicants.profile.workFlex.no')} />
                </div>
                <div className="grid grid-cols-2 gap-4 pt-3 border-t">
                  <InfoRow label={t('pages:applicants.profile.workFlex.preferredCountries')} value={applicantData.preferredCountries} />
                  <InfoRow label={t('pages:applicants.profile.workFlex.undesiredCountries')} value={applicantData.undesiredCountries} />
                </div>
              </CardContent>
            </Card>

            {/* Education — full array from applicationData rendered as
                a list. Hidden when the applicant didn't supply any. */}
            {Array.isArray(applicantData.applicationData?.education) && applicantData.applicationData.education.length > 0 && (
              <Card id="section-education" className="lg:col-span-2 scroll-mt-24">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <GraduationCap className="w-5 h-5" />{t('pages:applicants.profile.education.title')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {applicantData.applicationData.education.map((e: any, i: number) => (
                    <div key={e.id ?? i} className="p-3 border rounded-md">
                      <p className="text-sm font-semibold">
                        {e.level || e.degree || t('pages:applicants.profile.education.default')}{e.institution ? ` — ${e.institution}` : ''}
                      </p>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2 text-sm">
                        {e.fieldOfStudy && <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.education.fieldOfStudy')}</p><p className="font-medium">{e.fieldOfStudy}</p></div>}
                        {e.country && <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.education.country')}</p><p className="font-medium">{e.country}</p></div>}
                        {e.startDate && <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.education.start')}</p><p className="font-medium">{e.startDate}</p></div>}
                        <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.education.end')}</p><p className="font-medium">{(e.current || e.ongoing) ? t('pages:applicants.profile.education.ongoing') : (e.endDate || '—')}</p></div>
                      </div>
                      {e.degree && e.level !== e.degree && (
                        <p className="text-xs text-muted-foreground mt-2">{t('pages:applicants.profile.education.degreePrefix')} <span className="text-foreground">{e.degree}</span></p>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Work Experience — full array with references collapsed
                into a sub-block per entry. */}
            {Array.isArray(applicantData.applicationData?.workHistory) && applicantData.applicationData.workHistory.length > 0 && (
              <Card id="section-work-experience" className="lg:col-span-2 scroll-mt-24">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Briefcase className="w-5 h-5" />{t('pages:applicants.profile.workHistory.title')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {applicantData.applicationData.workHistory.map((w: any, i: number) => (
                    <div key={w.id ?? i} className="p-3 border rounded-md">
                      <p className="text-sm font-semibold">
                        {w.jobTitle || t('pages:applicants.profile.workHistory.defaultPosition')}{w.company ? ` — ${w.company}` : ''}
                      </p>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2 text-sm">
                        {w.country && <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workHistory.country')}</p><p className="font-medium">{w.country}</p></div>}
                        {w.startDate && <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workHistory.start')}</p><p className="font-medium">{w.startDate}</p></div>}
                        <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workHistory.end')}</p><p className="font-medium">{w.current ? t('pages:applicants.profile.workHistory.current') : (w.endDate || '—')}</p></div>
                        {(w.companyPhone || w.companyPhoneCode) && (
                          <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workHistory.companyPhone')}</p><p className="font-medium">{[w.companyPhoneCode, w.companyPhone].filter(Boolean).join(' ')}</p></div>
                        )}
                      </div>
                      {w.responsibilities && (
                        <div className="mt-2">
                          <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workHistory.responsibilities')}</p>
                          <p className="text-sm whitespace-pre-wrap">{w.responsibilities}</p>
                        </div>
                      )}
                      {w.reasonForLeaving && (
                        <p className="text-xs text-muted-foreground mt-2">{t('pages:applicants.profile.workHistory.reasonForLeaving')} <span className="text-foreground">{w.reasonForLeaving}</span></p>
                      )}
                      {(w.referenceName || w.referencePhone || w.referenceEmail) && (
                        <div className="mt-2 pt-2 border-t">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">{t('pages:applicants.profile.workHistory.reference')}</p>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                            {w.referenceName && <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workHistory.name')}</p><p className="font-medium">{w.referenceName}</p></div>}
                            {(w.referencePhone || w.referencePhoneCode) && <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workHistory.phone')}</p><p className="font-medium">{[w.referencePhoneCode, w.referencePhone].filter(Boolean).join(' ')}</p></div>}
                            {w.referenceEmail && <div><p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workHistory.email')}</p><p className="font-medium">{w.referenceEmail}</p></div>}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Application — complete render of every field the applicant
            submitted, pulled straight from applicant.applicationData so
            nothing the form captured is hidden behind the Edit page. */}
        <TabsContent value="application">
          <ApplicationDataView applicationData={applicantData.applicationData} fullName={applicantData.fullName} />
        </TabsContent>

        {/* Documents */}
        <TabsContent value="documents">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('pages:applicants.profile.documentsTab.title')}</CardTitle>
              {canEdit('applicants') && (
                <Button size="sm" onClick={() => setShowUpload(v => !v)} variant={showUpload ? 'outline' : 'default'}>
                  {showUpload
                    ? <><X className="w-4 h-4 me-1" />{t('pages:applicants.profile.documentsTab.cancel')}</>
                    : <><Upload className="w-4 h-4 me-1" />{t('pages:applicants.profile.documentsTab.uploadButton')}</>}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {showUpload && (
                <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
                  <h4 className="font-medium text-sm">{t('pages:applicants.profile.documentsTab.newDocumentTitle')}</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:applicants.profile.documentsTab.documentType')} *</Label>
                      <Select value={uploadForm.documentTypeId} onValueChange={v => setUploadForm(f => ({ ...f, documentTypeId: v }))}>
                        <SelectTrigger><SelectValue placeholder={t('pages:applicants.profile.documentsTab.selectType')} /></SelectTrigger>
                        <SelectContent>{docTypes.map(dt => <SelectItem key={dt.id} value={dt.id}>{dt.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:applicants.profile.documentsTab.documentName')} *</Label>
                      <Input placeholder={t('pages:applicants.profile.documentsTab.documentNamePh')} value={uploadForm.name} onChange={e => setUploadForm(f => ({ ...f, name: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:applicants.profile.documentsTab.issueDate')}</Label>
                      <DateInput value={uploadForm.issueDate} onChange={e => setUploadForm(f => ({ ...f, issueDate: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-xs">{t('pages:applicants.profile.documentsTab.expiryDate')}</Label>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                          <Checkbox
                            checked={uploadForm.noExpiry}
                            onCheckedChange={(c) => setUploadForm(f => ({
                              ...f,
                              noExpiry: !!c,
                              // Clear any previously entered date so the
                              // submitted payload matches what's visible.
                              expiryDate: c ? '' : f.expiryDate,
                            }))}
                          />
                          {t('pages:applicants.profile.documentsTab.noExpiry')}
                        </label>
                      </div>
                      <DateInput
                        value={uploadForm.expiryDate}
                        disabled={uploadForm.noExpiry}
                        onChange={e => setUploadForm(f => ({ ...f, expiryDate: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:applicants.profile.documentsTab.documentNumber')}</Label>
                      <Input placeholder={t('pages:applicants.profile.documentsTab.optionalPh')} value={uploadForm.documentNumber} onChange={e => setUploadForm(f => ({ ...f, documentNumber: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:applicants.profile.documentsTab.issuer')}</Label>
                      <Input placeholder={t('pages:applicants.profile.documentsTab.optionalPh')} value={uploadForm.issuer} onChange={e => setUploadForm(f => ({ ...f, issuer: e.target.value }))} />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label className="text-xs">{t('pages:applicants.profile.documentsTab.fileLabel')} *</Label>
                      <Input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onChange={e => setUploadFile(e.target.files?.[0] ?? null)} />
                      {uploadFile && <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.documentsTab.fileSize', { name: uploadFile.name, size: (uploadFile.size / 1024).toFixed(1) })}</p>}
                    </div>
                  </div>
                  <Button size="sm" onClick={handleUpload} disabled={uploading}>
                    <Upload className="w-4 h-4 me-1" />{uploading ? t('pages:applicants.profile.documentsTab.uploading') : t('pages:applicants.profile.documentsTab.upload')}
                  </Button>
                </div>
              )}
              {docsLoading ? (
                <p className="text-muted-foreground">{t('pages:applicants.profile.documentsTab.loading')}</p>
              ) : documents.length === 0 ? (
                <p className="text-muted-foreground">{t('pages:applicants.profile.documentsTab.empty')}</p>
              ) : (
                <div className="space-y-3">
                  {documents.map((doc: any) => (
                    <div key={doc.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-[#F8FAFC] transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                          <FileText className="w-5 h-5 text-[#2563EB]" />
                        </div>
                        <div>
                          <p className="font-medium">{getDocumentDisplayName(doc.name, doc.documentType?.name)}</p>
                          <p className="text-sm text-muted-foreground">
                            {doc.documentType?.name} {doc.fileSize ? `· ${(doc.fileSize / 1024).toFixed(1)} KB` : ''}
                          </p>
                          {doc.expiryDate && (
                            <p className="text-xs text-muted-foreground mt-1">{t('pages:applicants.profile.documentsTab.expires', { date: formatDate(doc.expiryDate) })}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        <Badge variant="outline" className={docStatusClass(doc.status)}>
                          {enumLabel('documentStatus', doc.status)}
                        </Badge>
                        <a
                          href={`${doc.fileUrl?.startsWith('http') ? '' : API_BASE}${doc.fileUrl}`}
                          target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm px-2 py-1 rounded hover:bg-muted transition-colors"
                          title={t('pages:applicants.profile.documentsTab.downloadTitle')}
                        >
                          <Download className="w-4 h-4" />
                        </a>
                        {doc.status === 'PENDING' && can('documents', 'verify') && (
                          <>
                            <Button size="sm" className="bg-emerald-500 hover:bg-emerald-600 text-white h-7 px-2" onClick={() => handleApproveDoc(doc)} disabled={verifyingDocId === doc.id}>
                              <CheckCircle2 className="w-3.5 h-3.5 me-1" />{verifyingDocId === doc.id ? '…' : t('pages:applicants.profile.documentsTab.approve')}
                            </Button>
                            <Button size="sm" variant="outline" className="text-red-500 border-red-300 hover:bg-red-50 h-7 px-2" onClick={() => { setRejectDocDialog({ open: true, docId: doc.id, docName: doc.name }); setRejectDocReason(''); }} disabled={verifyingDocId === doc.id}>
                              <XCircle className="w-3.5 h-3.5 me-1" />{t('pages:applicants.profile.documentsTab.reject')}
                            </Button>
                          </>
                        )}
                        {can('documents', 'read') && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" asChild title={t('documents.compliance.view', { ns: 'pages', defaultValue: 'View document' })}>
                            <Link to={`/dashboard/documents/${doc.id}`} aria-label={t('documents.compliance.viewDocument', { ns: 'pages', defaultValue: 'View document' })}>
                              <Eye className="w-3.5 h-3.5" />
                            </Link>
                          </Button>
                        )}
                        {canEdit('documents') && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" asChild title={t('pages:applicants.profile.documentsTab.editTitle')}>
                            <Link to={`/dashboard/documents/${doc.id}/edit`}><Edit className="w-3.5 h-3.5" /></Link>
                          </Button>
                        )}
                        {canDelete('documents') && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 hover:text-red-600 hover:bg-red-50" onClick={() => handleDeleteDoc(doc)} title={t('pages:applicants.profile.documentsTab.deleteTitle')}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Workflow — only rendered once the applicant is a Candidate. */}
        <TabsContent value="workflow">
          {!candidateAssignment ? (
            /* ── No workflow connected ─────────────────────────── */
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-primary" /> {t('pages:applicants.profile.workflowTab.connectTitle')}
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('pages:applicants.profile.workflowTab.connectSubtitle')}
                </p>
              </CardHeader>
              <CardContent>
                {showAssignWorkflow ? (
                  <div className="space-y-3 max-w-sm">
                    <Select value={assignWorkflowId} onValueChange={setAssignWorkflowId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('pages:applicants.profile.workflowTab.selectWorkflowPh')} />
                      </SelectTrigger>
                      <SelectContent>
                        {allWorkflows.map((w: any) => (
                          <SelectItem key={w.id} value={w.id}>
                            <div className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: w.color ?? '#6366F1' }} />
                              <span>{w.name}</span>
                              <span className={`ms-1 text-[10px] px-1.5 py-0.5 rounded border ${w.isPublic ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-700 border-slate-200'}`}>
                                {w.isPublic ? t('pages:applicants.profile.workflowTab.public') : t('pages:applicants.profile.workflowTab.private')}
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleAssignCandidateWorkflow} disabled={assigningWorkflow || !assignWorkflowId}>
                        {assigningWorkflow ? t('pages:applicants.profile.workflowTab.connecting') : t('pages:applicants.profile.workflowTab.connect')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setShowAssignWorkflow(false); setAssignWorkflowId(''); }}>
                        {t('common:actions.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  canEdit('applicants') && (
                    <Button onClick={() => setShowAssignWorkflow(true)}>
                      <Plus className="w-4 h-4 me-2" /> {t('pages:applicants.profile.workflowTab.connectButton')}
                    </Button>
                  )
                )}
              </CardContent>
            </Card>
          ) : (
            /* ── Workflow connected ─────────────────────────────── */
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-4 h-4 rounded-full" style={{ background: candidateAssignment.workflow?.color ?? '#6366F1' }} />
                    <CardTitle>{candidateAssignment.workflow?.name}</CardTitle>
                    {candidateAssignment.workflow && (
                      <span className={`text-[11px] px-1.5 py-0.5 rounded border ${candidateAssignment.workflow.isPublic ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-700 border-slate-200'}`}>
                        {candidateAssignment.workflow.isPublic ? t('pages:applicants.profile.workflowTab.public') : t('pages:applicants.profile.workflowTab.private')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Reassignment to a different workflow is
                        admin-only by product rule. */}
                    {canEdit('applicants') && currentUser?.role === 'System Admin' && (
                      <Button size="sm" variant="ghost" onClick={() => setShowAssignWorkflow(true)} title={t('pages:applicants.profile.workflowTab.changeTitle')}>
                        {t('pages:applicants.profile.workflowTab.change')}
                      </Button>
                    )}
                    {canEdit('applicants') && (
                      <Button size="sm" variant="ghost" onClick={handleDisconnectCandidateWorkflow}>
                        <X className="w-4 h-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
                {candidateAssignment.assignedBy && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('pages:applicants.profile.workflowTab.connectedBy', {
                      date: formatDate(candidateAssignment.assignedAt),
                      name: `${candidateAssignment.assignedBy.firstName} ${candidateAssignment.assignedBy.lastName}`,
                    })}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                {showAssignWorkflow && (
                  <div className="mb-4 p-4 border rounded-lg bg-muted/30 space-y-3">
                    <p className="text-sm font-medium">{t('pages:applicants.profile.workflowTab.changeWorkflow')}</p>
                    <Select value={assignWorkflowId} onValueChange={setAssignWorkflowId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('pages:applicants.profile.workflowTab.selectWorkflowPh')} />
                      </SelectTrigger>
                      <SelectContent>
                        {allWorkflows.map((w: any) => (
                          <SelectItem key={w.id} value={w.id}>
                            <div className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: w.color ?? '#6366F1' }} />
                              <span>{w.name}</span>
                              <span className={`ms-1 text-[10px] px-1.5 py-0.5 rounded border ${w.isPublic ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-700 border-slate-200'}`}>
                                {w.isPublic ? t('pages:applicants.profile.workflowTab.public') : t('pages:applicants.profile.workflowTab.private')}
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleAssignCandidateWorkflow} disabled={assigningWorkflow || !assignWorkflowId}>
                        {assigningWorkflow ? t('pages:applicants.profile.workflowTab.saving') : t('pages:applicants.profile.workflowTab.confirm')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setShowAssignWorkflow(false); setAssignWorkflowId(''); }}>
                        {t('common:actions.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
                {(!candidateAssignment.workflow?.stages || candidateAssignment.workflow.stages.length === 0) ? (
                  <p className="text-sm text-muted-foreground">{t('pages:applicants.profile.workflowTab.noStages')}</p>
                ) : (
                  <div className="space-y-1">
                    {candidateAssignment.workflow.stages.map((stage: any, index: number) => {
                      // Find the progress record for this stage
                      const progress = candidateAssignment.stageProgress?.find((p: any) => p.stageId === stage.id);
                      const isInProgress = progress?.status === 'IN_PROGRESS';
                      const isCurrent = progress?.status === 'ACTIVE' || isInProgress;
                      const isExpanded = expandedStageId === stage.id;
                      const latestApproval = progress?.approvals?.[0];
                      const isApproved = latestApproval?.decision === 'APPROVED';
                      const currentUserIsApprover = stage.assignedUsers?.some((u: any) => u.userId === currentUser?.id);

                      return (
                        <div key={stage.id} className={`rounded-lg border transition-all ${isCurrent ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:border-border hover:bg-muted/30'}`}>
                          {/* Stage row */}
                          <div
                            className="flex items-center gap-3 px-3 py-3 cursor-pointer"
                            onClick={() => setExpandedStageId(isExpanded ? null : stage.id)}
                          >
                            <div
                              className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-semibold ${isCurrent ? 'text-white ring-2 ring-offset-1 ring-primary' : 'text-white opacity-60'}`}
                              style={{ background: stage.color ?? '#6366F1' }}
                            >
                              {index + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`text-sm font-medium ${isCurrent ? 'text-primary' : ''}`}>{stage.name}</span>
                                {isInProgress
                                  ? <Badge className="text-xs bg-blue-600 hover:bg-blue-600">{t('pages:applicants.profile.workflowTab.inProgress')}</Badge>
                                  : isCurrent && <Badge className="text-xs bg-primary">{t('pages:applicants.profile.workflowTab.current')}</Badge>}
                                {isApproved && <Badge className="text-xs bg-green-500">{t('pages:applicants.profile.workflowTab.approved')}</Badge>}
                                {stage.isFinal && <Badge variant="outline" className="text-xs">{t('pages:applicants.profile.workflowTab.final')}</Badge>}
                                {stage.requiresApproval && !isApproved && <Badge variant="outline" className="text-xs border-amber-400 text-amber-600">{t('pages:applicants.profile.workflowTab.needsApproval')}</Badge>}
                                {stage.slaHours && <span className="text-xs text-muted-foreground">{t('pages:applicants.profile.workflowTab.slaSuffix', { hours: stage.slaHours })}</span>}
                              </div>
                              {stage.description && <p className="text-xs text-muted-foreground mt-0.5">{stage.description}</p>}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {canEdit('applicants') && !isCurrent && (
                                <Button
                                  size="sm" variant="ghost"
                                  className="text-xs h-7"
                                  onClick={(e) => { e.stopPropagation(); handleSetCandidateStage(stage.id); }}
                                  disabled={settingStage}
                                >
                                  {t('pages:applicants.profile.workflowTab.setCurrent')}
                                </Button>
                              )}
                              <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform rtl:rotate-180 ${isExpanded ? 'rotate-90 rtl:rotate-90' : ''}`} />
                            </div>
                          </div>

                          {/* Expanded panel */}
                          {isExpanded && (
                            <div className="px-3 pb-4 border-t pt-3 space-y-4">

                              {/* Required Documents */}
                              <div>
                                <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">{t('pages:applicants.profile.workflowTab.requiredDocs')}</p>
                                {!stage.requiredDocs || stage.requiredDocs.length === 0 ? (
                                  <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workflowTab.noRequiredDocs')}</p>
                                ) : (
                                  <div className="space-y-1.5">
                                    {stage.requiredDocs.map((rd: any) => {
                                      const uploaded = documents.find((d: any) => d.documentTypeId === rd.documentTypeId);
                                      return (
                                        <div key={rd.id} className="flex items-center justify-between p-2 rounded-md border bg-background">
                                          <div className="flex items-center gap-2">
                                            <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                            <div>
                                              <p className="text-xs font-medium">{rd.documentType?.name}</p>
                                              {rd.documentType?.category && <p className="text-[11px] text-muted-foreground">{rd.documentType.category}</p>}
                                            </div>
                                          </div>
                                          {uploaded ? (
                                            <Badge className="text-xs bg-green-500">{t('pages:applicants.profile.workflowTab.uploaded')}</Badge>
                                          ) : (
                                            <Badge variant="outline" className="text-xs border-red-400 text-red-500">{t('pages:applicants.profile.workflowTab.missing')}</Badge>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>

                              {/* Approval */}
                              <div>
                                <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">{t('pages:applicants.profile.workflowTab.stageApproval')}</p>
                                {isApproved ? (
                                  <div className="flex items-center gap-2 p-2 rounded-md border bg-green-50 border-green-200">
                                    <Badge className="bg-green-500 text-xs">{t('pages:applicants.profile.workflowTab.approved')}</Badge>
                                    <span className="text-xs text-muted-foreground">
                                      {t('pages:applicants.profile.workflowTab.approvedBy', { name: `${latestApproval.approvedBy?.firstName ?? ''} ${latestApproval.approvedBy?.lastName ?? ''}`.trim() })}
                                      {' · '}{formatDate(latestApproval.decidedAt ?? latestApproval.createdAt)}
                                    </span>
                                    {latestApproval.notes && <span className="text-xs text-muted-foreground italic">— "{latestApproval.notes}"</span>}
                                  </div>
                                ) : stage.assignedUsers?.length > 0 ? (
                                  <div className="space-y-2">
                                    <div className="space-y-1">
                                      {stage.assignedUsers.map((u: any) => (
                                        <div key={u.userId} className="flex items-center gap-2 text-xs text-muted-foreground">
                                          <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold">
                                            {u.user?.firstName?.[0]}{u.user?.lastName?.[0]}
                                          </div>
                                          {u.user?.firstName} {u.user?.lastName}
                                          <span className="text-[11px] px-1.5 py-0.5 bg-muted rounded">{u.role}</span>
                                        </div>
                                      ))}
                                    </div>
                                    {(canEdit('applicants') || currentUserIsApprover) && progress && (
                                      <Button
                                        size="sm"
                                        onClick={() => handleApproveCandidateStage(progress.id)}
                                        disabled={approvingProgressId === progress.id}
                                        className="h-7 text-xs"
                                      >
                                        {approvingProgressId === progress.id ? t('pages:applicants.profile.workflowTab.approving') : t('pages:applicants.profile.workflowTab.approveStage')}
                                      </Button>
                                    )}
                                  </div>
                                ) : (
                                  <div className="space-y-2">
                                    <p className="text-xs text-muted-foreground">{t('pages:applicants.profile.workflowTab.noApprovers')}</p>
                                    {canEdit('applicants') && progress && (
                                      <Button
                                        size="sm"
                                        onClick={() => handleApproveCandidateStage(progress.id)}
                                        disabled={approvingProgressId === progress.id}
                                        className="h-7 text-xs"
                                      >
                                        {approvingProgressId === progress.id ? t('pages:applicants.profile.workflowTab.approving') : t('pages:applicants.profile.workflowTab.approveStage')}
                                      </Button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Compliance */}
        <TabsContent value="compliance">
          <Card>
            <CardHeader><CardTitle>{t('pages:applicants.profile.complianceTab.title')}</CardTitle></CardHeader>
            <CardContent>
              {documents.length === 0 ? (
                <p className="text-muted-foreground">{t('pages:applicants.profile.complianceTab.empty')}</p>
              ) : (
                <div className="space-y-3">
                  {documents.map((doc: any) => {
                    const daysLeft = doc.expiryDate
                      ? Math.ceil((new Date(doc.expiryDate).getTime() - Date.now()) / 86400000)
                      : null;
                    return (
                      <div key={doc.id} className="flex items-center justify-between p-4 border rounded-lg">
                        <div>
                          <p className="font-medium">{getDocumentDisplayName(doc.name, doc.documentType?.name)}</p>
                          <p className="text-sm text-muted-foreground">{doc.documentType?.name}</p>
                        </div>
                        <div className="text-end">
                          <Badge variant="outline" className={docStatusClass(doc.status)}>
                            {enumLabel('documentStatus', doc.status)}
                          </Badge>
                          {daysLeft !== null && (
                            <p className={`text-xs mt-1 ${daysLeft <= 0 ? 'text-[#EF4444]' : daysLeft <= 30 ? 'text-[#F59E0B]' : 'text-muted-foreground'}`}>
                              {daysLeft <= 0
                                ? t('pages:applicants.profile.complianceTab.expiredAgo', { count: Math.abs(daysLeft) })
                                : t('pages:applicants.profile.complianceTab.daysRemaining', { count: daysLeft })}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Financial — Transaction Ledger */}
        {isFinanceOrAdmin && (
          <TabsContent value="financial">
            {applicantData?.tier !== 'CANDIDATE' ? (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="w-5 h-5 text-emerald-600" />{t('pages:applicants.profile.financialTab.title')}
                  </CardTitle>
                  <Badge className="bg-amber-100 text-amber-800">{t('pages:applicants.profile.financialTab.candidatesOnlyBadge')}</Badge>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-sm">
                    {t('pages:applicants.profile.financialTab.candidatesOnlyBody')}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-6">
                {/* Bank / Tax details card (retained for reference) */}
                {financialProfile && (
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                      <CardTitle className="text-base flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-emerald-600" />{t('pages:applicants.profile.financialTab.bankTitle')}
                      </CardTitle>
                      <Button
                        size="sm" variant="outline"
                        onClick={() => {
                          if (!id) return;
                          setSavingFinancial(true);
                          applicantsApi.upsertFinancialProfile(id, financialForm)
                            .then((saved: any) => { setFinancialProfile(saved); toast.success(t('pages:applicants.profile.financialTab.saved')); })
                            .catch((err) => toast.error(apiError(err, t('pages:applicants.profile.financialTab.saveFailed'))))
                            .finally(() => setSavingFinancial(false));
                        }}
                        disabled={savingFinancial}
                      >
                        {savingFinancial ? t('pages:applicants.profile.financialTab.saving') : t('pages:applicants.profile.financialTab.save')}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {[
                          ['bankName', t('pages:applicants.profile.financialTab.bankName'), 'text'],
                          ['iban', t('pages:applicants.profile.financialTab.iban'), 'text'],
                          ['taxCode', t('pages:applicants.profile.financialTab.taxCode'), 'text'],
                          ['niNumber', t('pages:applicants.profile.financialTab.niNumber'), 'text'],
                          ['paymentMethod', t('pages:applicants.profile.financialTab.paymentMethod'), 'text'],
                        ].map(([field, label, type]) => (
                          <div key={field} className="space-y-1">
                            <Label className="text-xs">{label}</Label>
                            <Input
                              type={type as any}
                              value={financialForm[field] ?? ''}
                              onChange={e => setFinancialForm((f: any) => ({ ...f, [field]: e.target.value }))}
                            />
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}
                {/* Transaction ledger */}
                <FinancialRecordsTab
                  entityType="APPLICANT"
                  entityId={id!}
                  entityName={applicantData?.fullName}
                  canWrite={canEdit('applicants')}
                  canChangeStatus={can('finance', 'status')}
                />
              </div>
            )}
          </TabsContent>
        )}

        {/* Agency History */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="w-5 h-5" />{t('pages:applicants.profile.historyTab.title')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {historyLoading ? (
                <p className="text-muted-foreground">{t('pages:applicants.profile.historyTab.loading')}</p>
              ) : agencyHistory.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('pages:applicants.profile.historyTab.empty')}</p>
              ) : (
                <div className="space-y-3">
                  {agencyHistory.map((h: any) => (
                    <div key={h.id} className="flex items-start gap-4 p-4 border rounded-lg">
                      <div className="w-2 h-2 rounded-full bg-blue-500 mt-2 shrink-0" />
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <p className="font-medium">{h.agencyName}</p>
                          <span className="text-xs text-muted-foreground">
                            {formatDate(h.assignedAt)}
                            {h.removedAt && ` → ${formatDate(h.removedAt)}`}
                          </span>
                        </div>
                        {h.reason && <p className="text-sm text-muted-foreground mt-0.5">{t('pages:applicants.profile.historyTab.reason', { value: h.reason })}</p>}
                        {h.notes && <p className="text-sm text-muted-foreground mt-0.5">{h.notes}</p>}
                        {!h.removedAt && (
                          <Badge className="bg-green-100 text-green-800 mt-1" variant="outline">{t('pages:applicants.profile.historyTab.current')}</Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notes */}
        <TabsContent value="notes">
          <ProfileNotesList ownerType="APPLICANT" ownerId={id!} canWrite={canEdit('applicants')} />
        </TabsContent>
      </Tabs>

      {/* Promote Lead → Candidate Dialog. After a successful promotion
          the same modal flips into a confirmation panel that the user
          has to explicitly close — a toast alone is too ephemeral. */}
      {showConvertLeadDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="max-w-md w-full">
            {promoteSuccess ? (
              <>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-emerald-700">
                    <CheckCircle2 className="w-5 h-5" />{t('pages:applicants.profile.promoteDialog.successTitle')}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    <strong>{applicantData?.fullName}</strong>{' '}
                    {t('pages:applicants.profile.promoteDialog.successBody')}
                    {promoteSuccess.newCandidateNumber && (
                      <> {t('pages:applicants.profile.promoteDialog.newCandidateId')} <span className="font-mono font-semibold text-purple-700">{promoteSuccess.newCandidateNumber}</span>.</>
                    )}
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">
                    {t('pages:applicants.profile.promoteDialog.successFooter')}
                  </div>
                  <Button className="w-full bg-emerald-600 hover:bg-emerald-700" onClick={closePromoteDialog}>
                    {t('pages:applicants.profile.promoteDialog.done')}
                  </Button>
                </CardContent>
              </>
            ) : (
              <>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-emerald-600" />{t('pages:applicants.profile.promoteDialog.title')}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    <strong>{applicantData?.fullName}</strong>{' '}
                    {t('pages:applicants.profile.promoteDialog.intro')}
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Responsible agency picker — the backend accepts an
                      optional agencyId and falls back to the default
                      holding agency when left blank, so the operator
                      can promote in one click even without picking. */}
                  <div className="space-y-1.5">
                    <Label htmlFor="promote-agency" className="text-sm">{t('pages:applicants.profile.promoteDialog.responsibleAgency')}</Label>
                    <Select value={promoteAgencyId || '__default__'} onValueChange={(v) => setPromoteAgencyId(v === '__default__' ? '' : v)}>
                      <SelectTrigger id="promote-agency">
                        <SelectValue placeholder={t('pages:applicants.profile.promoteDialog.selectDefault')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__">
                          <span className="text-muted-foreground">{t('pages:applicants.profile.promoteDialog.useSystemDefault')}</span>
                        </SelectItem>
                        {agencies.map((a: any) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t('pages:applicants.profile.promoteDialog.agencyHelp')}
                    </p>
                  </div>
                  <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                    {t('pages:applicants.profile.promoteDialog.loggedNote')}
                  </div>
                  <div className="flex gap-3">
                    <Button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                      onClick={handleConvertLeadToCandidate}
                      disabled={convertingLead}
                    >
                      {convertingLead
                        ? <><Loader2 className="w-4 h-4 me-2 animate-spin" />{t('pages:applicants.profile.promoteDialog.promoting')}</>
                        : <><TrendingUp className="w-4 h-4 me-2" />{t('pages:applicants.profile.promoteDialog.confirmPromotion')}</>}
                    </Button>
                    <Button variant="outline" className="flex-1" onClick={closePromoteDialog} disabled={convertingLead}>
                      {t('pages:applicants.profile.promoteDialog.cancel')}
                    </Button>
                  </div>
                </CardContent>
              </>
            )}
          </Card>
        </div>
      )}

      {/* Convert to Employee Dialog */}
      {showConvertDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <Card className="max-w-xl w-full my-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-[#22C55E]" />
                {t('pages:applicants.profile.convertDialog.title')}
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {t('pages:applicants.profile.convertDialog.convertingPrefix')} <strong>{applicantData.fullName}</strong> {t('pages:applicants.profile.convertDialog.applicantTransferSuffix')}
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Read-only applicant info */}
              <div className="rounded-lg border bg-[#F8FAFC] p-4 grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">{t('pages:applicants.profile.convertDialog.name')} </span><span className="font-medium">{applicantData.fullName}</span></div>
                <div><span className="text-muted-foreground">{t('pages:applicants.profile.convertDialog.email')} </span><span className="font-medium">{applicantData.email}</span></div>
                <div><span className="text-muted-foreground">{t('pages:applicants.profile.convertDialog.phone')} </span><span className="font-medium">{formatPhoneDisplay(applicantData.phone)}</span></div>
                <div><span className="text-muted-foreground">{t('pages:applicants.profile.convertDialog.citizenship')} </span><span className="font-medium">{applicantData.nationality}</span></div>
              </div>

              {/* Address — required */}
              <div>
                <p className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                  <MapPin className="w-4 h-4 text-[#2563EB]" />{t('pages:applicants.profile.convertDialog.address')} <span className="text-[#EF4444]">*</span>
                </p>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="cv-addr1">{t('pages:applicants.profile.convertDialog.addressLine1')} <span className="text-[#EF4444]">*</span></Label>
                    <Input id="cv-addr1" className="mt-1" value={convertForm.addressLine1}
                      onChange={e => setConvertForm(p => ({ ...p, addressLine1: e.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="cv-addr2">{t('pages:applicants.profile.convertDialog.addressLine2')}</Label>
                    <Input id="cv-addr2" className="mt-1" value={convertForm.addressLine2}
                      onChange={e => setConvertForm(p => ({ ...p, addressLine2: e.target.value }))} />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label htmlFor="cv-city">{t('pages:applicants.profile.convertDialog.city')} <span className="text-[#EF4444]">*</span></Label>
                      <Input id="cv-city" className="mt-1" value={convertForm.city}
                        onChange={e => setConvertForm(p => ({ ...p, city: e.target.value }))} />
                    </div>
                    <div>
                      <Label htmlFor="cv-country">{t('pages:applicants.profile.convertDialog.country')} <span className="text-[#EF4444]">*</span></Label>
                      <Input id="cv-country" className="mt-1" value={convertForm.country}
                        onChange={e => setConvertForm(p => ({ ...p, country: e.target.value }))} />
                    </div>
                    <div>
                      <Label htmlFor="cv-post">{t('pages:applicants.profile.convertDialog.postalCode')} <span className="text-[#EF4444]">*</span></Label>
                      <Input id="cv-post" className="mt-1" value={convertForm.postalCode}
                        onChange={e => setConvertForm(p => ({ ...p, postalCode: e.target.value }))} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Optional extras */}
              <div>
                <p className="text-sm font-semibold mb-3">{t('pages:applicants.profile.convertDialog.additionalDetails')} <span className="text-muted-foreground font-normal">{t('pages:applicants.profile.convertDialog.optional')}</span></p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="cv-lic">{t('pages:applicants.profile.convertDialog.licenseNumber')}</Label>
                    <Input id="cv-lic" className="mt-1" value={convertForm.licenseNumber}
                      onChange={e => setConvertForm(p => ({ ...p, licenseNumber: e.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="cv-liccat">{t('pages:applicants.profile.convertDialog.licenseCategory')}</Label>
                    <Input id="cv-liccat" className="mt-1" value={convertForm.licenseCategory}
                      onChange={e => setConvertForm(p => ({ ...p, licenseCategory: e.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="cv-yoe">{t('pages:applicants.profile.convertDialog.yearsExperience')}</Label>
                    <Input id="cv-yoe" type="number" min={0} className="mt-1" value={convertForm.yearsExperience}
                      onChange={e => setConvertForm(p => ({ ...p, yearsExperience: e.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="cv-ec">{t('pages:applicants.profile.convertDialog.emergencyContact')}</Label>
                    <Input id="cv-ec" className="mt-1" value={convertForm.emergencyContact}
                      onChange={e => setConvertForm(p => ({ ...p, emergencyContact: e.target.value }))} />
                  </div>
                  <div className="col-span-2">
                    <Label htmlFor="cv-ep">{t('pages:applicants.profile.convertDialog.emergencyPhone')}</Label>
                    <Input id="cv-ep" className="mt-1" value={convertForm.emergencyPhone}
                      onChange={e => setConvertForm(p => ({ ...p, emergencyPhone: e.target.value }))} />
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-2 border-t">
                <Button
                  className="flex-1 bg-[#22C55E] hover:bg-[#16a34a]"
                  onClick={handleConvertToEmployee}
                  disabled={converting || !convertForm.addressLine1.trim() || !convertForm.city.trim() || !convertForm.country.trim() || !convertForm.postalCode.trim()}
                >
                  {converting
                    ? <><Loader2 className="w-4 h-4 me-2 animate-spin" />{t('pages:applicants.profile.convertDialog.converting')}</>
                    : <><UserPlus className="w-4 h-4 me-2" />{t('pages:applicants.profile.convertDialog.confirmConversion')}</>}
                </Button>
                <Button variant="outline" className="flex-1" onClick={() => setShowConvertDialog(false)} disabled={converting}>{t('pages:applicants.profile.convertDialog.cancel')}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Reject-document dialog — collects a required rejection reason
          when the reviewer clicks Reject on a PENDING document row. */}
      <Dialog open={rejectDocDialog.open} onOpenChange={open => !open && setRejectDocDialog(s => ({ ...s, open: false }))}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('pages:applicants.profile.rejectDocDialog.title')}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">{t('pages:applicants.profile.rejectDocDialog.rejecting')} <span className="font-medium text-foreground">{rejectDocDialog.docName}</span></p>
            <div className="space-y-2">
              <Label htmlFor="reject-doc-reason">{t('pages:applicants.profile.rejectDocDialog.reasonLabel')} <span className="text-destructive">*</span></Label>
              <Textarea id="reject-doc-reason" placeholder={t('pages:applicants.profile.rejectDocDialog.reasonPh')} value={rejectDocReason} onChange={e => setRejectDocReason(e.target.value)} rows={4} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDocDialog(s => ({ ...s, open: false }))}>{t('pages:applicants.profile.rejectDocDialog.cancel')}</Button>
            <Button className="bg-red-500 hover:bg-red-600 text-white" onClick={handleRejectDocSubmit} disabled={!!verifyingDocId || !rejectDocReason.trim()}>
              <XCircle className="w-4 h-4 me-2" />{verifyingDocId ? t('pages:applicants.profile.rejectDocDialog.rejecting2') : t('pages:applicants.profile.rejectDocDialog.confirmRejection')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRowInner({ label, value, fallback }: { label: string; value?: string | null; fallback: string }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="font-medium">{value || <span className="text-muted-foreground italic">{fallback}</span>}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  const { t } = useTranslation('pages');
  return <InfoRowInner label={label} value={value} fallback={t('applicants.profile.infoRow.notProvided')} />;
}
