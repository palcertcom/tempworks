import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Briefcase, ArrowLeft, CheckCircle } from 'lucide-react';
import { authApi, resolveAssetUrl } from '../../services/api';
import { useBranding } from '../../hooks/useBranding';
import { ReCaptchaV2 } from '../../components/ui/ReCaptchaV2';
import { LanguageSwitcher } from '../../../i18n/LanguageSwitcher';

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string;

export function ForgotPasswordPage() {
  const branding = useBranding();
  const { t } = useTranslation(['auth', 'common']);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!captchaToken) return;
    setLoading(true);
    try {
      await authApi.forgotPassword(email, captchaToken);
    } catch {
      // Intentionally swallow error to prevent enumeration
    } finally {
      setLoading(false);
      setSubmitted(true);
      setCaptchaToken(null);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#EFF6FF] to-white flex items-center justify-center p-4">
      <div className="absolute top-4 start-4">
        <Link to="/login">
          <Button variant="ghost" className="gap-2">
            <ArrowLeft className="w-4 h-4 rtl:rotate-180" />
            {t('forgot.backToLogin')}
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
          <CardTitle className="text-2xl">{t('forgot.title')}</CardTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {t('forgot.subtitle')}
          </p>
        </CardHeader>

        <CardContent className="space-y-6">
          {submitted ? (
            <div className="space-y-6">
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <p className="text-sm text-center text-muted-foreground leading-relaxed">
                  {t('forgot.successMessage', { email })}
                </p>
              </div>
              <Link to="/login">
                <Button variant="outline" className="w-full">
                  {t('forgot.backToLogin')}
                </Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">
                  {t('forgot.emailLabel')}
                </label>
                <Input
                  id="email"
                  type="email"
                  placeholder={t('forgot.emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>

              <div className="flex justify-center">
                <ReCaptchaV2
                  siteKey={RECAPTCHA_SITE_KEY}
                  onVerify={(token) => setCaptchaToken(token)}
                  onExpired={() => setCaptchaToken(null)}
                />
              </div>

              <Button
                type="submit"
                className="w-full bg-[#2563EB] hover:bg-[#1d4ed8]"
                disabled={loading || !captchaToken}
                title={!captchaToken ? t('forgot.captchaTooltip') : undefined}
              >
                {loading ? t('forgot.submitting') : t('forgot.submit')}
              </Button>

              <div className="text-center">
                <Link to="/login" className="text-sm text-[#2563EB] hover:underline">
                  {t('forgot.backToLogin')}
                </Link>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <div className="absolute bottom-4 text-center text-sm text-muted-foreground">
        <p>{t('common:branding.copyright', { year: 2026, company: branding.companyName })} - {t('common:branding.secureAccess')}</p>
      </div>
    </div>
  );
}
