import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Briefcase, ArrowLeft, CheckCircle, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { authApi, setTokens, setCurrentUser, resolveAssetUrl } from '../../services/api';
import { useBranding } from '../../hooks/useBranding';
import { LanguageSwitcher } from '../../../i18n/LanguageSwitcher';
import { ErrorBanner } from '../../components/ui/error-banner';

type StrengthLabel = 'weak' | 'medium' | 'strong';

function getPasswordStrength(password: string): { score: number; label: StrengthLabel; color: string } {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[\p{Lu}\p{Lo}]/u.test(password)) score++;
  if (/[\p{Ll}\p{Lo}]/u.test(password)) score++;
  if (/\p{N}/u.test(password)) score++;
  if (/[^\p{L}\p{N}]/u.test(password)) score++;

  if (score <= 2) return { score, label: 'weak', color: 'bg-red-500' };
  if (score <= 3) return { score, label: 'medium', color: 'bg-yellow-500' };
  return { score, label: 'strong', color: 'bg-green-500' };
}

function PasswordRule({ met, text }: { met: boolean; text: string }) {
  return (
    <div className={`flex items-center gap-1.5 text-xs ${met ? 'text-green-600' : 'text-muted-foreground'}`}>
      {met ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      <span>{text}</span>
    </div>
  );
}

export function ActivationPage() {
  const branding = useBranding();
  const { t } = useTranslation(['auth', 'common']);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const rules = {
    minLength: password.length >= 8,
    uppercase: /[\p{Lu}\p{Lo}]/u.test(password),
    lowercase: /[\p{Ll}\p{Lo}]/u.test(password),
    number: /\p{N}/u.test(password),
    special: /[^\p{L}\p{N}]/u.test(password),
  };

  const allRulesMet = Object.values(rules).every(Boolean);
  const strength = getPasswordStrength(password);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError(t('activation.invalidTokenError'));
      return;
    }
    if (!allRulesMet) {
      setError(t('activation.passwordRequirementsError'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('activation.passwordMismatchError'));
      return;
    }

    setLoading(true);
    try {
      const result = await authApi.activateAccount(token, password);
      setTokens(result.accessToken, result.refreshToken);
      setCurrentUser(result.user);
      toast.success(t('activation.submitSuccess'));
      navigate('/dashboard');
    } catch (err: any) {
      const msg = err?.message || t('activation.submitFailed');
      setError(Array.isArray(msg) ? msg.join(', ') : String(msg));
      toast.error(t('activation.submitToastFailed'));
    } finally {
      setLoading(false);
    }
  };

  const strengthColor =
    strength.label === 'weak' ? 'text-red-500' :
    strength.label === 'medium' ? 'text-yellow-600' : 'text-green-600';

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#EFF6FF] to-white flex items-center justify-center p-4">
      <div className="absolute top-4 start-4">
        <Link to="/login">
          <Button variant="ghost" className="gap-2">
            <ArrowLeft className="w-4 h-4 rtl:rotate-180" />
            {t('activation.backToLogin')}
          </Button>
        </Link>
      </div>

      <div className="absolute top-4 end-4">
        <LanguageSwitcher variant="labelled" />
      </div>

      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-lg bg-[#2563EB] flex items-center justify-center overflow-hidden">
              {branding.logoUrl ? (
                <img src={resolveAssetUrl(branding.logoUrl)} alt="Logo" className="w-full h-full object-cover" />
              ) : (
                <Briefcase className="w-7 h-7 text-white" />
              )}
            </div>
            <div className="text-start">
              <span className="text-xl font-bold text-[#0F172A] block">{branding.companyName}</span>
              <span className="text-xs text-muted-foreground">{t('common:branding.tagline')}</span>
            </div>
          </div>
          <CardTitle className="text-2xl">{t('activation.title')}</CardTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {t('activation.subtitle')}
          </p>
        </CardHeader>

        <CardContent className="space-y-6">
          {!token && <ErrorBanner message={t('activation.noTokenError')} />}

          <form onSubmit={handleSubmit} className="space-y-4">
            <ErrorBanner message={error} />
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                {t('activation.newPasswordLabel')}
              </label>
              <Input
                id="password"
                type="password"
                placeholder={t('activation.newPasswordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
              {password && (
                <div className="space-y-2 mt-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${strength.color}`}
                        style={{ width: `${(strength.score / 5) * 100}%` }}
                      />
                    </div>
                    <span className={`text-xs font-medium ${strengthColor}`}>
                      {t(`passwordStrength.${strength.label}`)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <PasswordRule met={rules.minLength} text={t('passwordStrength.minLength')} />
                    <PasswordRule met={rules.uppercase} text={t('passwordStrength.uppercase')} />
                    <PasswordRule met={rules.lowercase} text={t('passwordStrength.lowercase')} />
                    <PasswordRule met={rules.number}    text={t('passwordStrength.number')} />
                    <PasswordRule met={rules.special}   text={t('passwordStrength.special')} />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="confirmPassword" className="text-sm font-medium">
                {t('activation.confirmPasswordLabel')}
              </label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder={t('activation.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-500">{t('activation.passwordMismatchHint')}</p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full bg-[#2563EB] hover:bg-[#1d4ed8]"
              disabled={loading || !token}
            >
              {loading ? t('activation.submitting') : t('activation.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="absolute bottom-4 text-center text-sm text-muted-foreground">
        <p>{t('common:branding.copyright', { year: 2026, company: branding.companyName })} - {t('common:branding.secureAccess')}</p>
      </div>
    </div>
  );
}
