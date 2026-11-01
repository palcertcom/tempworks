import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { authApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { Eye, EyeOff, Lock, CheckCircle, X, AlertCircle, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Progress } from '../../components/ui/progress';

export function ChangePassword() {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);

  // Password strength calculation
  const calculatePasswordStrength = (password: string): number => {
    let strength = 0;
    if (password.length >= 8) strength += 25;
    if (password.length >= 12) strength += 25;
    if (/[\p{Ll}\p{Lo}]/u.test(password) && /[\p{Lu}\p{Lo}]/u.test(password)) strength += 25;
    if (/\p{N}/u.test(password)) strength += 12.5;
    if (/[^\p{L}\p{N}]/u.test(password)) strength += 12.5;
    return Math.min(strength, 100);
  };

  const passwordStrength = calculatePasswordStrength(newPassword);

  const getStrengthLabel = (strength: number): { label: string; color: string } => {
    if (strength < 25) return { label: t('profile.changePassword.strength.weak'), color: 'bg-[#EF4444]' };
    if (strength < 50) return { label: t('profile.changePassword.strength.fair'), color: 'bg-[#F59E0B]' };
    if (strength < 75) return { label: t('profile.changePassword.strength.good'), color: 'bg-[#3B82F6]' };
    return { label: t('profile.changePassword.strength.strong'), color: 'bg-[#22C55E]' };
  };

  const strengthInfo = getStrengthLabel(passwordStrength);

  // Password validation rules
  const validationRules = [
    { label: t('profile.changePassword.rules.length'), test: (pwd: string) => pwd.length >= 8 },
    { label: t('profile.changePassword.rules.upper'), test: (pwd: string) => /[\p{Lu}\p{Lo}]/u.test(pwd) },
    { label: t('profile.changePassword.rules.lower'), test: (pwd: string) => /[\p{Ll}\p{Lo}]/u.test(pwd) },
    { label: t('profile.changePassword.rules.number'), test: (pwd: string) => /\p{N}/u.test(pwd) },
    { label: t('profile.changePassword.rules.special'), test: (pwd: string) => /[^\p{L}\p{N}]/u.test(pwd) },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentPassword) {
      toast.error(t('profile.changePassword.errEnterCurrent'));
      return;
    }

    if (newPassword.length < 8) {
      toast.error(t('profile.changePassword.errMinLength'));
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error(t('profile.changePassword.errMismatch'));
      return;
    }

    try {
      await authApi.changePassword(currentPassword, newPassword);
      setSuccessMessage(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success(t('profile.changePassword.successToast'));
      setTimeout(() => setSuccessMessage(false), 5000);
    } catch (err: any) {
      toast.error(apiError(err, t('profile.changePassword.errGeneric')));
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('profile.changePassword.title')}</h1>
        </div>
        <p className="text-muted-foreground mt-1">{t('profile.changePassword.subtitle')}</p>
      </div>

      {/* Success Message */}
      {successMessage && (
        <div className="p-4 bg-[#F0FDF4] border border-[#22C55E] rounded-lg flex items-start gap-3">
          <CheckCircle className="w-5 h-5 text-[#22C55E] mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-[#22C55E]">{t('profile.changePassword.successHeader')}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t('profile.changePassword.successBody')}
            </p>
          </div>
          <button onClick={() => setSuccessMessage(false)}>
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.changePassword.passwordSecurity')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Current Password */}
            <div className="space-y-2">
              <Label htmlFor="current-password">{t('profile.changePassword.currentPassword')}</Label>
              <div className="relative">
                <Lock className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="current-password"
                  type={showCurrentPassword ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="ps-10 pe-10"
                  placeholder={t('profile.changePassword.currentPasswordPh')}
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-[#0F172A]"
                >
                  {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* New Password */}
            <div className="space-y-2">
              <Label htmlFor="new-password">{t('profile.changePassword.newPassword')}</Label>
              <div className="relative">
                <Lock className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="new-password"
                  type={showNewPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="ps-10 pe-10"
                  placeholder={t('profile.changePassword.newPasswordPh')}
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-[#0F172A]"
                >
                  {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Password Strength Indicator */}
              {newPassword && (
                <div className="space-y-2 mt-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t('profile.changePassword.strengthLabel')}</Label>
                    <span className={`text-sm font-medium ${
                      strengthInfo.color.replace('bg-', 'text-')
                    }`}>
                      {strengthInfo.label}
                    </span>
                  </div>
                  <Progress 
                    value={passwordStrength} 
                    className={`h-2 ${strengthInfo.color}`}
                  />
                </div>
              )}
            </div>

            {/* Confirm Password */}
            <div className="space-y-2">
              <Label htmlFor="confirm-password">{t('profile.changePassword.confirmNewPassword')}</Label>
              <div className="relative">
                <Lock className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="confirm-password"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="ps-10 pe-10"
                  placeholder={t('profile.changePassword.confirmNewPasswordPh')}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-[#0F172A]"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Password Match Indicator */}
              {confirmPassword && (
                <div className="flex items-center gap-2 mt-2">
                  {newPassword === confirmPassword ? (
                    <>
                      <CheckCircle className="w-4 h-4 text-[#22C55E]" />
                      <span className="text-sm text-[#22C55E]">{t('profile.changePassword.passwordsMatch')}</span>
                    </>
                  ) : (
                    <>
                      <X className="w-4 h-4 text-[#EF4444]" />
                      <span className="text-sm text-[#EF4444]">{t('profile.changePassword.passwordsMismatch')}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Password Requirements */}
            <div className="p-4 bg-[#F8FAFC] border rounded-lg">
              <p className="text-sm font-medium mb-3">{t('profile.changePassword.passwordRequirements')}</p>
              <div className="space-y-2">
                {validationRules.map((rule, index) => {
                  const isValid = rule.test(newPassword);
                  return (
                    <div key={index} className="flex items-center gap-2">
                      {newPassword ? (
                        isValid ? (
                          <CheckCircle className="w-4 h-4 text-[#22C55E]" />
                        ) : (
                          <X className="w-4 h-4 text-[#EF4444]" />
                        )
                      ) : (
                        <div className="w-4 h-4 rounded-full border-2 border-muted-foreground" />
                      )}
                      <span className={`text-sm ${
                        newPassword ? (isValid ? 'text-[#22C55E]' : 'text-[#EF4444]') : 'text-muted-foreground'
                      }`}>
                        {rule.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Security Tips */}
            <div className="p-4 bg-[#EFF6FF] border border-[#2563EB] rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-[#2563EB] mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-[#2563EB]">{t('profile.changePassword.securityTips')}</p>
                  <ul className="text-xs text-muted-foreground mt-2 space-y-1 list-disc list-inside">
                    <li>{t('profile.changePassword.tip1')}</li>
                    <li>{t('profile.changePassword.tip2')}</li>
                    <li>{t('profile.changePassword.tip3')}</li>
                    <li>{t('profile.changePassword.tip4')}</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <Button type="submit" className="flex-1">
                {t('profile.changePassword.updatePassword')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCurrentPassword('');
                  setNewPassword('');
                  setConfirmPassword('');
                }}
              >
                {t('profile.changePassword.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
