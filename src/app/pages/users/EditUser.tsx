import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ShieldOff, Unlock, RefreshCw, Mail, Camera, X } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { usePermissions } from '../../hooks/usePermissions';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Badge } from '../../components/ui/badge';
import { CountrySelect } from '../../components/ui/CountrySelect';
import { PhoneInput } from '../../components/ui/PhoneInput';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { usersApi, rolesApi, agenciesApi, authApi, getCurrentUser, resolveAssetUrl } from '../../services/api';
import { formatDate } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';

const GENDER_VALUES = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'];
const GENDER_KEYS: Record<string, string> = {
  MALE: 'male', FEMALE: 'female', OTHER: 'other', PREFER_NOT_TO_SAY: 'preferNotToSay',
};
const LANGUAGES: { code: string; label: string }[] = [
  { code: 'English',    label: 'English' },
  { code: 'Slovenčina', label: 'Slovenčina' },
  { code: 'Deutsch',    label: 'Deutsch' },
  { code: 'Русский',    label: 'Русский' },
  { code: 'العربية',    label: 'العربية' },
  { code: 'Türkçe',     label: 'Türkçe' },
];
const TIMEZONES = [
  'UTC', 'Europe/London', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/Paris',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Bucharest', 'Europe/Kiev',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'Asia/Dubai', 'Asia/Riyadh',
];

const STATUS_VALUES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING', 'TERMINATED'];

type StatusStyle = {
  badge: string;
  card:  string;
  dot:   string;
};

const STATUS_STYLES: Record<string, StatusStyle> = {
  ACTIVE:     { badge: 'bg-emerald-500 text-white border-emerald-500', card: 'border-emerald-300 bg-emerald-50/60', dot: 'bg-emerald-500' },
  PENDING:    { badge: 'bg-amber-500 text-white border-amber-500',     card: 'border-amber-300 bg-amber-50/60',     dot: 'bg-amber-500' },
  INACTIVE:   { badge: 'bg-slate-500 text-white border-slate-500',     card: 'border-slate-300 bg-slate-50',         dot: 'bg-slate-500' },
  SUSPENDED:  { badge: 'bg-red-500 text-white border-red-500',         card: 'border-red-300 bg-red-50/60',         dot: 'bg-red-500' },
  TERMINATED: { badge: 'bg-rose-700 text-white border-rose-700',       card: 'border-rose-300 bg-rose-50/60',       dot: 'bg-rose-700' },
};

function getStatusStyle(status: string): StatusStyle {
  return STATUS_STYLES[status] ?? STATUS_STYLES.INACTIVE;
}

