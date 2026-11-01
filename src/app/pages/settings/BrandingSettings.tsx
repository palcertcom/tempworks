import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Upload, Save, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { settingsApi, resolveAssetUrl } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { invalidateBrandingCache, BRANDING_DEFAULTS } from '../../hooks/useBranding';
import { cn } from '../../components/ui/utils';

interface BrandingForm {
  companyName: string;
  tagline: string;
  heroBadge: string;
  heroHeadline: string;
  heroDescription: string;
  statPlacements: string;
  statPartners: string;
  statCountries: string;
  address: string;
  phone1: string;
  phone2: string;
  emailInfo: string;
  emailRecruitment: string;
  emailSupport: string;
  linkedIn: string;
  facebook: string;
  footerTagline: string;
  vatInfo: string;
}

const EMPTY_FORM: BrandingForm = {
  companyName: '', tagline: '', heroBadge: '', heroHeadline: '', heroDescription: '',
  statPlacements: '', statPartners: '', statCountries: '',
  address: '', phone1: '', phone2: '',
  emailInfo: '', emailRecruitment: '', emailSupport: '',
  linkedIn: '', facebook: '', footerTagline: '', vatInfo: '',
};

export function BrandingSettings() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [form, setForm] = useState<BrandingForm>(EMPTY_FORM);
  const [logoUrl, setLogoUrl] = useState<string | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    settingsApi.getBranding().then(data => {
      const d = data as any;
      setForm({
        companyName:      d.companyName      || BRANDING_DEFAULTS.companyName,
        tagline:          d.tagline          || BRANDING_DEFAULTS.tagline,
        heroBadge:        d.heroBadge        || BRANDING_DEFAULTS.heroBadge,
        heroHeadline:     d.heroHeadline     || BRANDING_DEFAULTS.heroHeadline,
        heroDescription:  d.heroDescription  || BRANDING_DEFAULTS.heroDescription,
        statPlacements:   d.statPlacements   || BRANDING_DEFAULTS.statPlacements,
        statPartners:     d.statPartners     || BRANDING_DEFAULTS.statPartners,
        statCountries:    d.statCountries    || BRANDING_DEFAULTS.statCountries,
        address:          d.address          || BRANDING_DEFAULTS.address,
        phone1:           d.phone1           || BRANDING_DEFAULTS.phone1,
        phone2:           d.phone2           || BRANDING_DEFAULTS.phone2,
        emailInfo:        d.emailInfo        || BRANDING_DEFAULTS.emailInfo,
        emailRecruitment: d.emailRecruitment || BRANDING_DEFAULTS.emailRecruitment,
        emailSupport:     d.emailSupport     || BRANDING_DEFAULTS.emailSupport,
        linkedIn:         d.linkedIn         || BRANDING_DEFAULTS.linkedIn,
        facebook:         d.facebook         || BRANDING_DEFAULTS.facebook,
        footerTagline:    d.footerTagline    || BRANDING_DEFAULTS.footerTagline,
        vatInfo:          d.vatInfo          || BRANDING_DEFAULTS.vatInfo,
      });
      setLogoUrl(d.logoUrl);
    }).catch(() => {});
  }, []);

  const set = (key: keyof BrandingForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  const handleSave = async () => {
    if (!form.companyName.trim()) { toast.error(tc('toast.companyNameRequired')); return; }
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(form)) {
        payload[`branding.${k}`] = v;
      }
      await settingsApi.update(payload);
      invalidateBrandingCache();
      toast.success(tc('toast.savedSuccessfully'));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleUploadLogo = async () => {
    if (!selectedFile) return;
    setUploading(true);
    try {
      const result = await settingsApi.uploadLogo(selectedFile);
      setLogoUrl(result.logoUrl);
      setPreviewUrl(undefined);
      setSelectedFile(null);
      invalidateBrandingCache();
      toast.success(tc('toast.logoUploaded'));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.uploadFailed')));
    } finally {
      setUploading(false);
    }
  };

  const resolvedLogoUrl = previewUrl
    ? previewUrl
    : logoUrl
      ? resolveAssetUrl(logoUrl)
      : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/dashboard/settings">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 me-2" />{t('settings.branding.backToSettings')}</Button>
        </Link>
        <div>
          <h1 className="text-3xl font-semibold text-foreground">{t('settings.branding.headerTitle')}</h1>
          <p className="text-muted-foreground mt-1">{t('settings.branding.headerSubtitle')}</p>
        </div>
      </div>

      {/* Company Logo */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.branding.logoCardTitle')}</CardTitle>
          <CardDescription>{t('settings.branding.logoCardDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className={cn(
              "w-16 h-16 rounded-lg flex items-center justify-center overflow-hidden flex-shrink-0",
              resolvedLogoUrl ? "bg-transparent" : "bg-primary"
            )}>
              {resolvedLogoUrl ? (
                <img src={resolvedLogoUrl} alt={t('settings.branding.logoPreviewAlt')} className="w-full h-full object-contain" />
              ) : (
                <Building2 className="w-8 h-8 text-primary-foreground" />
              )}
            </div>
            <span className="text-sm text-muted-foreground">{logoUrl ? t('settings.branding.currentLogo') : t('settings.branding.noLogo')}</span>
          </div>
          <div className="flex items-center gap-3">
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="w-4 h-4 me-2" />{t('settings.branding.chooseFile')}
            </Button>
            {selectedFile && (
              <Button onClick={handleUploadLogo} disabled={uploading}>
                {uploading ? t('settings.branding.uploading') : t('settings.branding.uploadLogo')}
              </Button>
            )}
            {selectedFile && <span className="text-sm text-muted-foreground">{selectedFile.name}</span>}
          </div>
        </CardContent>
      </Card>

      {/* Core Identity */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.branding.identityCardTitle')}</CardTitle>
          <CardDescription>{t('settings.branding.identityCardDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{t('settings.branding.companyName')}</Label>
            <Input value={form.companyName} onChange={set('companyName')} placeholder={BRANDING_DEFAULTS.companyName} />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.branding.tagline')}</Label>
            <Input value={form.tagline} onChange={set('tagline')} placeholder={BRANDING_DEFAULTS.tagline} />
          </div>
        </CardContent>
      </Card>

      {/* Hero Section */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.branding.heroCardTitle')}</CardTitle>
          <CardDescription>{t('settings.branding.heroCardDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('settings.branding.badgeText')}</Label>
            <Input value={form.heroBadge} onChange={set('heroBadge')} placeholder={BRANDING_DEFAULTS.heroBadge} />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.branding.headline')}</Label>
            <Input value={form.heroHeadline} onChange={set('heroHeadline')} placeholder={BRANDING_DEFAULTS.heroHeadline} />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.branding.description')}</Label>
            <Textarea value={form.heroDescription} onChange={set('heroDescription')} placeholder={BRANDING_DEFAULTS.heroDescription} rows={3} />
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.branding.statsCardTitle')}</CardTitle>
          <CardDescription>{t('settings.branding.statsCardDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>{t('settings.branding.successfulPlacements')}</Label>
            <Input value={form.statPlacements} onChange={set('statPlacements')} placeholder={BRANDING_DEFAULTS.statPlacements} />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.branding.partnerCompanies')}</Label>
            <Input value={form.statPartners} onChange={set('statPartners')} placeholder={BRANDING_DEFAULTS.statPartners} />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.branding.countriesServed')}</Label>
            <Input value={form.statCountries} onChange={set('statCountries')} placeholder={BRANDING_DEFAULTS.statCountries} />
          </div>
        </CardContent>
      </Card>

      {/* Contact Info */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.branding.contactCardTitle')}</CardTitle>
          <CardDescription>{t('settings.branding.contactCardDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('settings.branding.officeAddress')}</Label>
            <Input value={form.address} onChange={set('address')} placeholder={BRANDING_DEFAULTS.address} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('settings.branding.phone1')}</Label>
              <Input value={form.phone1} onChange={set('phone1')} placeholder={BRANDING_DEFAULTS.phone1} />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.branding.phone2')}</Label>
              <Input value={form.phone2} onChange={set('phone2')} placeholder={BRANDING_DEFAULTS.phone2} />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>{t('settings.branding.generalEmail')}</Label>
              <Input value={form.emailInfo} onChange={set('emailInfo')} placeholder={BRANDING_DEFAULTS.emailInfo} />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.branding.recruitmentEmail')}</Label>
              <Input value={form.emailRecruitment} onChange={set('emailRecruitment')} placeholder={BRANDING_DEFAULTS.emailRecruitment} />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.branding.supportEmail')}</Label>
              <Input value={form.emailSupport} onChange={set('emailSupport')} placeholder={BRANDING_DEFAULTS.emailSupport} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Social & Footer */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.branding.socialCardTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('settings.branding.linkedinUrl')}</Label>
              <Input value={form.linkedIn} onChange={set('linkedIn')} placeholder={BRANDING_DEFAULTS.linkedIn} />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.branding.facebookUrl')}</Label>
              <Input value={form.facebook} onChange={set('facebook')} placeholder={BRANDING_DEFAULTS.facebook} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('settings.branding.footerTagline')}</Label>
            <Input value={form.footerTagline} onChange={set('footerTagline')} placeholder={BRANDING_DEFAULTS.footerTagline} />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.branding.vatInfo')}</Label>
            <Input value={form.vatInfo} onChange={set('vatInfo')} placeholder={BRANDING_DEFAULTS.vatInfo} />
          </div>
        </CardContent>
      </Card>

      {/* Save button */}
      <div className="flex justify-end pb-6">
        <Button onClick={handleSave} disabled={saving} size="lg">
          <Save className="w-4 h-4 me-2" />
          {saving ? t('settings.branding.saving') : t('settings.branding.saveAllChanges')}
        </Button>
      </div>
    </div>
  );
}
