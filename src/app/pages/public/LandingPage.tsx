import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import {
  CheckCircle,
  TrendingUp,
  Globe,
  Shield,
  Clock,
  Users,
  ArrowRight,
  FileText,
  Briefcase,
  MapPin,
  Target,
  Heart,
  Lightbulb,
  Handshake,
  UserPlus,
  BarChart3,
  Megaphone,
  Cpu,
  Truck,
  Package,
  Warehouse,
  Mail,
  Phone,
  Linkedin,
  Facebook,
} from 'lucide-react';
import { useBranding } from '../../hooks/useBranding';
import { resolveAssetUrl } from '../../services/api';
import { LanguageSwitcher } from '../../../i18n/LanguageSwitcher';

export function LandingPage() {
  const branding = useBranding();
  const { t } = useTranslation('public');
  const logoSrc = branding.logoUrl ? resolveAssetUrl(branding.logoUrl) : undefined;

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="border-b bg-white sticky top-0 z-50 shadow-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#2563EB] flex items-center justify-center overflow-hidden">
                {logoSrc ? <img src={logoSrc} alt="Logo" className="w-full h-full object-cover" /> : <Briefcase className="w-6 h-6 text-white" />}
              </div>
              <div>
                <span className="text-xl font-bold text-[#0F172A]">{branding.companyName}</span>
                <p className="text-xs text-muted-foreground">{branding.tagline}</p>
              </div>
            </div>
            <nav className="hidden md:flex items-center gap-8">
              <a href="#home" className="text-sm font-medium text-[#0F172A] hover:text-[#2563EB] transition-colors">
                {t('landing.nav.home')}
              </a>
              <a href="#about" className="text-sm font-medium text-[#0F172A] hover:text-[#2563EB] transition-colors">
                {t('landing.nav.about')}
              </a>
              <a href="#services" className="text-sm font-medium text-[#0F172A] hover:text-[#2563EB] transition-colors">
                {t('landing.nav.services')}
              </a>
              <a href="#jobs" className="text-sm font-medium text-[#0F172A] hover:text-[#2563EB] transition-colors">
                {t('landing.nav.jobs')}
              </a>
              <a href="#contact" className="text-sm font-medium text-[#0F172A] hover:text-[#2563EB] transition-colors">
                {t('landing.nav.contact')}
              </a>
              <LanguageSwitcher />
              <Link to="/login">
                <Button variant="outline" size="sm">{t('landing.nav.login')}</Button>
              </Link>
            </nav>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section id="home" className="bg-gradient-to-br from-[#EFF6FF] via-white to-[#F0F9FF] py-20 md:py-32">
        <div className="container mx-auto px-4">
          <div className="max-w-5xl mx-auto">
            <div className="grid md:grid-cols-2 gap-12 items-center">
              <div>
                <div className="inline-block px-4 py-2 bg-[#2563EB]/10 rounded-full mb-6">
                  <span className="text-sm font-semibold text-[#2563EB]">{branding.heroBadge}</span>
                </div>
                <h1 className="text-5xl md:text-6xl font-bold text-[#0F172A] mb-6 leading-tight">
                  {branding.heroHeadline}
                </h1>
                <p className="text-xl text-muted-foreground mb-8">
                  {branding.heroDescription}
                </p>
                <div className="flex flex-col sm:flex-row items-start gap-4">
                  <Link to="/apply">
                    <Button size="lg" className="bg-[#2563EB] hover:bg-[#1d4ed8] text-white px-8 py-6 text-lg">
                      {t('landing.hero.applyNow')}
                      <ArrowRight className="w-5 h-5 ms-2 rtl:rotate-180" />
                    </Button>
                  </Link>
                  <Link to="/jobs">
                    <Button size="lg" variant="outline" className="px-8 py-6 text-lg">
                      {t('landing.hero.exploreJobs')}
                    </Button>
                  </Link>
                  <Link to="/login">
                    <Button size="lg" variant="ghost" className="px-8 py-6 text-lg">
                      {t('landing.hero.login')}
                    </Button>
                  </Link>
                </div>
              </div>
              <div className="relative">
                <div className="bg-gradient-to-br from-[#2563EB] to-[#1d4ed8] rounded-2xl p-8 shadow-2xl">
                  <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 mb-4">
                    <div className="flex items-center gap-3 mb-2">
                      <CheckCircle className="w-6 h-6 text-white" />
                      <span className="text-white font-semibold">{t('landing.hero.card1Title')}</span>
                    </div>
                    <p className="text-white/80 text-sm">{t('landing.hero.card1Body')}</p>
                  </div>
                  <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 mb-4">
                    <div className="flex items-center gap-3 mb-2">
                      <Globe className="w-6 h-6 text-white" />
                      <span className="text-white font-semibold">{t('landing.hero.card2Title')}</span>
                    </div>
                    <p className="text-white/80 text-sm">{t('landing.hero.card2Body')}</p>
                  </div>
                  <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6">
                    <div className="flex items-center gap-3 mb-2">
                      <Users className="w-6 h-6 text-white" />
                      <span className="text-white font-semibold">{t('landing.hero.card3Title')}</span>
                    </div>
                    <p className="text-white/80 text-sm">{t('landing.hero.card3Body')}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* About Our Company */}
      <section id="about" className="py-20 bg-white">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <h2 className="text-4xl font-bold text-[#0F172A] mb-4">{t('landing.about.title')}</h2>
              <div className="w-20 h-1 bg-[#2563EB] mx-auto mb-6"></div>
              <p className="text-lg text-muted-foreground max-w-3xl mx-auto">
                {t('landing.about.body')}
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-8 mt-12">
              <div className="text-center">
                <div className="w-20 h-20 rounded-full bg-[#EFF6FF] flex items-center justify-center mx-auto mb-4">
                  <Target className="w-10 h-10 text-[#2563EB]" />
                </div>
                <h3 className="text-2xl font-bold text-[#0F172A] mb-2">{branding.statPlacements}</h3>
                <p className="text-muted-foreground">{t('landing.about.successfulPlacements')}</p>
              </div>
              <div className="text-center">
                <div className="w-20 h-20 rounded-full bg-[#F0FDF4] flex items-center justify-center mx-auto mb-4">
                  <Briefcase className="w-10 h-10 text-[#22C55E]" />
                </div>
                <h3 className="text-2xl font-bold text-[#0F172A] mb-2">{branding.statPartners}</h3>
                <p className="text-muted-foreground">{t('landing.about.partnerCompanies')}</p>
              </div>
              <div className="text-center">
                <div className="w-20 h-20 rounded-full bg-[#FEF3C7] flex items-center justify-center mx-auto mb-4">
                  <Globe className="w-10 h-10 text-[#F59E0B]" />
                </div>
                <h3 className="text-2xl font-bold text-[#0F172A] mb-2">{branding.statCountries}</h3>
                <p className="text-muted-foreground">{t('landing.about.countriesServed')}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Our Values */}
      <section className="py-20 bg-[#F8FAFC]">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-[#0F172A] mb-4">{t('landing.values.title')}</h2>
            <div className="w-20 h-1 bg-[#2563EB] mx-auto mb-6"></div>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              {t('landing.values.subtitle')}
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
            <Card className="border-2 hover:border-[#2563EB] transition-all hover:shadow-lg">
              <CardContent className="p-8">
                <div className="w-16 h-16 rounded-lg bg-[#EFF6FF] flex items-center justify-center mb-4">
                  <Shield className="w-8 h-8 text-[#2563EB]" />
                </div>
                <h3 className="text-xl font-bold mb-3">{t('landing.values.trust')}</h3>
                <p className="text-muted-foreground">
                  {t('landing.values.trustBody')}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 hover:border-[#22C55E] transition-all hover:shadow-lg">
              <CardContent className="p-8">
                <div className="w-16 h-16 rounded-lg bg-[#F0FDF4] flex items-center justify-center mb-4">
                  <Heart className="w-8 h-8 text-[#22C55E]" />
                </div>
                <h3 className="text-xl font-bold mb-3">{t('landing.values.empowering')}</h3>
                <p className="text-muted-foreground">
                  {t('landing.values.empoweringBody')}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 hover:border-[#F59E0B] transition-all hover:shadow-lg">
              <CardContent className="p-8">
                <div className="w-16 h-16 rounded-lg bg-[#FEF3C7] flex items-center justify-center mb-4">
                  <Lightbulb className="w-8 h-8 text-[#F59E0B]" />
                </div>
                <h3 className="text-xl font-bold mb-3">{t('landing.values.innovation')}</h3>
                <p className="text-muted-foreground">
                  {t('landing.values.innovationBody')}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 hover:border-[#2563EB] transition-all hover:shadow-lg">
              <CardContent className="p-8">
                <div className="w-16 h-16 rounded-lg bg-[#EFF6FF] flex items-center justify-center mb-4">
                  <Handshake className="w-8 h-8 text-[#2563EB]" />
                </div>
                <h3 className="text-xl font-bold mb-3">{t('landing.values.partnerships')}</h3>
                <p className="text-muted-foreground">
                  {t('landing.values.partnershipsBody')}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Our Services */}
      <section id="services" className="py-20 bg-white">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-[#0F172A] mb-4">{t('landing.services.title')}</h2>
            <div className="w-20 h-1 bg-[#2563EB] mx-auto mb-6"></div>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              {t('landing.services.subtitle')}
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-6xl mx-auto">
            <Card className="border-2 hover:shadow-xl transition-all group">
              <CardContent className="p-8 text-center">
                <div className="w-20 h-20 rounded-full bg-[#EFF6FF] flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                  <UserPlus className="w-10 h-10 text-[#2563EB]" />
                </div>
                <h3 className="text-xl font-bold mb-3">{t('landing.services.talent')}</h3>
                <p className="text-muted-foreground">
                  {t('landing.services.talentBody')}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 hover:shadow-xl transition-all group">
              <CardContent className="p-8 text-center">
                <div className="w-20 h-20 rounded-full bg-[#F0FDF4] flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                  <Users className="w-10 h-10 text-[#22C55E]" />
                </div>
                <h3 className="text-xl font-bold mb-3">{t('landing.services.workforce')}</h3>
                <p className="text-muted-foreground">
                  {t('landing.services.workforceBody')}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 hover:shadow-xl transition-all group">
              <CardContent className="p-8 text-center">
                <div className="w-20 h-20 rounded-full bg-[#FEF3C7] flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                  <Megaphone className="w-10 h-10 text-[#F59E0B]" />
                </div>
                <h3 className="text-xl font-bold mb-3">{t('landing.services.marketing')}</h3>
                <p className="text-muted-foreground">
                  {t('landing.services.marketingBody')}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 hover:shadow-xl transition-all group">
              <CardContent className="p-8 text-center">
                <div className="w-20 h-20 rounded-full bg-[#F5F3FF] flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                  <Cpu className="w-10 h-10 text-[#8B5CF6]" />
                </div>
                <h3 className="text-xl font-bold mb-3">{t('landing.services.techHiring')}</h3>
                <p className="text-muted-foreground">
                  {t('landing.services.techHiringBody')}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Job Opportunities */}
      <section id="jobs" className="py-20 bg-[#F8FAFC]">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-[#0F172A] mb-4">{t('landing.jobs.title')}</h2>
            <div className="w-20 h-1 bg-[#2563EB] mx-auto mb-6"></div>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              {t('landing.jobs.subtitle')}
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {[
              {
                title: 'Truck Driver (HGV Class 1)',
                location: 'Munich, Germany',
                type: 'Full-time',
                salary: '€3,200 - €4,500/month',
                icon: Truck,
                color: 'bg-[#EFF6FF] text-[#2563EB]'
              },
              {
                title: 'Forklift Operator',
                location: 'Hamburg, Germany',
                type: 'Full-time',
                salary: '€2,800 - €3,500/month',
                icon: Package,
                color: 'bg-[#F0FDF4] text-[#22C55E]'
              },
              {
                title: 'Logistics Worker',
                location: 'Berlin, Germany',
                type: 'Full-time',
                salary: '€2,500 - €3,200/month',
                icon: Warehouse,
                color: 'bg-[#FEF3C7] text-[#F59E0B]'
              },
              {
                title: 'Production Worker',
                location: 'Frankfurt, Germany',
                type: 'Full-time',
                salary: '€2,600 - €3,400/month',
                icon: Briefcase,
                color: 'bg-[#F5F3FF] text-[#8B5CF6]'
              }
            ].map((job, index) => {
              const IconComponent = job.icon;
              return (
                <Card key={index} className="border-2 hover:border-[#2563EB] transition-all hover:shadow-lg">
                  <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                      <div className={`w-14 h-14 rounded-lg ${job.color} flex items-center justify-center flex-shrink-0`}>
                        <IconComponent className="w-7 h-7" />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-xl font-bold mb-2">{job.title}</h3>
                        <div className="space-y-1 mb-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <MapPin className="w-4 h-4" />
                            {job.location}
                          </div>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Clock className="w-4 h-4" />
                            {job.type}
                          </div>
                          <div className="flex items-center gap-2 text-sm font-semibold text-[#22C55E]">
                            <TrendingUp className="w-4 h-4" />
                            {job.salary}
                          </div>
                        </div>
                        <Link to="/apply">
                          <Button className="w-full bg-[#2563EB] hover:bg-[#1d4ed8]">
                            {t('landing.jobs.applyNow')}
                            <ArrowRight className="w-4 h-4 ms-2 rtl:rotate-180" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="text-center mt-10">
            <Link to="/jobs">
              <Button size="lg" variant="outline" className="px-8">
                {t('landing.jobs.viewAll')}
                <ArrowRight className="w-5 h-5 ms-2 rtl:rotate-180" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Career Application CTA */}
      <section className="py-20 bg-gradient-to-br from-[#2563EB] to-[#1d4ed8] text-white relative overflow-hidden">
        <div className="absolute inset-0 bg-grid-white/[0.05] bg-[size:20px_20px]"></div>
        <div className="container mx-auto px-4 text-center relative z-10">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-4xl md:text-5xl font-bold mb-6">
              {t('landing.cta.title')}
            </h2>
            <p className="text-xl mb-8 opacity-90">
              {t('landing.cta.body')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link to="/apply">
                <Button size="lg" className="bg-white text-[#2563EB] hover:bg-gray-100 px-8 py-6 text-lg font-semibold">
                  {t('landing.cta.applyNow')}
                  <ArrowRight className="w-5 h-5 ms-2 rtl:rotate-180" />
                </Button>
              </Link>
              <a href="#contact">
                <Button size="lg" variant="outline" className="border-white text-white hover:bg-white/10 px-8 py-6 text-lg">
                  {t('landing.cta.contactUs')}
                </Button>
              </a>
            </div>
            <div className="grid md:grid-cols-3 gap-8 mt-12">
              <div>
                <div className="text-3xl font-bold mb-2">100%</div>
                <div className="text-white/80">{t('landing.cta.legalProcess')}</div>
              </div>
              <div>
                <div className="text-3xl font-bold mb-2">24/7</div>
                <div className="text-white/80">{t('landing.cta.supportAvailable')}</div>
              </div>
              <div>
                <div className="text-3xl font-bold mb-2">{branding.statPlacements}</div>
                <div className="text-white/80">{t('landing.cta.successfulPlacements')}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Contact Section */}
      <section id="contact" className="py-20 bg-white">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto text-center mb-12">
            <h2 className="text-4xl font-bold text-[#0F172A] mb-4">{t('landing.contact.title')}</h2>
            <div className="w-20 h-1 bg-[#2563EB] mx-auto mb-6"></div>
            <p className="text-lg text-muted-foreground">
              {t('landing.contact.subtitle')}
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto mb-12">
            <Card className="border-2 hover:border-[#2563EB] transition-all">
              <CardContent className="p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-[#EFF6FF] flex items-center justify-center mx-auto mb-4">
                  <MapPin className="w-8 h-8 text-[#2563EB]" />
                </div>
                <h3 className="font-bold mb-3">{t('landing.contact.headOffice')}</h3>
                <p className="text-sm text-muted-foreground">{branding.address}</p>
              </CardContent>
            </Card>

            <Card className="border-2 hover:border-[#2563EB] transition-all">
              <CardContent className="p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-[#EFF6FF] flex items-center justify-center mx-auto mb-4">
                  <Mail className="w-8 h-8 text-[#2563EB]" />
                </div>
                <h3 className="font-bold mb-3">{t('landing.contact.emailUs')}</h3>
                <p className="text-sm text-muted-foreground">
                  {branding.emailInfo}<br />
                  {branding.emailRecruitment}<br />
                  {branding.emailSupport}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 hover:border-[#2563EB] transition-all">
              <CardContent className="p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-[#EFF6FF] flex items-center justify-center mx-auto mb-4">
                  <Phone className="w-8 h-8 text-[#2563EB]" />
                </div>
                <h3 className="font-bold mb-3">{t('landing.contact.callUs')}</h3>
                <p className="text-sm text-muted-foreground">
                  {branding.phone1}<br />
                  {branding.phone2}<br />
                  {t('landing.contact.hours')}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Social Media */}
          <div className="text-center">
            <h3 className="font-bold mb-4">{t('landing.contact.connect')}</h3>
            <div className="flex items-center justify-center gap-4">
              <a href={branding.linkedIn} target="_blank" rel="noopener noreferrer"
                 className="w-12 h-12 rounded-full bg-[#0A66C2] flex items-center justify-center hover:scale-110 transition-transform">
                <Linkedin className="w-6 h-6 text-white" />
              </a>
              <a href={branding.facebook} target="_blank" rel="noopener noreferrer"
                 className="w-12 h-12 rounded-full bg-[#1877F2] flex items-center justify-center hover:scale-110 transition-transform">
                <Facebook className="w-6 h-6 text-white" />
              </a>
              <a href={`mailto:${branding.emailInfo}`}
                 className="w-12 h-12 rounded-full bg-[#EA4335] flex items-center justify-center hover:scale-110 transition-transform">
                <Mail className="w-6 h-6 text-white" />
              </a>
              <a href={`tel:${branding.phone1.replace(/\s/g, '')}`}
                 className="w-12 h-12 rounded-full bg-[#22C55E] flex items-center justify-center hover:scale-110 transition-transform">
                <Phone className="w-6 h-6 text-white" />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#0F172A] text-white py-12">
        <div className="container mx-auto px-4">
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
              <h4 className="font-bold mb-4">{t('landing.footer.company')}</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><a href="#about" className="hover:text-white transition-colors">{t('landing.footer.aboutUs')}</a></li>
                <li><a href="#services" className="hover:text-white transition-colors">{t('landing.footer.ourServices')}</a></li>
                <li><Link to="/jobs" className="hover:text-white transition-colors">{t('landing.footer.jobOpportunities')}</Link></li>
                <li><a href="#contact" className="hover:text-white transition-colors">{t('landing.footer.contact')}</a></li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold mb-4">{t('landing.footer.forCandidates')}</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li>
                  <Link to="/apply" className="hover:text-white transition-colors">
                    {t('landing.footer.applyNow')}
                  </Link>
                </li>
                <li><Link to="/jobs" className="hover:text-white transition-colors">{t('landing.footer.browseJobs')}</Link></li>
                <li>
                  <Link to="/login" className="hover:text-white transition-colors">
                    {t('landing.footer.candidateLogin')}
                  </Link>
                </li>
                <li><a href="#" className="hover:text-white transition-colors">{t('landing.footer.faq')}</a></li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold mb-4">{t('landing.footer.legal')}</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><a href="#" className="hover:text-white transition-colors">{t('landing.footer.privacyPolicy')}</a></li>
                <li><a href="#" className="hover:text-white transition-colors">{t('landing.footer.termsOfService')}</a></li>
                <li><a href="#" className="hover:text-white transition-colors">{t('landing.footer.cookiePolicy')}</a></li>
                <li><a href="#" className="hover:text-white transition-colors">{t('landing.footer.gdpr')}</a></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-gray-800 pt-8">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="text-sm text-gray-400">
                <p>&copy; 2026 {branding.companyName}. {t('landing.footer.rightsReserved')}</p>
                <p className="mt-1">{branding.vatInfo}</p>
              </div>
              <div className="text-sm text-gray-400 md:text-end">
                <p>{branding.address}</p>
                <p className="mt-1">Tel: {branding.phone1} | Email: {branding.emailInfo}</p>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}