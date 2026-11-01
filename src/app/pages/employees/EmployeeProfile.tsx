import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Edit, Mail, Phone, MapPin, Calendar, FileText, Shield, Briefcase, Clock, Award, GraduationCap, TrendingUp, ChevronRight, Trash2, Download, Upload, X, DollarSign, Plus, UserCircle, RefreshCw, Archive, ArchiveRestore, Paperclip } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { employeesApi, documentsApi, settingsApi, employeeWorkflowApi, agenciesApi, workflowApi, tenantsApi, getCurrentUser } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { FinancialRecordsTab } from '../../components/finance/FinancialRecordsTab';
import { ApplicationDataView } from '../../components/applicants/ApplicationDataView';
import { AttendanceSheet } from '../attendance/AttendanceSheet';
import { WorkHistoryTimeline } from '../../components/employees/WorkHistoryTimeline';
import { ContractsTimeline } from '../../components/employees/ContractsTimeline';
import { apiError } from '../../../i18n/apiError';
import { enumLabel } from '../../../i18n/enumLabel';
import { formatDate, formatCurrency } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';
import { Checkbox } from '../../components/ui/checkbox';
import { formatPhoneDisplay } from '../../data/phoneCodes';
import { getDocumentDisplayName } from '../../utils/documentDisplay';
import { ProfileNotesList } from '../../components/profile-notes/ProfileNotesList';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');

