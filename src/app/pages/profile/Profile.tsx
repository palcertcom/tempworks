import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Camera, Save, Shield, CheckCircle, AlertCircle, Loader2, Settings } from 'lucide-react';
import { apiError } from '../../../i18n/apiError';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Progress } from '../../components/ui/progress';
import { Switch } from '../../components/ui/switch';
import { Separator } from '../../components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { CountrySelect } from '../../components/ui/CountrySelect';
import { PhoneInput } from '../../components/ui/PhoneInput';
import { usersApi, authApi, resolveAssetUrl } from '../../services/api';
import { toast } from 'sonner';
import { formatDate, formatDateTime } from '../../../i18n/formatters';

export function Profile() {
  const { t } = useTranslation('pages');
  const [isEditing, setIsEditing] = useState(false);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [twoFactorSaving, setTwoFactorSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [userData, setUserData] = useState<any>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [editForm, setEditForm] = useState({
    phone: '',
    dateOfBirth: '',
    gender: '',
    citizenship: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    country: '',
    postalCode: '',
  });

  useEffect(() => {
    Promise.all([authApi.me(), usersApi.me().catch(() => null)])
      .then(([authUser, fullUser]) => {
        // authUser always has firstName/lastName/email; fullUser has extended profile fields
        const merged = { ...fullUser, ...authUser, ...(fullUser ?? {}) };
        // Keep authUser identity fields as the source of truth
        merged.firstName = authUser.firstName;
        merged.lastName = authUser.lastName;
        merged.email = authUser.email;
        if (!merged.role || typeof merged.role === 'string') {
          merged.role = fullUser?.role ?? { name: authUser.role };
        }
        setUserData(merged);
        setTwoFactorEnabled(Boolean(merged?.twoFactorEnabled));
        setEditForm({
          phone: merged.phone || '',
          dateOfBirth: merged.dateOfBirth ? merged.dateOfBirth.slice(0, 10) : '',
          gender: merged.gender || '',
          citizenship: merged.citizenship || '',
          addressLine1: merged.addressLine1 || '',
          addressLine2: merged.addressLine2 || '',
          city: merged.city || '',
          country: merged.country || '',
          postalCode: merged.postalCode || '',
        });
      })
      .catch(() => toast.error(t('profile.toast.loadFailed')))
      .finally(() => setLoading(false));
  }, []);

  const profileCompletion = userData ? (() => {
    const fields = [
      userData.firstName, userData.lastName, userData.email, userData.phone,
      userData.dateOfBirth, userData.gender, userData.citizenship,
      userData.city, userData.country,
    ];
    return Math.round((fields.filter(Boolean).length / fields.length) * 100);
  })() : 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      // Drop empty strings before submitting. The backend DTO uses
      // @IsDateString / @IsEnum, which both reject "" — class-validator's
      // @IsOptional only skips undefined/null. Without this, leaving DOB
      // or Gender blank fails the entire request with a 400 and nothing
      // gets persisted.
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(editForm)) {
        if (v === '' || v === undefined || v === null) continue;
        payload[k] = v;
      }
      const updated = await usersApi.updateProfile(payload);
      // Re-sync from server response so the UI shows what was actually saved
      setUserData((prev: any) => ({ ...prev, ...updated }));
      setEditForm({
        phone: updated?.phone ?? '',
        dateOfBirth: updated?.dateOfBirth ? updated.dateOfBirth.slice(0, 10) : '',
        gender: updated?.gender ?? '',
        citizenship: updated?.citizenship ?? '',
        addressLine1: updated?.addressLine1 ?? '',
        addressLine2: updated?.addressLine2 ?? '',
        city: updated?.city ?? '',
        country: updated?.country ?? '',
        postalCode: updated?.postalCode ?? '',
      });
      setIsEditing(false);
      toast.success(t('profile.toast.updated'));
    } catch (err: any) {
      toast.error(apiError(err, t('profile.toast.updateFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditForm({
      phone: userData.phone || '',
      dateOfBirth: userData.dateOfBirth ? userData.dateOfBirth.slice(0, 10) : '',
      gender: userData.gender || '',
      citizenship: userData.citizenship || '',
      addressLine1: userData.addressLine1 || '',
      addressLine2: userData.addressLine2 || '',
      city: userData.city || '',
      country: userData.country || '',
      postalCode: userData.postalCode || '',
    });
    setIsEditing(false);
  };

  const handlePhotoChange = async (file: File) => {
    setPhotoPreview(URL.createObjectURL(file));
    setUploadingPhoto(true);
    try {
      const result = await usersApi.uploadOwnPhoto(file);
      setUserData((prev: any) => ({ ...prev, photoUrl: result?.photoUrl ?? prev?.photoUrl }));
      toast.success(t('profile.toast.photoUpdated'));
    } catch (err: any) {
      toast.error(apiError(err, t('profile.toast.photoFailed')));
      setPhotoPreview(null);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const avatarSrc: string | null = photoPreview
    ?? (userData?.photoUrl ? resolveAssetUrl(userData.photoUrl) : null);
  const avatarInitials = `${userData?.firstName?.[0] ?? ''}${userData?.lastName?.[0] ?? ''}`.toUpperCase() || '?';
  const displayName = userData ? `${userData.firstName} ${userData.lastName}` : '';
  const roleName = (typeof userData?.role === 'string' ? userData.role : userData?.role?.name) || '';
  const agencyName = userData?.agency ? `${userData.agency.name}${userData.agency.country ? ` — ${userData.agency.country}` : ''}` : 'N/A';
  const permissions: string[] = Array.isArray(userData?.role?.permissions)
    ? userData.role.permissions.map((p: any) => p.permission?.name || p.name).filter(Boolean)
    : Array.isArray(userData?.permissions)
    ? userData.permissions
    : [];

  const fmtDate = (val: string | null | undefined) => {
    if (!val) return '—';
    return formatDate(val);
  };

  const fmtDateTime = (val: string | null | undefined) => {
    if (!val) return '—';
    return formatDateTime(val);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-[#0F172A]">{t('profile.view.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('profile.view.subtitle')}</p>
      </div>

      {/* Profile Completion */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-3">
                <h3 className="font-semibold text-[#0F172A]">{t('profile.view.completion')}</h3>
                {userData?.userNumber && (
                  <Badge variant="outline" className="font-mono text-sm bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]">
                    {userData.userNumber}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{t('profile.view.completionBody')}</p>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/preferences">
                  <Settings className="w-4 h-4 me-2" />
                  {t('profile.view.preferences')}
                </Link>
              </Button>
              <Badge className={profileCompletion === 100 ? 'bg-[#22C55E]' : 'bg-[#F59E0B]'}>
                {profileCompletion}%
              </Badge>
            </div>
          </div>
          <Progress value={profileCompletion} className="h-2" />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Personal Information */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{t('profile.view.personalInformation')}</CardTitle>
                {!isEditing ? (
                  <Button onClick={() => setIsEditing(true)}>{t('profile.view.editProfile')}</Button>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={handleCancel} disabled={saving}>{t('profile.view.cancel')}</Button>
                    <Button onClick={handleSave} disabled={saving}>
                      {saving ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Save className="w-4 h-4 me-2" />}
                      {t('profile.view.saveChanges')}
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Avatar */}
              <div className="flex items-center gap-6">
                <div className="relative">
                  {avatarSrc ? (
                    <img src={avatarSrc} alt={displayName} className="w-24 h-24 rounded-full object-cover border border-gray-200" />
                  ) : (
                    <div
                      className="w-24 h-24 rounded-full bg-[#EFF6FF] flex items-center justify-center text-[#2563EB] text-3xl font-bold border border-gray-200"
                      aria-label={displayName}
                    >
                      {avatarInitials}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    disabled={uploadingPhoto}
                    title={t('profile.view.changePhotoTitle')}
                    className="absolute bottom-0 end-0 w-8 h-8 rounded-full bg-[#2563EB] flex items-center justify-center text-white hover:bg-[#1D4ED8] transition-colors disabled:opacity-50"
                  >
                    {uploadingPhoto ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                  </button>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handlePhotoChange(f); }}
                  />
                </div>
                <div>
                  <h3 className="font-semibold">{displayName}</h3>
                  <p className="text-sm text-muted-foreground">{roleName}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t('profile.view.changePhotoHint')}</p>
                </div>
              </div>

              <Separator />

              {/* Read-only identity fields */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>First Name</Label>
                  <Input value={userData?.firstName || ''} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Middle Name</Label>
                  <Input value={userData?.middleName || '—'} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Last Name</Label>
                  <Input value={userData?.lastName || ''} disabled className="bg-[#F8FAFC]" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">{t('profile.view.contactAdminNames')}</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Email Address</Label>
                  <Input type="email" value={userData?.email || ''} disabled className="bg-[#F8FAFC]" />
                  <p className="text-xs text-muted-foreground">{t('profile.view.emailCannotChange')}</p>
                </div>

                <div className="space-y-2">
                  <Label>Phone Number</Label>
                  {isEditing ? (
                    <PhoneInput
                      value={editForm.phone}
                      onChange={(v) => setEditForm({ ...editForm, phone: v })}
                    />
                  ) : (
                    <Input value={userData?.phone || ''} disabled placeholder="—" />
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Date of Birth</Label>
                  <Input
                    type={isEditing ? 'date' : 'text'}
                    value={isEditing ? editForm.dateOfBirth : (userData?.dateOfBirth ? fmtDate(userData.dateOfBirth) : '—')}
                    onChange={(e) => setEditForm({ ...editForm, dateOfBirth: e.target.value })}
                    disabled={!isEditing}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Gender</Label>
                  {isEditing ? (
                    <Select value={editForm.gender} onValueChange={val => setEditForm({ ...editForm, gender: val })}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select gender" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MALE">Male</SelectItem>
                        <SelectItem value="FEMALE">Female</SelectItem>
                        <SelectItem value="OTHER">Other</SelectItem>
                        <SelectItem value="PREFER_NOT_TO_SAY">{t('profile.view.preferNotToSay')}</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input value={
                      userData?.gender === 'MALE' ? 'Male' :
                      userData?.gender === 'FEMALE' ? 'Female' :
                      userData?.gender === 'OTHER' ? 'Other' :
                      userData?.gender === 'PREFER_NOT_TO_SAY' ? 'Prefer not to say' :
                      userData?.gender || '—'
                    } disabled />
                  )}
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label>Citizenship</Label>
                  {isEditing ? (
                    <CountrySelect
                      value={editForm.citizenship}
                      onChange={(v) => setEditForm({ ...editForm, citizenship: v })}
                      placeholder="Select country of citizenship"
                    />
                  ) : (
                    <Input value={userData?.citizenship || '—'} disabled />
                  )}
                </div>
              </div>

              <Separator />

              {/* Address fields */}
              <div>
                <h4 className="text-sm font-semibold text-[#0F172A] mb-3">Address</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Address Line 1</Label>
                    <Input
                      value={isEditing ? editForm.addressLine1 : (userData?.addressLine1 || '—')}
                      onChange={(e) => setEditForm({ ...editForm, addressLine1: e.target.value })}
                      disabled={!isEditing}
                      placeholder={isEditing ? 'Street address' : ''}
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Address Line 2</Label>
                    <Input
                      value={isEditing ? editForm.addressLine2 : (userData?.addressLine2 || '')}
                      onChange={(e) => setEditForm({ ...editForm, addressLine2: e.target.value })}
                      disabled={!isEditing}
                      placeholder={isEditing ? 'Apartment, suite, etc.' : ''}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>City</Label>
                    <Input
                      value={isEditing ? editForm.city : (userData?.city || '—')}
                      onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                      disabled={!isEditing}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Country</Label>
                    {isEditing ? (
                      <CountrySelect
                        value={editForm.country}
                        onChange={(v) => setEditForm({ ...editForm, country: v })}
                      />
                    ) : (
                      <Input value={userData?.country || '—'} disabled />
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Postal Code</Label>
                    <Input
                      value={isEditing ? editForm.postalCode : (userData?.postalCode || '—')}
                      onChange={(e) => setEditForm({ ...editForm, postalCode: e.target.value })}
                      disabled={!isEditing}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Work Information */}
          <Card>
            <CardHeader>
              <CardTitle>Work Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Input value={roleName} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Agency</Label>
                  <Input value={agencyName} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Job Title</Label>
                  <Input value={userData?.jobTitle || '—'} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Department</Label>
                  <Input value={userData?.department || '—'} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Start Date</Label>
                  <Input value={userData?.startDate ? fmtDate(userData.startDate) : '—'} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Status</Label>
                  <Input value={userData?.status || '—'} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Preferred Language</Label>
                  <Input value={userData?.preferredLanguage || '—'} disabled className="bg-[#F8FAFC]" />
                </div>

                <div className="space-y-2">
                  <Label>Time Zone</Label>
                  <Input value={userData?.timeZone || '—'} disabled className="bg-[#F8FAFC]" />
                </div>
              </div>

              {permissions.length > 0 && (
                <div className="space-y-2">
                  <Label>Permissions (Read-only)</Label>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {permissions.map((permission, index) => (
                      <Badge key={index} variant="outline" className="bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]">
                        <CheckCircle className="w-3 h-3 me-1" />
                        {permission}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Account Information */}
          <Card>
            <CardHeader>
              <CardTitle>Account Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {userData?.userNumber && (
                <>
                  <div>
                    <Label className="text-muted-foreground text-sm">{t('profile.view.userNumber')}</Label>
                    <p className="font-bold mt-1 text-lg text-[#2563EB] font-mono">
                      {userData.userNumber}
                    </p>
                  </div>
                  <Separator />
                </>
              )}

              <div>
                <Label className="text-muted-foreground text-sm">{t('profile.view.accountCreated')}</Label>
                <p className="font-medium mt-1">{fmtDate(userData?.createdAt)}</p>
              </div>

              <Separator />

              <div>
                <Label className="text-muted-foreground text-sm">{t('profile.view.lastLogin')}</Label>
                <p className="font-medium mt-1">{fmtDateTime(userData?.lastLoginAt)}</p>
              </div>

              <Separator />

              <div>
                <Label className="text-muted-foreground text-sm">{t('profile.view.userId')}</Label>
                <p className="font-medium mt-1 text-sm text-muted-foreground font-mono">
                  {userData?.id ? userData.id.slice(0, 8).toUpperCase() : '—'}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Security */}
          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-[#2563EB]" />
                    <Label className="font-medium">{t('profile.view.twoFactorAuth')}</Label>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Add an extra layer of security to your account
                  </p>
                </div>
                <Switch
                  checked={twoFactorEnabled}
                  disabled={twoFactorSaving}
                  onCheckedChange={async (checked) => {
                    setTwoFactorSaving(true);
                    // Optimistic toggle so the UI feels instant
                    setTwoFactorEnabled(checked);
                    try {
                      if (checked) {
                        await authApi.enableTwoFactor();
                        toast.success(t('profile.toast.twoFaEnabled'));
                      } else {
                        await authApi.disableTwoFactor();
                        toast.success(t('profile.toast.twoFaDisabled'));
                      }
                      setUserData((prev: any) => prev ? { ...prev, twoFactorEnabled: checked } : prev);
                    } catch (err: any) {
                      // Roll back on error
                      setTwoFactorEnabled(!checked);
                      toast.error(apiError(err, t('profile.toast.twoFaFailed')));
                    } finally {
                      setTwoFactorSaving(false);
                    }
                  }}
                />
              </div>

              {twoFactorEnabled && (
                <div className="p-3 bg-[#EFF6FF] border border-[#2563EB] rounded-lg">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 text-[#2563EB] mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-[#2563EB]">{t('profile.view.twoFaEnabled')}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Your account is protected with two-factor authentication
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <Separator />

              <div>
                <Label className="text-muted-foreground text-sm">Password</Label>
                <p className="text-sm mt-1">••••••••••••</p>
                <Button variant="outline" size="sm" className="mt-2" asChild>
                  <Link to="/dashboard/change-password">{t('profile.view.changePassword')}</Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Account Status */}
          <Card>
            <CardHeader>
              <CardTitle>Account Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-[#22C55E]" />
                  <span className="text-sm">{t('profile.view.emailVerified')}</span>
                </div>
                <div className="flex items-center gap-2">
                  {userData?.status === 'ACTIVE' ? (
                    <CheckCircle className="w-4 h-4 text-[#22C55E]" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-[#EF4444]" />
                  )}
                  <span className="text-sm">
                    Account {userData?.status === 'ACTIVE' ? 'Active' : userData?.status || 'Unknown'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {twoFactorEnabled ? (
                    <CheckCircle className="w-4 h-4 text-[#22C55E]" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-[#F59E0B]" />
                  )}
                  <span className="text-sm">
                    {twoFactorEnabled ? '2FA Enabled' : '2FA Not Enabled'}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
