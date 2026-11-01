import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Briefcase, ChevronLeft, Linkedin, Facebook, Mail } from 'lucide-react';
import { useBranding } from '../../hooks/useBranding';
import { resolveAssetUrl } from '../../services/api';
import { LanguageSwitcher } from '../../../i18n/LanguageSwitcher';

export function DataProcessingAgreement() {
  const branding = useBranding();
  const { t } = useTranslation('public');
  const logoSrc = branding.logoUrl ? resolveAssetUrl(branding.logoUrl) : null;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header — same layout as the other public pages */}
      <header className="bg-white border-b shadow-sm">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#2563EB] rounded-lg flex items-center justify-center overflow-hidden">
              {logoSrc ? (
                <img src={logoSrc} alt="Logo" className="w-full h-full object-cover" />
              ) : (
                <Briefcase className="w-5 h-5 text-white" />
              )}
            </div>
            <div>
              <p className="font-bold text-gray-900 leading-tight">{branding.companyName}</p>
              <p className="text-xs text-gray-500">{t('dpa.headerTitle')}</p>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Link to="/" className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900">
              <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
              {t('dpa.backToHome')}
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 py-12 px-6">
        <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border p-8 md:p-10 font-serif text-sm leading-relaxed text-gray-900">
          <h1 className="text-xl font-bold text-center mb-2">{t('dpa.title')}</h1>
          <h2 className="text-lg font-bold text-center mb-8">{t('dpa.subtitle')}</h2>

          <p className="mb-1">{t('dpa.employerLabel')}</p>
          <p className="font-bold">{t('dpa.controllerCompany')}</p>
          <p className="font-bold">{t('dpa.controllerAddress1')}</p>
          <p className="font-bold">{t('dpa.controllerAddress2')}</p>
          <p className="font-bold">Bratislava</p>
          <p className="font-bold mb-4">{t('dpa.companyIdLabel')}</p>
          <p className="font-bold mb-8">{t('dpa.court')}</p>

          <h3 className="font-bold mb-3">{t('dpa.section1Heading')}</h3>
          <p className="mb-3 ms-4">{t('dpa.section1p1')}<strong>{t('dpa.section1p1bold1')}</strong>{t('dpa.section1p1mid')}<strong>{t('dpa.section1p1bold2')}</strong></p>
          <p className="mb-6 ms-4">{t('dpa.section1p2')}</p>

          <h3 className="font-bold mb-3">{t('dpa.section2Heading')}</h3>
          <p className="mb-3 ms-4">{t('dpa.section2p1')}</p>
          <div className="ms-8 mb-3">
            <p className="mb-1">{t('dpa.section2p1aHeading')}</p>
            <ul className="list-[lower-alpha] ms-6 space-y-0.5">
              {(['i01','i02','i03','i04','i05','i06','i07','i08','i09','i10','i11','i12','i13','i14'] as const).map(k => (
                <li key={k}>{t(`dpa.section2p1aItems.${k}`)}</li>
              ))}
            </ul>
          </div>
          <div className="ms-8 mb-4">
            <p className="mb-1">{t('dpa.section2p1bHeading')}</p>
            <ul className="list-[lower-alpha] ms-6 space-y-0.5">
              {(['i01','i02','i03'] as const).map(k => (
                <li key={k}>{t(`dpa.section2p1bItems.${k}`)}</li>
              ))}
            </ul>
          </div>
          <p className="mb-3 ms-4">{t('dpa.section2p2')}</p>
          <p className="mb-3 ms-4">{t('dpa.section2p3')}</p>
          <p className="mb-3 ms-4">{t('dpa.section2p4')}</p>
          <p className="mb-3 ms-4">{t('dpa.section2p5')}</p>
          <p className="mb-3 ms-4">{t('dpa.section2p6')}</p>
          <p className="mb-6 ms-4">{t('dpa.section2p7')}</p>

          <h3 className="font-bold mb-3">{t('dpa.section3Heading')}</h3>
          <p className="mb-3 ms-4">{t('dpa.section3p1')}</p>
          <p className="mb-3 ms-4">{t('dpa.section3p2')}</p>
          <p className="mb-3 ms-4">{t('dpa.section3p3')}</p>
          <p className="mb-6 ms-4">{t('dpa.section3p4')}</p>

          <h3 className="font-bold mb-3">{t('dpa.section4Heading')}</h3>
          <p className="mb-3 ms-4">{t('dpa.section4p1')}</p>
          <div className="ms-8 mb-6 space-y-2">
            <p>{t('dpa.section4p1a')}</p>
            <p>{t('dpa.section4p1b')}</p>
            <p>{t('dpa.section4p1c')}</p>
            <p>{t('dpa.section4p1d')}</p>
          </div>

          <h3 className="font-bold mb-3">{t('dpa.section5Heading')}</h3>
          <p className="mb-3 ms-4">{t('dpa.section5p1')}</p>
          <div className="ms-8 mb-3 space-y-2">
            <p>{t('dpa.section5p1a')}</p>
            <p>{t('dpa.section5p1b')}</p>
          </div>
          <p className="mb-3 ms-4">{t('dpa.section5p2')}</p>
          <p className="mb-3 ms-4">{t('dpa.section5p3')}</p>
          <p className="mb-3 ms-4">{t('dpa.section5p4')}</p>
          <p className="mb-6 ms-4">{t('dpa.section5p5')}</p>

          <h3 className="font-bold mb-3">{t('dpa.section6Heading')}</h3>
          <p className="mb-3 ms-4">{t('dpa.section6p1')}</p>
          <p className="mb-3 ms-4">{t('dpa.section6p2')}</p>
          <p className="mb-3 ms-4">{t('dpa.section6p3')}</p>
          <p className="mb-3 ms-4">{t('dpa.section6p4')}</p>
          <p className="mb-6 ms-4">{t('dpa.section6p5')}</p>

          <h3 className="font-bold mb-3">{t('dpa.section7Heading')}</h3>
          <p className="mb-3 ms-4">{t('dpa.section7p1')}</p>
          <p className="mb-3 ms-4">{t('dpa.section7p2')}</p>
          <p className="mb-6 ms-4">{t('dpa.section7p3')}</p>

          <p className="mt-8 font-semibold text-center border-t pt-6">{t('dpa.consentLine')}</p>
        </div>
      </main>

      {/* Footer — same style as LandingPage */}
      <footer className="bg-[#0F172A] text-white py-12 font-sans">
        <div className="max-w-5xl mx-auto px-6">
          <div className="grid md:grid-cols-4 gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-[#2563EB] flex items-center justify-center overflow-hidden">
                  {logoSrc ? <img src={logoSrc} alt="Logo" className="w-full h-full object-cover" /> : <Briefcase className="w-5 h-5 text-white" />}
                </div>
                <span className="font-bold">{branding.companyName}</span>
              </div>
              <p className="text-sm text-gray-400 mb-4">{branding.footerTagline}</p>
              <div className="flex items-center gap-3">
                <a href={branding.linkedIn} target="_blank" rel="noopener noreferrer" className="hover:text-[#2563EB] transition-colors">
                  <Linkedin className="w-5 h-5" />
                </a>
                <a href={branding.facebook} target="_blank" rel="noopener noreferrer" className="hover:text-[#2563EB] transition-colors">
                  <Facebook className="w-5 h-5" />
                </a>
                <a href={`mailto:${branding.emailInfo}`} className="hover:text-[#2563EB] transition-colors">
                  <Mail className="w-5 h-5" />
                </a>
              </div>
            </div>

            <div>
              <h4 className="font-bold mb-4">{t('dpa.footerCompany')}</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><Link to="/" className="hover:text-white transition-colors">{t('dpa.footerHome')}</Link></li>
                <li><Link to="/jobs" className="hover:text-white transition-colors">{t('dpa.footerJobs')}</Link></li>
                <li><Link to="/apply" className="hover:text-white transition-colors">{t('dpa.footerApply')}</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold mb-4">{t('dpa.footerContact')}</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li>{branding.address}</li>
                <li>{branding.phone1}</li>
                <li>
                  <a href={`mailto:${branding.emailInfo}`} className="hover:text-white transition-colors">
                    {branding.emailInfo}
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold mb-4">{t('dpa.footerLegal')}</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><Link to="/data-processing-agreement" className="hover:text-white transition-colors">{t('dpa.footerDpaLink')}</Link></li>
                <li><Link to="/login" className="hover:text-white transition-colors">{t('dpa.footerStaffLogin')}</Link></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-gray-800 pt-8">
            <div className="grid md:grid-cols-2 gap-4 text-sm text-gray-400">
              <p>&copy; {new Date().getFullYear()} {branding.companyName}. {t('dpa.rightsReserved')}</p>
              <p className="md:text-end">{branding.vatInfo}</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
