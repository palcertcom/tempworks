import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { CheckCircle, Home, Mail, Clock, FileText } from 'lucide-react';

export function ApplicationSuccess() {
  const applicationId = `APP-${Date.now().toString().slice(-8)}`;
  const { t } = useTranslation('public');

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#EFF6FF] to-white flex items-center justify-center p-4">
      <Card className="max-w-2xl w-full">
        <CardContent className="p-12 text-center">
          {/* Success Icon */}
          <div className="w-20 h-20 rounded-full bg-[#F0FDF4] flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-12 h-12 text-[#22C55E]" />
          </div>

          {/* Title */}
          <h1 className="text-3xl font-bold text-[#0F172A] mb-4">
            {t('applicationSuccess.title')}
          </h1>

          {/* Application ID */}
          <div className="inline-block bg-[#F8FAFC] px-4 py-2 rounded-lg mb-6">
            <p className="text-sm text-muted-foreground">{t('applicationSuccess.reference')}</p>
            <p className="text-xl font-semibold text-[#2563EB]">{applicationId}</p>
          </div>

          {/* Message */}
          <p className="text-lg text-muted-foreground mb-8 max-w-xl mx-auto">
            {t('applicationSuccess.body')}
          </p>

          {/* What's Next */}
          <div className="bg-[#F8FAFC] rounded-lg p-6 mb-8 text-start">
            <h2 className="font-semibold text-lg mb-4 text-center">{t('applicationSuccess.whatsNextTitle')}</h2>

            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-[#EFF6FF] flex items-center justify-center flex-shrink-0">
                  <Mail className="w-5 h-5 text-[#2563EB]" />
                </div>
                <div>
                  <h3 className="font-medium mb-1">{t('applicationSuccess.step1Title')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('applicationSuccess.step1Body')}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-[#FEF3C7] flex items-center justify-center flex-shrink-0">
                  <Clock className="w-5 h-5 text-[#F59E0B]" />
                </div>
                <div>
                  <h3 className="font-medium mb-1">{t('applicationSuccess.step2Title')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('applicationSuccess.step2Body')}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-[#F0FDF4] flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-[#22C55E]" />
                </div>
                <div>
                  <h3 className="font-medium mb-1">{t('applicationSuccess.step3Title')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('applicationSuccess.step3Body')}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Important Notice */}
          <div className="bg-[#FEF3C7] border border-[#F59E0B] rounded-lg p-4 mb-8">
            <p className="text-sm text-[#92400E]">
              <strong>{t('applicationSuccess.importantLabel')}</strong>{' '}
              {t('applicationSuccess.importantBody')}
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link to="/">
              <Button variant="outline" className="gap-2">
                <Home className="w-4 h-4" />
                {t('applicationSuccess.returnHome')}
              </Button>
            </Link>
            <Button className="bg-[#2563EB] hover:bg-[#1d4ed8]">
              <Mail className="w-4 h-4 me-2" />
              {t('applicationSuccess.contactSupport')}
            </Button>
          </div>

          {/* Footer Note */}
          <p className="text-sm text-muted-foreground mt-8">
            {t('applicationSuccess.questionsPrefix')}{' '}
            <a href="mailto:recruitment@tempworks.eu" className="text-[#2563EB] hover:underline">
              recruitment@tempworks.eu
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