export function EditUser() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canEdit } = usePermissions();
  const { id } = useParams();
  const navigate = useNavigate();
  const currentUser = getCurrentUser();
  const isAdminOrHR = currentUser?.role === 'System Admin' ||
    currentUser?.role === 'HR Manager' ||
    currentUser?.role?.toLowerCase().includes('admin') ||
    currentUser?.role?.toLowerCase().includes('hr');
  // Flipping the per-user manager override flags is a tenancy-model
  // control — System Admin only.
  const isSystemAdmin = currentUser?.role === 'System Admin';
  // Platform Admin Access card is restricted to SUPER PlatformAdmin viewers.
  const [viewerIsSuperPa, setViewerIsSuperPa] = useState(false);

  useEffect(() => {
    if (!currentUser?.id) return;
    usersApi.get(currentUser.id)
      .then((u: any) => setViewerIsSuperPa(u?.platformAdmin?.level === 'SUPER'))
      .catch(() => setViewerIsSuperPa(false));
  }, [currentUser?.id]);

  const [roles, setRoles] = useState<any[]>([]);
  const [agencies, setAgencies] = useState<any[]>([]);
  const tenantFilter = useSuperUserTenantFilter();
  // SUPER USER override — picks the tenant the user should belong to.
  // Initialised from the loaded user's agency.tenantId once data lands.
  const [tenantOverride, setTenantOverride] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const [userStatus, setUserStatus] = useState('');
  const [userNumber, setUserNumber] = useState<string | null>(null);
  const [existingPhotoUrl, setExistingPhotoUrl] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Approval + per-user manager override state for the "Agency
  // Manager Permissions" card rendered below the form for
  // System Admin viewing an approved agency user.
  const [approvalStatus, setApprovalStatus] = useState<string>('');
  const [allowManagerView, setAllowManagerView] = useState(true);
  const [allowManagerEdit, setAllowManagerEdit] = useState(false);
  const [allowManagerDelete, setAllowManagerDelete] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);

  const [form, setForm] = useState({
    // Identity
    firstName: '',
    middleName: '',
    lastName: '',
    email: '',
    // Work Information
    roleId: '',
    agencyId: '',
    jobTitle: '',
    department: '',
    startDate: '',
    status: '',
    // Personal Details
    dateOfBirth: '',
    gender: '',
    citizenship: '',
    phone: '',
    // Address
    addressLine1: '',
    addressLine2: '',
    city: '',
    country: '',
    postalCode: '',
    // Preferences
    preferredLanguage: '',
    timeZone: '',
  });

  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();

  useEffect(() => {
    Promise.all([
      usersApi.get(id!),
      rolesApi.list(),
      agenciesApi.list({ limit: 100 }),
    ]).then(([user, roleList, agencyPage]) => {
      setLockedAt(user.lockedAt ?? null);
      setUserStatus(user.status ?? 'ACTIVE');
      setUserNumber(user.userNumber ?? null);
      setExistingPhotoUrl(user.photoUrl ?? null);
      setForm({
        firstName: user.firstName ?? '',
        middleName: user.middleName ?? '',
        lastName: user.lastName ?? '',
        email: user.email ?? '',
        roleId: user.role?.id ?? '',
        agencyId: user.agency?.id ?? user.agencyId ?? '',
        jobTitle: user.jobTitle ?? '',
        department: user.department ?? '',
        startDate: user.startDate ? user.startDate.slice(0, 10) : '',
        status: user.status ?? 'ACTIVE',
        dateOfBirth: user.dateOfBirth ? user.dateOfBirth.slice(0, 10) : '',
        gender: user.gender ?? '',
        citizenship: user.citizenship ?? '',
        phone: user.phone ?? '',
        addressLine1: user.addressLine1 ?? '',
        addressLine2: user.addressLine2 ?? '',
        city: user.city ?? '',
        country: user.country ?? '',
        postalCode: user.postalCode ?? '',
        preferredLanguage: user.preferredLanguage ?? '',
        timeZone: user.timeZone ?? '',
      });
      setRoles(roleList ?? []);
      setAgencies(agencyPage?.data ?? []);
      // Seed the SUPER tenant override from the loaded user's agency.
      const loadedAg = (agencyPage?.data ?? []).find((a: any) => a.id === (user.agency?.id ?? user.agencyId));
      setTenantOverride(loadedAg?.tenantId ?? '');
      setApprovalStatus(user.approvalStatus ?? '');
      setAllowManagerView(user.allowManagerView !== false);
      setAllowManagerEdit(Boolean(user.allowManagerEdit));
      setAllowManagerDelete(Boolean(user.allowManagerDelete));
    }).catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  const handleManagerOverride = async (patch: { allowManagerView?: boolean; allowManagerEdit?: boolean; allowManagerDelete?: boolean }) => {
    if (!id) return;
    setSavingOverride(true);
    try {
      await usersApi.setManagerOverride(id, patch);
      if (typeof patch.allowManagerView === 'boolean') setAllowManagerView(patch.allowManagerView);
      if (typeof patch.allowManagerEdit === 'boolean') setAllowManagerEdit(patch.allowManagerEdit);
      if (typeof patch.allowManagerDelete === 'boolean') setAllowManagerDelete(patch.allowManagerDelete);
      toast.success(t('users.edit.permissionsUpdated'));
    } catch (err: any) {
      toast.error(apiError(err, t('users.edit.permissionsFailed')));
    } finally {
      setSavingOverride(false);
    }
  };

  if (loading) return <div className="p-8 text-muted-foreground">{tc('states.loading')}</div>;
  if (notFound) return <div className="p-8">{t('users.edit.notFound', { defaultValue: 'User not found' })}</div>;

  if (!canEdit('users')) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
        <ShieldOff className="w-12 h-12 opacity-30" />
        <p className="text-lg font-semibold text-[#0F172A]">{tc('permissions.accessDenied')}</p>
        <p className="text-sm">{tc('permissions.noPermission')}</p>
      </div>
    );
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(prev => ({ ...prev, [e.target.id]: e.target.value }));
    if (fieldErrs[e.target.id]) clearError(e.target.id);
  };

  const handleSelect = (field: string, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (fieldErrs[field]) clearError(field);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFieldErrors();
    if (!form.agencyId) {
      toast.error(t('users.edit.selectAgency'));
      return;
    }
    setSubmitting(true);
    try {
      // Normalise date inputs (YYYY-MM-DD) to full ISO 8601 datetimes so
      // backend class-validator's @IsISO8601 accepts them. Empty strings
      // are sent through as-is (the backend treats them as 'no change'
      // for optional fields).
      const toIso = (v: string | null | undefined): string | undefined => {
        if (!v) return undefined;
        if (v.includes('T')) return v; // already a full ISO string
        // YYYY-MM-DD → fix to UTC midnight.
        const d = new Date(`${v}T00:00:00.000Z`);
        return isNaN(d.getTime()) ? v : d.toISOString();
      };
      const payload = {
        ...form,
        startDate:   toIso(form.startDate),
        dateOfBirth: toIso(form.dateOfBirth),
      };
      await usersApi.update(id!, payload);
      if (photoFile) {
        setUploadingPhoto(true);
        try { await usersApi.uploadPhoto(id!, photoFile); }
        finally { setUploadingPhoto(false); }
      }
      toast.success(t('users.edit.updateSuccess'));
      navigate('/dashboard/users');
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, t('users.edit.updateFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnlockAccount = async () => {
    try {
      await usersApi.unlockUser(id!);
      setLockedAt(null);
      toast.success(t('users.edit.unlockSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('users.edit.unlockFailed')));
    }
  };

  const handleResetPassword = async () => {
    if (!(await confirm({
      title: t('users.edit.resetTitle'),
      description: t('users.edit.resetBody'),
      confirmText: t('users.edit.resetConfirm'),
    }))) return;
    try {
      await authApi.adminResetPassword(id!);
      toast.success(t('users.edit.resetSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('users.edit.resetFailed')));
    }
  };

  const handleResendActivation = async () => {
    try {
      await authApi.resendActivation(id!);
      toast.success(t('users.edit.activationResent'));
    } catch (err: any) {
      toast.error(apiError(err, t('users.edit.activationFailed')));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/users"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('users.edit.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('users.edit.subtitle')}</p>
        </div>
      </div>

      {/* Account Status — moved to top, with colors */}
      {(() => {
        const status = form.status || userStatus;
        const style = getStatusStyle(status);
        const label = status === 'PENDING'
          ? t('users.form.statusDesc.PENDING_LABEL')
          : t(`users.form.statusOptions.${status}`, { defaultValue: status });
        const description = t(`users.form.statusDesc.${status}`, { defaultValue: '' });
        return (
          <div className={`max-w-2xl rounded-lg border ${style.card} p-4 flex flex-wrap items-center gap-4`}>
            <div className="flex items-center gap-3 min-w-0">
              <span className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('users.edit.accountStatus')}</p>
                <Badge className={`${style.badge} mt-1`}>{label}</Badge>
              </div>
            </div>
            <p className="text-sm text-muted-foreground flex-1 min-w-[200px]">{description}</p>
            {isAdminOrHR && (
              <div className="space-y-1">
                <Label htmlFor="status-select" className="text-xs">{t('users.edit.changeStatus')}</Label>
                <Select value={form.status} onValueChange={val => handleSelect('status', val)}>
                  <SelectTrigger id="status-select" className={`w-44 font-medium ${style.badge} hover:opacity-90`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_VALUES.map(v => {
                      const s = getStatusStyle(v);
                      return (
                        <SelectItem key={v} value={v}>
                          <span className="inline-flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                            {t(`users.form.statusOptions.${v}`)}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        );
      })()}

      {/* Account Actions */}
      <div className="max-w-2xl flex flex-wrap gap-3">
        {lockedAt && (
          <div className="flex items-center gap-3 flex-1 p-3 rounded-lg border border-amber-300 bg-amber-50">
            <Badge className="bg-amber-500 shrink-0">{t('users.edit.lockedBadge')}</Badge>
            <span className="text-sm text-amber-800 flex-1">
              {t('users.edit.lockedSince', { date: formatDate(lockedAt) })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleUnlockAccount}
              className="border-amber-400 text-amber-700 hover:bg-amber-100 shrink-0"
            >
              <Unlock className="w-4 h-4 me-1" />
              {t('users.edit.unlock')}
            </Button>
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleResetPassword}
        >
          <RefreshCw className="w-4 h-4 me-2" />
          {t('users.edit.resetPassword')}
        </Button>
        {(userStatus === 'PENDING' || form.status === 'PENDING') && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleResendActivation}
          >
            <Mail className="w-4 h-4 me-2" />
            {t('users.edit.resendActivation')}
          </Button>
        )}
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-w-2xl space-y-6">

          <ValidationSummary errors={fieldErrs} />

          {/* Identity */}
          <Card>
            <CardHeader>
              <CardTitle>{t('users.form.identity')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Photo upload */}
              <div className="flex items-center gap-4">
                <div className="relative w-20 h-20 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
                  {photoPreview ? (
                    <img src={photoPreview} alt={t('users.form.preview')} className="w-full h-full object-cover" />
                  ) : existingPhotoUrl ? (
                    <img src={resolveAssetUrl(existingPhotoUrl)} alt={t('users.form.photoLabel')} className="w-full h-full object-cover" />
                  ) : (
                    <Camera className="w-7 h-7 text-gray-400" />
                  )}
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t('users.form.photoLabel')}</p>
                  <p className="text-xs text-muted-foreground">{t('users.form.photoHint')}</p>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => photoInputRef.current?.click()} disabled={uploadingPhoto}>
                      <Camera className="w-3.5 h-3.5 me-1" />
                      {photoPreview || existingPhotoUrl ? t('users.form.photoChange') : t('users.form.photoUpload')}
                    </Button>
                    {(photoPreview || existingPhotoUrl) && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setPhotoFile(null); setPhotoPreview(null); }}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setPhotoFile(file);
                      setPhotoPreview(URL.createObjectURL(file));
                    }}
                  />
                </div>
              </div>

              {userNumber && (
                <div className="space-y-2">
                  <Label>{t('users.form.userNumber')}</Label>
                  <Input value={userNumber} disabled className="bg-muted text-muted-foreground font-mono cursor-not-allowed" />
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">{t('users.form.firstName')}</Label>
                  <Input id="firstName" value={form.firstName} onChange={handleChange} required
                    aria-invalid={!!fieldErrs.firstName}
                    className={fieldErrs.firstName ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                  <FieldError errors={fieldErrs} name="firstName" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="middleName">{t('users.form.middleName')}</Label>
                  <Input id="middleName" value={form.middleName} onChange={handleChange}
                    aria-invalid={!!fieldErrs.middleName}
                    className={fieldErrs.middleName ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                  <FieldError errors={fieldErrs} name="middleName" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">{t('users.form.lastName')}</Label>
                <Input id="lastName" value={form.lastName} onChange={handleChange} required
                  aria-invalid={!!fieldErrs.lastName}
                  className={fieldErrs.lastName ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                <FieldError errors={fieldErrs} name="lastName" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">{t('users.form.email')}</Label>
                <Input id="email" type="email" value={form.email} onChange={handleChange} required
                  aria-invalid={!!fieldErrs.email}
                  className={fieldErrs.email ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                <FieldError errors={fieldErrs} name="email" />
              </div>
            </CardContent>
          </Card>

          {/* Work Information — admin-only fields shown to admins/HR */}
          <Card>
            <CardHeader>
              <CardTitle>{t('users.form.workInfo')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isAdminOrHR && (
                <>
                  <div className="space-y-2">
                    <Label>{t('users.form.role')}</Label>
                    <Select value={form.roleId} onValueChange={val => handleSelect('roleId', val)} required>
                      <SelectTrigger>
                        <SelectValue placeholder={t('users.form.selectRole')} />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((role: any) => (
                          <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {tenantFilter.isPlatformSuper && (
                    <div className="space-y-2">
                      <Label>Tenant</Label>
                      <Select
                        value={tenantOverride || '__none__'}
                        onValueChange={(v) => {
                          const next = v === '__none__' ? '' : v;
                          setTenantOverride(next);
                          // Clear the agency if it no longer belongs to the
                          // selected tenant so the dropdown re-populates.
                          const ag = agencies.find(x => x.id === form.agencyId);
                          if (next && ag?.tenantId && ag.tenantId !== next) {
                            handleSelect('agencyId', '');
                          }
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder="Select tenant" /></SelectTrigger>
                        <SelectContent>
                          {tenantFilter.tenantOptions.map((to: any) => (
                            <SelectItem key={to.id} value={to.id}>{to.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">SUPER USER only — reassign by switching to an agency in the chosen tenant.</p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label>{t('users.form.agency')}</Label>
                    <Select value={form.agencyId} onValueChange={val => handleSelect('agencyId', val)} required>
                      <SelectTrigger>
                        <SelectValue placeholder={t('users.form.selectAgency')} />
                      </SelectTrigger>
                      <SelectContent>
                        {agencies
                          .filter((agency: any) =>
                            !tenantFilter.isPlatformSuper || !tenantOverride || agency.tenantId === tenantOverride,
                          )
                          .map((agency: any) => (
                            <SelectItem key={agency.id} value={agency.id}>
                              {agency.name} — {agency.country}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
              {!isAdminOrHR && (
                <>
                  <div className="space-y-2">
                    <Label>{t('users.form.roleNoStar')}</Label>
                    <Input value={roles.find(r => r.id === form.roleId)?.name ?? form.roleId} disabled className="bg-muted" />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('users.form.agencyNoStar')}</Label>
                    <Input value={agencies.find(a => a.id === form.agencyId)?.name ?? form.agencyId} disabled className="bg-muted" />
                    {tenantFilter.isPlatformSuper && (
                      <p className="text-xs text-muted-foreground">
                        Tenant: <span className="font-medium">{
                          (() => {
                            const ag = agencies.find(a => a.id === form.agencyId);
                            const tid = ag?.tenantId;
                            return tid ? (tenantFilter.tenantNameById[tid] ?? tid) : '—';
                          })()
                        }</span>
                        <span className="ms-1">(derived from agency — change agency to change tenant)</span>
                      </p>
                    )}
                  </div>
                </>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="jobTitle">{t('users.form.jobTitle')}</Label>
                  {isAdminOrHR ? (
                    <Input id="jobTitle" value={form.jobTitle} onChange={handleChange} required
                      aria-invalid={!!fieldErrs.jobTitle}
                      className={fieldErrs.jobTitle ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                  ) : (
                    <Input value={form.jobTitle} disabled className="bg-muted" />
                  )}
                  <FieldError errors={fieldErrs} name="jobTitle" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="department">{t('users.form.department')}</Label>
                  {isAdminOrHR ? (
                    <Input id="department" value={form.department} onChange={handleChange} required
                      aria-invalid={!!fieldErrs.department}
                      className={fieldErrs.department ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                  ) : (
                    <Input value={form.department} disabled className="bg-muted" />
                  )}
                  <FieldError errors={fieldErrs} name="department" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="startDate">{t('users.form.startDate')}</Label>
                {isAdminOrHR ? (
                  <DateInput id="startDate" value={form.startDate} onChange={handleChange} required
                    aria-invalid={!!fieldErrs.startDate}
                    className={fieldErrs.startDate ? 'border-red-500 focus-visible:ring-red-500' : ''} />
                ) : (
                  <Input value={form.startDate} disabled className="bg-muted" />
                )}
                <FieldError errors={fieldErrs} name="startDate" />
              </div>
            </CardContent>
          </Card>

          {/* Personal Details */}
          <Card>
            <CardHeader>
              <CardTitle>{t('users.form.personal')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="dateOfBirth">{t('users.form.dateOfBirth')}</Label>
                  <DateInput id="dateOfBirth" value={form.dateOfBirth} onChange={handleChange} />
                </div>
                <div className="space-y-2">
                  <Label>{t('users.form.gender')}</Label>
                  <Select value={form.gender} onValueChange={val => handleSelect('gender', val)}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('users.form.selectGender')} />
                    </SelectTrigger>
                    <SelectContent>
                      {GENDER_VALUES.map(v => (
                        <SelectItem key={v} value={v}>{t(`users.form.genders.${GENDER_KEYS[v]}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('users.form.citizenship')}</Label>
                  <CountrySelect
                    value={form.citizenship}
                    onChange={(v) => handleSelect('citizenship', v)}
                    placeholder={t('users.form.selectCitizenship')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">{t('users.form.phone')}</Label>
                  <PhoneInput
                    id="phone"
                    value={form.phone}
                    onChange={(v) => handleSelect('phone', v)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Address */}
          <Card>
            <CardHeader>
              <CardTitle>{t('users.form.address')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="addressLine1">{t('users.form.addressLine1')}</Label>
                <Input id="addressLine1" placeholder={t('users.form.addressLine1Ph')} value={form.addressLine1} onChange={handleChange} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="addressLine2">{t('users.form.addressLine2')}</Label>
                <Input id="addressLine2" placeholder={t('users.form.addressLine2Ph')} value={form.addressLine2} onChange={handleChange} />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="city">{t('users.form.city')}</Label>
                  <Input id="city" placeholder={t('users.form.cityPh')} value={form.city} onChange={handleChange} />
                </div>
                <div className="space-y-2">
                  <Label>{t('users.form.country')}</Label>
                  <CountrySelect
                    value={form.country}
                    onChange={(v) => handleSelect('country', v)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="postalCode">{t('users.form.postalCode')}</Label>
                  <Input id="postalCode" placeholder={t('users.form.postalCodePh')} value={form.postalCode} onChange={handleChange} />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Preferences */}
          <Card>
            <CardHeader>
              <CardTitle>{t('users.form.preferences')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('users.form.preferredLanguage')}</Label>
                  <Select value={form.preferredLanguage} onValueChange={val => handleSelect('preferredLanguage', val)}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('users.form.selectLanguage')} />
                    </SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map(l => (
                        <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t('users.form.timeZone')}</Label>
                  <Select value={form.timeZone} onValueChange={val => handleSelect('timeZone', val)}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('users.form.selectTimeZone')} />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map(tz => (
                        <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Phase 3.14 — Platform Admin Access. System Admin only.
              Sets/clears the user's PlatformAdmin level (SUPPORT /
              OPERATOR / SUPER / NONE). Calls users.setPlatformAdminLevel
              which upserts the platform_admins row and writes a
              PlatformAuditLog entry. */}
          {viewerIsSuperPa && (
            <PlatformAdminAccessCard
              targetUserId={id!}
              currentUserId={currentUser?.id}
              targetIsSystemAdmin={roles.find(r => r.id === form.roleId)?.name === 'System Admin'}
            />
          )}

          {/* Agency Manager Permissions — System Admin only, only on
              an approved agency user. Gives the admin explicit
              toggles to grant or revoke edit / delete capability to
              the owning Agency Manager for this specific user. */}
          {isSystemAdmin && form.agencyId && approvalStatus === 'APPROVED' && (
            <Card>
              <CardHeader>
                <CardTitle>{t('users.edit.managerPermsTitle')}</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('users.edit.managerPermsHelp')}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-input"
                    checked={allowManagerView}
                    disabled={savingOverride}
                    onChange={e => handleManagerOverride({ allowManagerView: e.target.checked })}
                  />
                  <div>
                    <div className="font-medium text-sm text-[#0F172A]">{t('users.edit.allowView')}</div>
                    <p className="text-xs text-muted-foreground">{t('users.edit.allowViewHelper')}</p>
                  </div>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-input"
                    checked={allowManagerEdit}
                    disabled={savingOverride}
                    onChange={e => handleManagerOverride({ allowManagerEdit: e.target.checked })}
                  />
                  <div>
                    <div className="font-medium text-sm text-[#0F172A]">{t('users.edit.allowEdit')}</div>
                    <p className="text-xs text-muted-foreground">{t('users.edit.allowEditHelper')}</p>
                  </div>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-input"
                    checked={allowManagerDelete}
                    disabled={savingOverride}
                    onChange={e => handleManagerOverride({ allowManagerDelete: e.target.checked })}
                  />
                  <div>
                    <div className="font-medium text-sm text-[#0F172A]">{t('users.edit.allowDelete')}</div>
                    <p className="text-xs text-muted-foreground">{t('users.edit.allowDeleteHelper')}</p>
                  </div>
                </label>
              </CardContent>
            </Card>
          )}

          <div className="flex gap-3">
            <Button type="submit" className="flex-1" disabled={submitting}>
              {submitting ? tc('states.saving') : tc('actions.saveChanges')}
            </Button>
            <Button type="button" variant="outline" className="flex-1" asChild>
              <Link to="/dashboard/users">{tc('actions.cancel')}</Link>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

// Phase 3.14 — Platform Admin access card. Renders a level select +
// Save button; calls usersApi.setPlatformAdminLevel. Self-revoke is
// rejected by the backend; the UI also disables NONE when editing
// your own user.
function PlatformAdminAccessCard({
  targetUserId,
  currentUserId,
  targetIsSystemAdmin,
}: { targetUserId: string; currentUserId?: string; targetIsSystemAdmin: boolean }) {
  const { t } = useTranslation('pages');
  const [level, setLevel] = useState<'NONE' | 'SUPPORT' | 'OPERATOR' | 'SUPER'>('NONE');
  const [initialLevel, setInitialLevel] = useState<'NONE' | 'SUPPORT' | 'OPERATOR' | 'SUPER'>('NONE');
  const [reason, setReason] = useState('admin-ui');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await usersApi.get(targetUserId);
        const l = (u?.platformAdmin?.level as any) ?? 'NONE';
        if (!cancelled) { setLevel(l); setInitialLevel(l); }
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [targetUserId]);

  const isSelf = currentUserId === targetUserId;
  // Platform-admin authority may only attach to a System Admin. When
  // the target isn't one, every grant level (SUPPORT/OPERATOR/SUPER)
  // is disabled — only NONE (revoke) stays available so an admin can
  // still strip a stale grant. Mirrors the backend
  // PLATFORM_ADMIN.TARGET_NOT_SYSTEM_ADMIN guard; not the security
  // boundary, just UX.
  const grantBlocked = !targetIsSystemAdmin;
  const wantsGrant = level !== 'NONE';
  const disabled = saving || loading || level === initialLevel || (grantBlocked && wantsGrant);

  const onSave = async () => {
    if (grantBlocked && wantsGrant) {
      toast.error(t('users.platformAdmin.onlySystemAdmin', {
        defaultValue: 'Platform admin access can only be granted to System Admin users.',
      }));
      return;
    }
    setSaving(true);
    try {
      const r = await usersApi.setPlatformAdminLevel(targetUserId, level, reason);
      setInitialLevel(level);
      toast.success(`Platform admin: ${r.action}`);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to update PlatformAdmin level');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform Admin Access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Grants platform-level authority independent of tenant roles. SUPER can
          grant/revoke other PlatformAdmins. NONE removes the grant entirely.
        </p>
        {grantBlocked && (
          <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t('users.platformAdmin.onlySystemAdmin', {
              defaultValue: 'Platform admin access can only be granted to System Admin users. Change this user\'s role to System Admin first.',
            })}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="block text-sm">
            <span className="font-medium">Level</span>
            <select
              className="mt-1 block w-full rounded-md border px-3 py-2 text-sm"
              value={level}
              onChange={(e) => setLevel(e.target.value as any)}
              disabled={loading || saving}
            >
              <option value="NONE" disabled={isSelf && initialLevel !== 'NONE'}>NONE</option>
              <option value="SUPPORT" disabled={grantBlocked}>SUPPORT</option>
              <option value="OPERATOR" disabled={grantBlocked}>OPERATOR</option>
              <option value="SUPER" disabled={grantBlocked}>SUPER</option>
            </select>
            {isSelf && initialLevel !== 'NONE' && (
              <span className="text-xs text-muted-foreground">Self-revoke not allowed.</span>
            )}
          </label>
          <label className="block text-sm md:col-span-2">
            <span className="font-medium">Reason</span>
            <input
              type="text"
              className="mt-1 block w-full rounded-md border px-3 py-2 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={loading || saving}
            />
          </label>
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={onSave} disabled={disabled}>
            {saving ? 'Saving…' : 'Save platform admin level'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