export function EmployeeProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete, canView, can } = usePermissions();
  const { t, i18n } = useTranslation(['pages', 'common']);
  const dir = i18n.dir();
  const currentUser = getCurrentUser();
  // Permission-based: matches the `finance:read` permission seeded on
  // Finance/HR Manager roles and ticked in the Roles UI for custom
  // roles. System Admin bypasses via usePermissions.
  const isFinanceOrAdmin = canView('finance');
  const [employee, setEmployee] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<string>('overview');
  const scrollToAppSection = (sectionId: string) => {
    setActiveTab('application');
    requestAnimationFrame(() => {
      // The Application tab content needs a frame to mount before the
      // target node is in the DOM. Fall back to a short retry so the
      // scroll still fires if the lazy render takes a bit longer.
      const tryScroll = (attempts: number) => {
        const el = document.getElementById(sectionId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if (attempts > 0) setTimeout(() => tryScroll(attempts - 1), 60);
      };
      tryScroll(5);
    });
  };
  const [documents, setDocuments] = useState<any[]>([]);
  const [workflow, setWorkflow] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [docTypes, setDocTypes] = useState<any[]>([]);
  const [, setAllStages] = useState<any[]>([]);
  const [agencies, setAgencies] = useState<any[]>([]);
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  const isPlatformSuper = (currentUser as any)?.platformAdmin?.level === 'SUPER';
  const [changingAgency, setChangingAgency] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadForm, setUploadForm] = useState({ documentTypeId: '', name: '', issueDate: '', expiryDate: '', documentNumber: '', issuer: '' });
  // "Open-ended" toggle — for work contracts and other documents with
  // no end date. When ticked we clear+disable the expiry field and
  // omit expiryDate from the upload payload.
  const [uploadNoExpiry, setUploadNoExpiry] = useState(false);
  const [financialProfile, setFinancialProfile] = useState<any>(null);
  // Documents tab — archive view + renew dialog.
  const [docArchivedView, setDocArchivedView] = useState<'active' | 'archived' | 'all'>('active');
  const [renewDialog, setRenewDialog] = useState<{ open: boolean; doc: any | null }>({ open: false, doc: null });
  const [renewForm, setRenewForm] = useState({ name: '', issueDate: '', expiryDate: '', documentNumber: '', issuer: '', issueCountry: '', notes: '' });
  const [renewFile, setRenewFile] = useState<File | null>(null);
  const [renewNoExpiry, setRenewNoExpiry] = useState(false);
  const [renewing, setRenewing] = useState(false);

  // Recruitment workflow assignment (single)
  const [, setAssignment] = useState<any>(null);
  const [, setAllWorkflows] = useState<any[]>([]);

  const canManageAgencyAccess = currentUser?.role === 'System Admin' || currentUser?.role === 'HR Manager';
  const [agencyAccess, setAgencyAccess] = useState<any[]>([]);
  const [grantAgencyId, setGrantAgencyId] = useState<string>('');
  const [grantNotes, setGrantNotes] = useState<string>('');
  const [grantBusy, setGrantBusy] = useState(false);

  const loadAgencyAccess = () => {
    if (!id || !canManageAgencyAccess) return;
    employeesApi.listAgencyAccess(id)
      .then((res: any) => setAgencyAccess(Array.isArray(res) ? res : (res?.data ?? [])))
      .catch(() => setAgencyAccess([]));
  };

  const handleGrantAccess = async (
    agencyId: string,
    flags: { canView: boolean; canEdit: boolean },
    notes?: string,
  ) => {
    if (!id || !agencyId) return;
    setGrantBusy(true);
    try {
      await employeesApi.grantAgencyAccess(id, agencyId, {
        canView: flags.canView,
        canEdit: flags.canEdit,
        notes,
      });
      loadAgencyAccess();
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.agencyAccess.toast.updateFailed')));
    } finally {
      setGrantBusy(false);
    }
  };

  const handleToggleAccess = async (
    agencyId: string,
    next: { canView: boolean; canEdit: boolean },
  ) => {
    if (!id) return;
    if (!next.canView && !next.canEdit) {
      const ok = await confirm({
        title: t('pages:employees.profile.agencyAccess.confirmRevokeAll.title'),
        description: t('pages:employees.profile.agencyAccess.confirmRevokeAll.description'),
        confirmText: t('pages:employees.profile.agencyAccess.confirmRevokeAll.confirm'),
        tone: 'destructive',
      });
      if (!ok) return;
    }
    try {
      await employeesApi.grantAgencyAccess(id, agencyId, next);
      toast.success(t('pages:employees.profile.agencyAccess.toast.updated'));
      loadAgencyAccess();
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.agencyAccess.toast.updateFailed')));
    }
  };

  const handleRevokeAccess = async (agencyId: string, agencyName?: string) => {
    if (!id) return;
    const ok = await confirm({
      title: t('pages:employees.profile.agencyAccess.confirmRevoke.title'),
      description: t('pages:employees.profile.agencyAccess.confirmRevoke.description', {
        agency: agencyName || t('pages:employees.profile.agencyAccess.confirmRevoke.fallbackAgency'),
      }),
      confirmText: t('pages:employees.profile.agencyAccess.confirmRevoke.confirm'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await employeesApi.revokeAgencyAccess(id, agencyId);
      toast.success(t('pages:employees.profile.agencyAccess.toast.revoked'));
      loadAgencyAccess();
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.agencyAccess.toast.revokeFailed')));
    }
  };

  const loadRecruitmentWorkflow = () => {
    workflowApi.getEmployeeAssignment(id!).then(res => setAssignment(res ?? null)).catch(() => {});
  };

  const loadDocs = (view: 'active' | 'archived' | 'all' = docArchivedView) => {
    employeesApi.getDocuments(id!, view).then(docs => setDocuments(Array.isArray(docs) ? docs : [])).catch(() => {});
  };

  // Reload when the archive view changes.
  useEffect(() => { if (id) loadDocs(docArchivedView); }, [docArchivedView]);

  const handleArchiveDoc = async (doc: any) => {
    if (!(await confirm({
      title: t('pages:employees.profile.documents.archiveTitle', { defaultValue: 'Archive document?' }),
      description: t('pages:employees.profile.documents.archiveBody', {
        defaultValue: '"{{name}}" will be marked No Longer Valid — kept in history but removed from the active list.',
        name: doc.name,
      }),
      confirmText: t('pages:employees.profile.documents.archive', { defaultValue: 'Archive' }),
    }))) return;
    try {
      await documentsApi.archive(doc.id);
      toast.success(t('pages:employees.profile.documents.archived', { defaultValue: 'Document archived' }));
      loadDocs();
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.documents.archiveFailed', { defaultValue: 'Failed to archive' })));
    }
  };

  const handleUnarchiveDoc = async (doc: any) => {
    try {
      await documentsApi.unarchive(doc.id);
      toast.success(t('pages:employees.profile.documents.unarchived', { defaultValue: 'Document restored to active' }));
      loadDocs();
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.documents.unarchiveFailed', { defaultValue: 'Failed to restore' })));
    }
  };

  const openRenewDoc = (doc: any) => {
    setRenewForm({
      name: `${doc.name} (Renewal)`, issueDate: '', expiryDate: '',
      documentNumber: doc.documentNumber ?? '', issuer: doc.issuer ?? '', issueCountry: doc.issueCountry ?? '', notes: '',
    });
    setRenewFile(null);
    setRenewNoExpiry(false);
    setRenewDialog({ open: true, doc });
  };

  const handleRenewDoc = async () => {
    if (!renewFile) { toast.error(t('pages:employees.profile.documents.renewFileRequired', { defaultValue: 'Please attach the new document file.' })); return; }
    setRenewing(true);
    try {
      const fd = new FormData();
      fd.append('file', renewFile);
      if (renewForm.name)           fd.append('name', renewForm.name);
      if (renewForm.issueDate)      fd.append('issueDate', renewForm.issueDate);
      if (!renewNoExpiry && renewForm.expiryDate) fd.append('expiryDate', renewForm.expiryDate);
      if (renewForm.documentNumber) fd.append('documentNumber', renewForm.documentNumber);
      if (renewForm.issuer)         fd.append('issuer', renewForm.issuer);
      if (renewForm.issueCountry)   fd.append('issueCountry', renewForm.issueCountry);
      if (renewForm.notes)          fd.append('notes', renewForm.notes);
      await documentsApi.renew(renewDialog.doc.id, fd);
      toast.success(t('pages:employees.profile.documents.renewed', { defaultValue: 'Renewal created; previous document archived' }));
      setRenewDialog({ open: false, doc: null });
      setRenewFile(null);
      loadDocs();
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.documents.renewFailed', { defaultValue: 'Failed to renew' })));
    } finally {
      setRenewing(false);
    }
  };

  useEffect(() => {
    // Required: the employee itself. Best-effort: documents and
    // workflow data — these endpoints require their own permissions
    // (documents:read, workflow:read) which custom roles may not
    // hold. Pre-fix the four calls were Promise.all'd; one 403 on
    // any aux call rejected the whole batch, blew away `setEmployee`,
    // and the page rendered "Employee not found" + a "Forbidden
    // resource" toast even when the user could legitimately view the
    // employee. Now each aux call falls back to an empty default so a
    // permission gap on a side feature can't hide the whole record.
    employeesApi.get(id!)
      .then((emp) => {
        setEmployee(emp);
      })
      .catch((err) => toast.error(apiError(err, t('pages:employees.profile.toast.loadFailed'))))
      .finally(() => setLoading(false));

    employeesApi.getDocuments(id!)
      .then((docs) => setDocuments(Array.isArray(docs) ? docs : []))
      .catch(() => setDocuments([]));
    employeesApi.getWorkflow(id!)
      .then((wf) => setWorkflow(Array.isArray(wf) ? wf : []))
      .catch(() => setWorkflow([]));
    employeeWorkflowApi.getStages()
      .then((stages) => setAllStages(Array.isArray(stages) ? stages : []))
      .catch(() => setAllStages([]));
  }, [id, t]);

  useEffect(() => {
    settingsApi.getDocumentTypes().then(setDocTypes).catch(() => {});
    agenciesApi.list({ limit: 200 }).then((res: any) => setAgencies(res?.data ?? [])).catch(() => {});
    if (isPlatformSuper) {
      tenantsApi.list({ limit: 500 })
        .then((res: any) => setTenants((Array.isArray(res?.data) ? res.data : []).map((r: any) => ({ id: r.id, name: r.name }))))
        .catch(() => {});
    }
    if (id && isFinanceOrAdmin) {
      employeesApi.getFinancialProfile(id).then(setFinancialProfile).catch(() => {});
    }
    if (id) {
      loadRecruitmentWorkflow();
      workflowApi.list().then(res => setAllWorkflows(Array.isArray(res) ? res : [])).catch(() => {});
      loadAgencyAccess();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleUpload = async () => {
    if (!uploadFile) { toast.error(t('pages:employees.profile.documents.toast.fileRequired')); return; }
    if (!uploadForm.documentTypeId) { toast.error(t('pages:employees.profile.documents.toast.typeRequired')); return; }
    if (!uploadForm.name.trim()) { toast.error(t('pages:employees.profile.documents.toast.nameRequired')); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('name', uploadForm.name);
      fd.append('documentTypeId', uploadForm.documentTypeId);
      fd.append('entityType', 'EMPLOYEE');
      fd.append('entityId', id!);
      if (uploadForm.issueDate) fd.append('issueDate', uploadForm.issueDate);
      if (!uploadNoExpiry && uploadForm.expiryDate) fd.append('expiryDate', uploadForm.expiryDate);
      if (uploadForm.documentNumber) fd.append('documentNumber', uploadForm.documentNumber);
      if (uploadForm.issuer) fd.append('issuer', uploadForm.issuer);
      await documentsApi.upload(fd);
      toast.success(t('pages:employees.profile.documents.toast.uploaded'));
      setShowUpload(false);
      setUploadFile(null);
      setUploadForm({ documentTypeId: '', name: '', issueDate: '', expiryDate: '', documentNumber: '', issuer: '' });
      setUploadNoExpiry(false);
      loadDocs();
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.documents.toast.uploadFailed')));
    } finally {
      setUploading(false);
    }
  };


  const handleAgencyChange = async (value: string) => {
    if (!id) return;
    const newAgencyId = value === '__none__' ? null : value;
    setChangingAgency(true);
    try {
      const updated = await employeesApi.update(id, { agencyId: newAgencyId });
      setEmployee((prev: any) => ({ ...prev, agencyId: updated.agencyId, agency: updated.agency }));
      toast.success(t('pages:employees.profile.toast.agencyUpdated'));
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.toast.agencyFailed')));
    } finally {
      setChangingAgency(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({
      title: t('pages:employees.profile.confirmDelete.title'),
      description: t('pages:employees.profile.confirmDelete.description', { name: `${employee?.firstName} ${employee?.lastName}` }),
      confirmText: t('pages:employees.profile.confirmDelete.confirm'), tone: 'destructive',
    }))) return;
    try {
      await employeesApi.delete(id!);
      toast.success(t('pages:employees.profile.toast.deleted'));
      navigate('/dashboard/employees');
    } catch (err) {
      toast.error(apiError(err, t('pages:employees.profile.toast.deleteFailed')));
    }
  };

  const statusBadgeClass = (status: string) => {
    if (status === 'ACTIVE') return 'bg-[#22C55E]';
    if (status === 'PENDING') return 'bg-[#F59E0B]';
    if (status === 'ONBOARDING') return 'bg-[#2563EB]';
    if (status === 'ON_LEAVE') return 'bg-[#8B5CF6]';
    return 'bg-gray-500';
  };

  const docStatusClass = (status: string) => {
    if (status === 'VERIFIED') return 'bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]';
    if (status === 'EXPIRING_SOON') return 'bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]';
    if (status === 'EXPIRED' || status === 'REJECTED') return 'bg-[#FEE2E2] text-[#EF4444] border-[#EF4444]';
    return 'bg-[#F8FAFC] text-[#0F172A] border-[#E2E8F0]';
  };

  const validDocs = documents.filter(d => d.status === 'VERIFIED').length;
  const expiringSoon = documents.filter(d => d.status === 'EXPIRING_SOON').length;

  const dash = '—';

  if (loading) return <div className="p-8 text-muted-foreground">{t('pages:employees.profile.loading')}</div>;
  if (!employee) return <div className="p-8">{t('pages:employees.profile.notFound')}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/employees"><ArrowLeft className="w-5 h-5 rtl:rotate-180" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('pages:employees.profile.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('pages:employees.profile.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit('employees') && (
            <Button asChild>
              <Link to={`/dashboard/employees/${id}/edit`}>
                <Edit className="w-4 h-4 me-2" />{t('pages:employees.profile.editProfile')}
              </Link>
            </Button>
          )}
          {canDelete('employees') && (
            <Button variant="outline" className="text-[#EF4444] border-[#EF4444]" onClick={handleDelete}>
              <Trash2 className="w-4 h-4 me-2" />{t('pages:employees.profile.delete')}
            </Button>
          )}
        </div>
      </div>

      {/* Header Card */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start gap-6">
            <div className="w-24 h-24 rounded-full overflow-hidden flex-shrink-0">
              {employee.photoUrl ? (
                <img
                  src={employee.photoUrl.startsWith('http') ? employee.photoUrl : `${(import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '')}${employee.photoUrl}`}
                  alt={`${employee.firstName} ${employee.lastName}`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-[#EFF6FF] flex items-center justify-center text-[#2563EB] text-3xl font-semibold">
                  {employee.firstName?.[0]}{employee.lastName?.[0]}
                </div>
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-2xl font-semibold text-[#0F172A]">
                    {employee.firstName} {employee.lastName}
                  </h2>
                  <p className="text-muted-foreground mt-1">{t('pages:employees.profile.employeeId', { id: employee.employeeNumber ?? dash })}</p>
                </div>
                <Badge className={statusBadgeClass(employee.status)}>
                  {enumLabel('employeeStatus', employee.status)}
                </Badge>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{t('pages:employees.profile.header.email')}</p>
                    <p className="text-sm font-medium">{employee.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{t('pages:employees.profile.header.phone')}</p>
                    <p className="text-sm font-medium">{formatPhoneDisplay(employee.phone)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{t('pages:employees.profile.header.citizenship')}</p>
                    <p className="text-sm font-medium">{employee.nationality}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{t('pages:employees.profile.header.joined')}</p>
                    <p className="text-sm font-medium">{formatDate(employee.createdAt)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <UserCircle className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{t('pages:employees.profile.header.createdBy')}</p>
                    {employee.source === 'SELF_APPLIED' ? (
                      <span className="inline-flex items-center text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-0.5">
                        {t('pages:employees.profile.selfApplied')}
                      </span>
                    ) : employee.createdBy ? (
                      <p className="text-sm font-medium">
                        {[employee.createdBy.firstName, employee.createdBy.lastName].filter(Boolean).join(' ') || employee.createdBy.email}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">{t('pages:employees.profile.unknownLegacy')}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Application Quick Nav — jumps to the Application tab and
          scrolls to the requested section in the rendered
          ApplicationDataView. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t('pages:applicants.profile.quickNav.travel'),         icon: FileText,      target: 'section-travel' },
          { label: t('pages:applicants.profile.quickNav.driving'),        icon: Award,         target: 'section-driving' },
          { label: t('pages:applicants.profile.quickNav.education'),      icon: GraduationCap, target: 'section-education' },
          { label: t('pages:applicants.profile.quickNav.workExperience'), icon: Briefcase,     target: 'section-work-experience' },
        ].map(({ label, icon: Icon, target }) => (
          <Button key={label} variant="outline" className="justify-between" onClick={() => scrollToAppSection(target)}>
            <div className="flex items-center gap-2"><Icon className="w-4 h-4" /><span>{label}</span></div>
            <ChevronRight className="w-4 h-4 rtl:rotate-180" />
          </Button>
        ))}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6" dir={dir}>
        <TabsList>
          <TabsTrigger value="overview">{t('pages:employees.profile.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="application">{t('pages:employees.profile.tabs.application')}</TabsTrigger>
          <TabsTrigger value="documents">{t('pages:employees.profile.tabs.documents', { count: documents.length })}</TabsTrigger>
          {can('attendance', 'read') && (
            <TabsTrigger value="attendance">{t('pages:employees.profile.tabs.attendance')}</TabsTrigger>
          )}
          <TabsTrigger value="contracts">{t('pages:employees.profile.tabs.contracts')}</TabsTrigger>
          <TabsTrigger value="compliance">{t('pages:employees.profile.tabs.compliance')}</TabsTrigger>
          {isFinanceOrAdmin && (
            <TabsTrigger value="financial">
              <DollarSign className="w-3 h-3 me-1" />{t('pages:employees.profile.tabs.financial')}
            </TabsTrigger>
          )}
          <TabsTrigger value="notes">{t('pages:employees.profile.tabs.notes')}</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle>{t('pages:employees.profile.personal.title')}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  {[
                    [t('pages:employees.profile.personal.fullName'), `${employee.firstName} ${employee.lastName}`],
                    [t('pages:employees.profile.personal.dateOfBirth'), employee.dateOfBirth ? formatDate(employee.dateOfBirth) : dash],
                    [t('pages:employees.profile.personal.citizenship'), employee.nationality],
                    [t('pages:employees.profile.personal.jobCategory'), employee.jobType?.name ?? dash],
                    [t('pages:employees.profile.personal.licenseNumber'), employee.licenseNumber ?? dash],
                    [t('pages:employees.profile.personal.licenseCategory'), employee.licenseCategory ?? dash],
                    [t('pages:employees.profile.personal.yearsExperience'), t('pages:employees.profile.personal.yearsValue', { count: employee.yearsExperience ?? 0 })],
                    [t('pages:employees.profile.personal.address'), `${employee.addressLine1}${employee.addressLine2 ? ', ' + employee.addressLine2 : ''}`],
                    [t('pages:employees.profile.personal.city'), employee.city],
                    [t('pages:employees.profile.personal.country'), employee.country],
                    [t('pages:employees.profile.personal.postalCode'), employee.postalCode],
                    employee.emergencyContact ? [t('pages:employees.profile.personal.emergencyContact'), `${employee.emergencyContact} · ${formatPhoneDisplay(employee.emergencyPhone)}`] : null,
                  ].filter(Boolean).map(([label, value]: any) => (
                    <div key={label}>
                      <p className="text-sm text-muted-foreground">{label}</p>
                      <p className="font-medium">{value}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card>
                <CardHeader><CardTitle>{t('pages:employees.profile.stats.title')}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  {[
                    { icon: FileText, color: 'text-[#2563EB]', bg: 'bg-[#EFF6FF]', value: documents.length, label: t('pages:employees.profile.stats.documents') },
                    { icon: Shield, color: 'text-[#22C55E]', bg: 'bg-[#F0FDF4]', value: validDocs, label: t('pages:employees.profile.stats.validDocs') },
                    { icon: Clock, color: 'text-[#F59E0B]', bg: 'bg-[#FEF3C7]', value: expiringSoon, label: t('pages:employees.profile.stats.expiringSoon') },
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

              {canEdit('employees') && (
                <Card>
                  <CardHeader><CardTitle>{t('pages:employees.profile.agency.title')}</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {employee.agency && (
                      <div className="flex items-center gap-3 pb-3 border-b">
                        <div className="w-8 h-8 rounded-lg bg-[#F8FAFC] flex items-center justify-center">
                          <Briefcase className="w-4 h-4 text-[#2563EB]" />
                        </div>
                        <p className="font-medium text-sm">{employee.agency.name}</p>
                      </div>
                    )}
                    <Select
                      value={employee.agencyId ?? '__none__'}
                      onValueChange={handleAgencyChange}
                      disabled={changingAgency}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('pages:employees.profile.agency.noAgency')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t('pages:employees.profile.agency.noAgency')}</SelectItem>
                        {agencies.map((a: any) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </CardContent>
                </Card>
              )}

              {isPlatformSuper && (
                <Card>
                  <CardHeader><CardTitle>{t('tenantFilter.tenant', { ns: 'pages', defaultValue: 'Tenant' })}</CardTitle></CardHeader>
                  <CardContent>
                    {(() => {
                      const tenantId = (employee as any).tenantId ?? employee.agency?.tenantId ?? '';
                      const name = tenants.find(tn => tn.id === tenantId)?.name ?? (tenantId || '—');
                      return (
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-[#F8FAFC] flex items-center justify-center">
                            <Briefcase className="w-4 h-4 text-[#2563EB]" />
                          </div>
                          <p className="font-medium text-sm">{name}</p>
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>
              )}

              {canManageAgencyAccess && (
                <Card>
                  <CardHeader>
                    <CardTitle>{t('pages:employees.profile.agencyAccess.title')}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('pages:employees.profile.agencyAccess.subtitle')}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {employee.agencyId && (() => {
                      const ownGrant = agencyAccess.find((g: any) => g.agencyId === employee.agencyId);
                      const ownAgency = employee.agency ?? agencies.find((a: any) => a.id === employee.agencyId);
                      const canViewFlag = !!ownGrant?.canView;
                      const canEditFlag = !!ownGrant?.canEdit;
                      return (
                        <div className="p-3 rounded-lg border bg-[#F8FAFC] space-y-3">
                          <div className="flex items-center gap-2">
                            <Briefcase className="w-4 h-4 text-[#2563EB]" />
                            <p className="font-medium text-sm">{ownAgency?.name ?? t('pages:employees.profile.agencyAccess.ownAgencyFallback')}</p>
                            <Badge variant="outline" className="ms-auto text-[10px]">{t('pages:employees.profile.agencyAccess.originBadge')}</Badge>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="flex items-center gap-2 cursor-pointer text-sm">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-input"
                                checked={canViewFlag}
                                disabled={grantBusy}
                                onChange={e => handleToggleAccess(employee.agencyId, { canView: e.target.checked, canEdit: canEditFlag })}
                              />
                              <span>{t('pages:employees.profile.agencyAccess.view')}</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer text-sm">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-input"
                                checked={canEditFlag}
                                disabled={grantBusy}
                                onChange={e => handleToggleAccess(employee.agencyId, { canView: canViewFlag, canEdit: e.target.checked })}
                              />
                              <span>{t('pages:employees.profile.agencyAccess.edit')}</span>
                            </label>
                          </div>
                          {ownGrant?.grantedAt && (
                            <p className="text-[11px] text-muted-foreground">
                              {t('pages:employees.profile.agencyAccess.granted', { date: formatDate(ownGrant.grantedAt) })}
                            </p>
                          )}
                        </div>
                      );
                    })()}

                    {agencyAccess
                      .filter((g: any) => g.agencyId !== employee.agencyId)
                      .map((g: any) => (
                        <div key={g.agencyId} className="p-3 rounded-lg border space-y-3">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm truncate flex-1">{g.agency?.name ?? g.agencyId}</p>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                              onClick={() => handleRevokeAccess(g.agencyId, g.agency?.name)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="flex items-center gap-2 cursor-pointer text-sm">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-input"
                                checked={!!g.canView}
                                onChange={e => handleToggleAccess(g.agencyId, { canView: e.target.checked, canEdit: !!g.canEdit })}
                              />
                              <span>{t('pages:employees.profile.agencyAccess.view')}</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer text-sm">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-input"
                                checked={!!g.canEdit}
                                onChange={e => handleToggleAccess(g.agencyId, { canView: !!g.canView, canEdit: e.target.checked })}
                              />
                              <span>{t('pages:employees.profile.agencyAccess.edit')}</span>
                            </label>
                          </div>
                          {g.notes && <p className="text-xs text-muted-foreground truncate">{g.notes}</p>}
                        </div>
                      ))}

                    {agencies.some((a: any) => a.id !== employee.agencyId && !agencyAccess.some((g: any) => g.agencyId === a.id)) && (
                      <div className="pt-3 border-t space-y-3">
                        <Label className="text-xs">{t('pages:employees.profile.agencyAccess.grantSection')}</Label>
                        <Select value={grantAgencyId} onValueChange={setGrantAgencyId}>
                          <SelectTrigger>
                            <SelectValue placeholder={t('pages:employees.profile.agencyAccess.selectAgency')} />
                          </SelectTrigger>
                          <SelectContent>
                            {agencies
                              .filter((a: any) => a.id !== employee.agencyId && !agencyAccess.some((g: any) => g.agencyId === a.id))
                              .map((a: any) => (
                                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder={t('pages:employees.profile.agencyAccess.notesPh')}
                          value={grantNotes}
                          onChange={e => setGrantNotes(e.target.value)}
                        />
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={async () => {
                            await handleGrantAccess(grantAgencyId, { canView: true, canEdit: true }, grantNotes || undefined);
                            setGrantAgencyId('');
                            setGrantNotes('');
                          }}
                          disabled={!grantAgencyId || grantBusy}
                        >
                          <Plus className="w-4 h-4 me-1" />
                          {grantBusy ? t('pages:employees.profile.agencyAccess.granting') : t('pages:employees.profile.agencyAccess.grantButton')}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="application">
          <ApplicationDataView
            applicationData={employee.applicationData}
            fullName={[employee.firstName, employee.lastName].filter(Boolean).join(' ')}
          />
        </TabsContent>

        {/* Documents */}
        <TabsContent value="documents">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('pages:employees.profile.documents.title')}</CardTitle>
              <div className="flex items-center gap-2">
                {/* Archive view */}
                <Select value={docArchivedView} onValueChange={(v) => setDocArchivedView(v as 'active' | 'archived' | 'all')}>
                  <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{t('pages:employees.profile.documents.viewActive', { defaultValue: 'Active only' })}</SelectItem>
                    <SelectItem value="archived">{t('pages:employees.profile.documents.viewArchived', { defaultValue: 'Archived only' })}</SelectItem>
                    <SelectItem value="all">{t('pages:employees.profile.documents.viewAll', { defaultValue: 'Active + Archived' })}</SelectItem>
                  </SelectContent>
                </Select>
                {canEdit('employees') && (
                  <Button size="sm" onClick={() => setShowUpload(v => !v)} variant={showUpload ? 'outline' : 'default'}>
                    {showUpload
                      ? <><X className="w-4 h-4 me-1" />{t('pages:employees.profile.documents.cancel')}</>
                      : <><Upload className="w-4 h-4 me-1" />{t('pages:employees.profile.documents.uploadButton')}</>}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">

              {showUpload && (
                <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
                  <h4 className="font-medium text-sm">{t('pages:employees.profile.documents.newDocumentTitle')}</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:employees.profile.documents.documentType')} *</Label>
                      <Select value={uploadForm.documentTypeId} onValueChange={v => setUploadForm(f => ({ ...f, documentTypeId: v }))}>
                        <SelectTrigger><SelectValue placeholder={t('pages:employees.profile.documents.selectType')} /></SelectTrigger>
                        <SelectContent>{docTypes.map(dt => <SelectItem key={dt.id} value={dt.id}>{dt.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:employees.profile.documents.documentName')} *</Label>
                      <Input placeholder={t('pages:employees.profile.documents.documentNamePh')} value={uploadForm.name} onChange={e => setUploadForm(f => ({ ...f, name: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:employees.profile.documents.issueDate')}</Label>
                      <DateInput value={uploadForm.issueDate} onChange={e => setUploadForm(f => ({ ...f, issueDate: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:employees.profile.documents.expiryDate')}</Label>
                      <DateInput
                        value={uploadNoExpiry ? '' : uploadForm.expiryDate}
                        disabled={uploadNoExpiry}
                        onChange={e => setUploadForm(f => ({ ...f, expiryDate: e.target.value }))}
                      />
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none mt-1">
                        <Checkbox
                          checked={uploadNoExpiry}
                          onCheckedChange={(v) => {
                            const on = !!v;
                            setUploadNoExpiry(on);
                            if (on) setUploadForm(f => ({ ...f, expiryDate: '' }));
                          }}
                        />
                        {t('pages:employees.profile.documents.noExpiry', { defaultValue: 'No expiry date (open-ended)' })}
                      </label>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:employees.profile.documents.documentNumber')}</Label>
                      <Input placeholder={t('pages:employees.profile.documents.optionalPh')} value={uploadForm.documentNumber} onChange={e => setUploadForm(f => ({ ...f, documentNumber: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('pages:employees.profile.documents.issuer')}</Label>
                      <Input placeholder={t('pages:employees.profile.documents.optionalPh')} value={uploadForm.issuer} onChange={e => setUploadForm(f => ({ ...f, issuer: e.target.value }))} />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label className="text-xs">{t('pages:employees.profile.documents.fileLabel')} *</Label>
                      <Input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onChange={e => setUploadFile(e.target.files?.[0] ?? null)} />
                      {uploadFile && <p className="text-xs text-muted-foreground">{t('pages:employees.profile.documents.fileSize', { name: uploadFile.name, size: (uploadFile.size / 1024).toFixed(1) })}</p>}
                    </div>
                  </div>
                  <Button size="sm" onClick={handleUpload} disabled={uploading}>
                    <Upload className="w-4 h-4 me-1" />{uploading ? t('pages:employees.profile.documents.uploading') : t('pages:employees.profile.documents.upload')}
                  </Button>
                </div>
              )}

              {documents.length === 0 ? (
                <p className="text-muted-foreground">{t('pages:employees.profile.documents.empty')}</p>
              ) : (
                <div className="space-y-3">
                  {documents.map((doc: any) => (
                    <div key={doc.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-[#F8FAFC] transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                          <FileText className="w-5 h-5 text-[#2563EB]" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{getDocumentDisplayName(doc.name, doc.documentType?.name)}</p>
                            {doc.entityType === 'ATTENDANCE' && (
                              <Badge variant="outline" className="border-indigo-300 text-indigo-700 bg-indigo-50">
                                <Paperclip className="w-3 h-3 me-1" />{t('pages:employees.profile.documents.attendanceBadge', { defaultValue: 'Attendance' })}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">{t('pages:employees.profile.documents.fileMeta', { type: doc.documentType?.name ?? '', size: (doc.fileSize / 1024).toFixed(1) })}</p>
                          {doc.expiryDate && (
                            <p className="text-xs text-muted-foreground mt-1">{t('pages:employees.profile.documents.expires', { date: formatDate(doc.expiryDate) })}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={docStatusClass(doc.status)}>
                          {enumLabel('documentStatus', doc.status)}
                        </Badge>
                        {doc.archivedAt && (
                          <Badge variant="outline" className="border-slate-300 text-slate-600 bg-slate-100">
                            {t('pages:employees.profile.documents.archivedBadge', { defaultValue: 'Archived' })}
                          </Badge>
                        )}
                        {/* Renew — only for the employee's own documents (not
                            attendance proof files), when editable. */}
                        {canEdit('employees') && doc.entityType === 'EMPLOYEE' && !doc.archivedAt && (
                          <Button variant="ghost" size="sm" onClick={() => openRenewDoc(doc)} title={t('pages:employees.profile.documents.renew', { defaultValue: 'Renew' })}>
                            <RefreshCw className="w-4 h-4 me-1" />{t('pages:employees.profile.documents.renew', { defaultValue: 'Renew' })}
                          </Button>
                        )}
                        {canEdit('employees') && doc.entityType === 'EMPLOYEE' && (
                          doc.archivedAt ? (
                            <Button variant="ghost" size="sm" className="text-emerald-600 hover:text-emerald-700" onClick={() => handleUnarchiveDoc(doc)} title={t('pages:employees.profile.documents.unarchive', { defaultValue: 'Restore to active' })}>
                              <ArchiveRestore className="w-4 h-4" />
                            </Button>
                          ) : (
                            <Button variant="ghost" size="sm" className="text-amber-600 hover:text-amber-700" onClick={() => handleArchiveDoc(doc)} title={t('pages:employees.profile.documents.archive', { defaultValue: 'Archive (No longer valid)' })}>
                              <Archive className="w-4 h-4" />
                            </Button>
                          )
                        )}
                        <Button variant="ghost" size="sm" asChild>
                          <a href={`${doc.fileUrl?.startsWith('http') ? '' : API_BASE}${doc.fileUrl}`} target="_blank" rel="noopener noreferrer" download>
                            <Download className="w-4 h-4 me-1" />{t('pages:employees.profile.documents.download')}
                          </a>
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/dashboard/documents/${doc.id}`}>{t('pages:employees.profile.documents.view')}</Link>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Renew dialog — requires the new file; original auto-archives. */}
          <Dialog open={renewDialog.open} onOpenChange={open => !open && setRenewDialog(s => ({ ...s, open: false }))}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('pages:employees.profile.documents.renewTitle', { defaultValue: 'Renew document' })}</DialogTitle>
                <DialogDescription>
                  {t('pages:employees.profile.documents.renewHelp', {
                    defaultValue: 'Upload the new document. A new pending document is created and the previous one is archived automatically.',
                  })}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-1">
                <div>
                  <Label className="text-xs">{t('pages:employees.profile.documents.renewFileLabel', { defaultValue: 'New document file' })} *</Label>
                  <Input type="file" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" onChange={e => setRenewFile(e.target.files?.[0] ?? null)} />
                </div>
                <div><Label className="text-xs">{t('pages:employees.profile.documents.documentName')}</Label><Input value={renewForm.name} onChange={e => setRenewForm(p => ({ ...p, name: e.target.value }))} /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><Label className="text-xs">{t('pages:employees.profile.documents.issueDate')}</Label><DateInput value={renewForm.issueDate} onChange={e => setRenewForm(p => ({ ...p, issueDate: e.target.value }))} /></div>
                  <div>
                    <Label className="text-xs">{t('pages:employees.profile.documents.expiryDate')}</Label>
                    <DateInput value={renewNoExpiry ? '' : renewForm.expiryDate} disabled={renewNoExpiry} onChange={e => setRenewForm(p => ({ ...p, expiryDate: e.target.value }))} />
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none mt-1">
                      <Checkbox checked={renewNoExpiry} onCheckedChange={(v) => { const on = !!v; setRenewNoExpiry(on); if (on) setRenewForm(p => ({ ...p, expiryDate: '' })); }} />
                      {t('pages:employees.profile.documents.noExpiry', { defaultValue: 'No expiry date (open-ended)' })}
                    </label>
                  </div>
                </div>
                <div><Label className="text-xs">{t('pages:employees.profile.documents.documentNumber')}</Label><Input value={renewForm.documentNumber} onChange={e => setRenewForm(p => ({ ...p, documentNumber: e.target.value }))} /></div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRenewDialog({ open: false, doc: null })}>{t('pages:employees.profile.documents.cancel')}</Button>
                <Button onClick={handleRenewDoc} disabled={renewing || !renewFile}>
                  <RefreshCw className="w-4 h-4 me-1.5" />{t('pages:employees.profile.documents.createRenewal', { defaultValue: 'Create Renewal' })}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {can('attendance', 'read') && (
          <TabsContent value="attendance">
            <AttendanceSheet employeeId={id!} hideBackButton />
          </TabsContent>
        )}

        <TabsContent value="contracts" className="space-y-6">
          {/* Chronological contract records (start→end), auto-created
              from uploaded contract documents. */}
          <ContractsTimeline employeeId={id!} canWrite={canEdit('employees')} />
          {/* Post-hire event timeline (probation, termination, …). */}
          <WorkHistoryTimeline employeeId={id!} canWrite={canEdit('employees')} />
        </TabsContent>

        {/* Compliance */}
        <TabsContent value="compliance">
          <Card>
            <CardHeader><CardTitle>{t('pages:employees.profile.compliance.title')}</CardTitle></CardHeader>
            <CardContent>
              {documents.length === 0 ? (
                <p className="text-muted-foreground">{t('pages:employees.profile.compliance.empty')}</p>
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
                                ? t('pages:employees.profile.compliance.expiredAgo', { count: Math.abs(daysLeft) })
                                : t('pages:employees.profile.compliance.daysRemaining', { count: daysLeft })}
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

        {/* Financial */}
        {isFinanceOrAdmin && (
          <TabsContent value="financial" className="space-y-6">
            {financialProfile && (
              <Card className="border-blue-100">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base">{t('pages:employees.profile.financial.title')}</CardTitle>
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                      {t('pages:employees.profile.financial.fromCandidateBadge')}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('pages:employees.profile.financial.subtitle')}
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-sm">
                    {[
                      [t('pages:employees.profile.financial.bankName'), financialProfile.bankName],
                      [t('pages:employees.profile.financial.accountHolder'), financialProfile.accountHolder],
                      [t('pages:employees.profile.financial.accountNumber'), financialProfile.accountNumber],
                      [t('pages:employees.profile.financial.sortCode'), financialProfile.sortCode],
                      [t('pages:employees.profile.financial.iban'), financialProfile.iban],
                      [t('pages:employees.profile.financial.taxCode'), financialProfile.taxCode],
                      [t('pages:employees.profile.financial.niNumber'), financialProfile.niNumber],
                      [t('pages:employees.profile.financial.paymentMethod'), financialProfile.paymentMethod],
                      [t('pages:employees.profile.financial.salaryAgreed'), financialProfile.salaryAgreed != null
                        ? formatCurrency(Number(financialProfile.salaryAgreed), financialProfile.currency ?? 'GBP')
                        : null],
                    ].filter(([, v]) => v).map(([label, value]) => (
                      <div key={label as string}>
                        <p className="text-xs text-muted-foreground">{label}</p>
                        <p className="font-medium">{value}</p>
                      </div>
                    ))}
                    {financialProfile.notes && (
                      <div className="col-span-full">
                        <p className="text-xs text-muted-foreground">{t('pages:employees.profile.financial.notes')}</p>
                        <p className="text-sm">{financialProfile.notes}</p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <FinancialRecordsTab
              entityType="EMPLOYEE"
              entityId={id!}
              entityName={[employee?.firstName, employee?.lastName].filter(Boolean).join(' ')}
              canWrite={canEdit('employees')}
              canChangeStatus={can('finance', 'status')}
            />
          </TabsContent>
        )}

        {/* Notes */}
        <TabsContent value="notes">
          <ProfileNotesList ownerType="EMPLOYEE" ownerId={id!} canWrite={canEdit('employees')} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
