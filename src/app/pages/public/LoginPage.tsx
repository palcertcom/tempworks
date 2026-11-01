import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Briefcase, ArrowLeft, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { authApi, resolveAssetUrl, getLastCompany } from '../../services/api';
import { useBranding } from '../../hooks/useBranding';
import { LanguageSwitcher } from '../../../i18n/LanguageSwitcher';
import { apiError } from '../../../i18n/apiError';
import { ErrorBanner } from '../../components/ui/error-banner';

export function LoginPage() {
  const navigate = useNavigate();
  const branding = useBranding();
  const { t } = useTranslation(['auth', 'common']);
  // Phase 3.14 — Company is the tenant slug or custom domain. Prefilled
  // from localStorage on mount; never persists credentials.
  // @tenant-reviewed: phase314-frontend-tenant-login
  const [company, setCompany] = useState(getLastCompany());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const emailInvalid = emailTouched && !!email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  // 2FA challenge state
  const [twoFactor, setTwoFactor] = useState<{ challengeId: string; emailHint?: string } | null>(null);
  const [otp, setOtp] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);

  const proceedAfterLogin = async (result: any) => {
    toast.success(t('login.welcomeBack'));
    // Phase 3.17 — tenant changed (we just signed in). Drop any cached
    // /settings/branding response so the dashboard renders the right
    // tenant's logo + name on the first paint after login.
    try {
      const mod = await import('../../hooks/useBranding');
      mod.invalidateBrandingCache?.();
    } catch { /* missing in minimal build */ }
    if (result?.passwordExpired) {
      // ChangePassword is registered under the /dashboard layout (it
      // needs an authenticated session — login has just minted one).
      // Using the bare /change-password path 404s because no top-level
      // route is defined for it.
      navigate('/dashboard/change-password', {
        state: { message: t('login.passwordExpiredMessage') },
      });
      return;
    }
    navigate('/dashboard');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // Phase 3.14 — pass `company` to route through tenant-aware /auth/login-v2.
      const result = await authApi.login(email, password, company);
      if ('twoFactorRequired' in result && result.twoFactorRequired) {
        setTwoFactor({ challengeId: result.challengeId, emailHint: result.emailHint });
        setOtp('');
        toast.info(t('twoFactor.codeSentToast'));
        return;
      }
      proceedAfterLogin(result);
    } catch (err: any) {
      // Phase 3.14 — generic auth failure only. Never expose whether the
      // company, email, or password was wrong.
      // @tenant-reviewed: phase314-frontend-tenant-login
      const message = t('login.loginFailed');
      setError(message);
      toast.error(message);
      void apiError; void err;
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFactor) return;
    setVerifying(true);
    setError('');
    try {
      const result = await authApi.verifyTwoFactor(twoFactor.challengeId, otp.trim());
      proceedAfterLogin(result);
    } catch (err: any) {
      const message = apiError(err, t('twoFactor.verifyFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setVerifying(false);
    }
  };

  const handleResendOtp = async () => {
    if (!twoFactor) return;
    setResending(true);
    try {
      const { challengeId } = await authApi.resendTwoFactor(twoFactor.challengeId);
      setTwoFactor(prev => (prev ? { ...prev, challengeId } : prev));
      setOtp('');
      toast.success(t('twoFactor.resendSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('twoFactor.resendFailed')));
      setTwoFactor(null);
    } finally {
      setResending(false);
    }
  };

  const cancelTwoFactor = () => {
    setTwoFactor(null);
    setOtp('');
    setError('');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#EFF6FF] to-white flex items-center justify-center p-4">
      {/* Back to Home */}
      <div className="absolute top-4 start-4">
        <Link to="/">
          <Button variant="ghost" className="gap-2">
            <ArrowLeft className="w-4 h-4 rtl:rotate-180" />
            {t('login.backToHome')}
          </Button>
        </Link>
      </div>

      {/* Language switcher */}
      <div className="absolute top-4 end-4">
        <LanguageSwitcher variant="labelled" />
      </div>

      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-lg bg-[#2563EB] flex items-center justify-center overflow-hidden">
              {branding.logoUrl ? (
                <img
                  src={resolveAssetUrl(branding.logoUrl)}
                  alt="Logo"
                  className="w-full h-full object-cover"
                />
              ) : (
                <Briefcase className="w-7 h-7 text-white" />
              )}
            </div>
            <div className="text-start">
              <span className="text-xl font-bold text-[#0F172A] block">{branding.companyName}</span>
              <span className="text-xs text-muted-foreground">{t('common:branding.tagline')}</span>
            </div>
          </div>
          <CardTitle className="text-2xl">
            {twoFactor ? t('twoFactor.title') : t('login.title')}
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {twoFactor
              ? (twoFactor.emailHint
                  ? t('twoFactor.subtitleWithEmail', { email: twoFactor.emailHint })
                  : t('twoFactor.subtitleWithoutEmail'))
              : t('login.subtitle')}
          </p>
        </CardHeader>

        <CardContent className="space-y-6">
          {twoFactor ? (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <ErrorBanner message={error} />
              <div className="flex items-center gap-3 p-3 rounded-md bg-[#EFF6FF] border border-[#2563EB]/20">
                <ShieldCheck className="w-5 h-5 text-[#2563EB] shrink-0" />
                <p className="text-sm text-[#0F172A]">{t('twoFactor.noticeBanner')}</p>
              </div>

              <div className="space-y-2">
                <label htmlFor="otp" className="text-sm font-medium">{t('twoFactor.codeLabel')}</label>
                <Input
                  id="otp"
                  inputMode="numeric"
                  pattern="\d{6}"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="tracking-[0.5em] text-center font-mono text-lg"
                  maxLength={6}
                  required
                />
              </div>

              <Button
                type="submit"
                className="w-full bg-[#2563EB] hover:bg-[#1d4ed8]"
                disabled={verifying || otp.length !== 6}
              >
                {verifying ? t('twoFactor.verifying') : t('twoFactor.verify')}
              </Button>

              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={resending}
                  className="text-[#2563EB] hover:underline disabled:opacity-50"
                >
                  {resending ? t('twoFactor.resending') : t('twoFactor.resend')}
                </button>
                <button
                  type="button"
                  onClick={cancelTwoFactor}
                  className="text-muted-foreground hover:underline"
                >
                  {t('twoFactor.useDifferentAccount')}
                </button>
              </div>
            </form>
          ) : (
          <form onSubmit={handleLogin} className="space-y-4">
            <ErrorBanner message={error} />

            {/* Phase 3.14 — Company / Workspace / Tenant slug.
                Required. Normalized lowercase before send.
                @tenant-reviewed: phase314-frontend-tenant-login */}
            <div className="space-y-2">
              <label htmlFor="company" className="text-sm font-medium">{t('login.companyLabel', 'Company')}</label>
              <Input
                id="company"
                type="text"
                placeholder={t('login.companyPlaceholder', 'your-company')}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                required
                autoComplete="organization"
                inputMode="text"
                spellCheck={false}
              />
            </div>

            {/* Email Field */}
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">{t('login.emailLabel')}</label>
              <Input
                id="email"
                type="email"
                placeholder={t('login.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailTouched(true)}
                className={emailInvalid ? 'border-red-400 focus-visible:ring-red-400' : ''}
                required
                autoComplete="email"
              />
              {emailInvalid && <p className="text-xs text-red-500">{t('login.emailInvalid')}</p>}
            </div>

            {/* Password Field */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="text-sm font-medium">{t('login.passwordLabel')}</label>
                <Link to="/forgot-password" className="text-sm text-[#2563EB] hover:underline">
                  {t('login.forgot')}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder={t('login.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <Button
              type="submit"
              className="w-full bg-[#2563EB] hover:bg-[#1d4ed8]"
              disabled={loading}
            >
              {loading ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>
          )}

          {!twoFactor && (
          <>
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t"></div>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-2 text-muted-foreground">{t('login.or')}</span>
            </div>
          </div>

          <div className="text-center space-y-3">
            <p className="text-sm text-muted-foreground">{t('login.lookingForJob')}</p>
            <Link to="/apply">
              <Button variant="outline" className="w-full">{t('login.submitApplication')}</Button>
            </Link>
          </div>
          </>
          )}
        </CardContent>
      </Card>

      <div className="absolute bottom-4 text-center text-sm text-muted-foreground">
        <p>{t('common:branding.copyright', { year: 2026, company: branding.companyName })} - {t('common:branding.secureAccess')}</p>
      </div>
    </div>
  );
}
