import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { toast } from 'sonner';
import { settingsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';

const CATEGORY_LABELS: Record<string, string> = {
  identity: 'Identity',
  license: 'License',
  medical: 'Medical',
  legal: 'Legal',
  employment: 'Employment',
  insurance: 'Insurance',
  training: 'Training',
  other: 'Other',
};

function toCategoryKey(category: string): string {
  return category.toLowerCase();
}

export function DocumentTypeEdit() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const { id } = useParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [documentCount, setDocumentCount] = useState(0);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    category: '',
    required: false,
    expiryTracking: false,
    expiryWarningDays: '30',
    allowMultiple: false,
    verificationRequired: true,
    maxFileSize: '10',
    validationRules: '',
  });

  const [selectedFormats, setSelectedFormats] = useState<string[]>([]);
  const fileFormats = ['PDF', 'JPG', 'PNG', 'DOCX', 'XLSX'];

  useEffect(() => {
    if (!id) return;
    settingsApi.getDocumentType(id)
      .then((dt: any) => {
        setFormData({
          name: dt.name ?? '',
          description: dt.description ?? '',
          category: toCategoryKey(dt.category ?? ''),
          required: dt.required ?? false,
          expiryTracking: dt.trackExpiry ?? false,
          expiryWarningDays: dt.renewalPeriodDays ? String(dt.renewalPeriodDays) : '30',
          allowMultiple: false,
          verificationRequired: true,
          maxFileSize: '10',
          validationRules: '',
        });
        setDocumentCount(dt._count?.documents ?? 0);
      })
      .catch((err: any) => {
        toast.error(apiError(err, tc('toast.loadFailed')));
        navigate('/dashboard/settings/document-types');
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await settingsApi.updateDocumentType(id!, {
        name: formData.name,
        description: formData.description || undefined,
        category: CATEGORY_LABELS[formData.category] ?? formData.category,
        required: formData.required,
        trackExpiry: formData.expiryTracking,
        renewalPeriodDays: formData.expiryTracking && formData.expiryWarningDays
          ? parseInt(formData.expiryWarningDays, 10)
          : undefined,
      });
      toast.success(tc('toast.savedSuccessfully'));
      navigate(`/dashboard/settings/document-types/${id}`);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleFormatToggle = (format: string) => {
    setSelectedFormats((prev) =>
      prev.includes(format) ? prev.filter((f) => f !== format) : [...prev, format],
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        Loading document type...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/settings/document-types/${id}`}>
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('settings.documentTypes.editTitle')}</h1>
          <p className="text-muted-foreground mt-1">{t('settings.documentTypes.edit.subtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Configuration */}
          <div className="lg:col-span-2 space-y-6">
            {/* Basic Information */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.edit.basicInformation')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">{t('settings.documentTypes.edit.nameRequired')}</Label>
                  <Input
                    id="name"
                    placeholder={t('settings.documentTypes.edit.namePlaceholder')}
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">{t('settings.documentTypes.edit.description')}</Label>
                  <Textarea
                    id="description"
                    placeholder={t('settings.documentTypes.edit.descriptionPlaceholder')}
                    rows={3}
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="category">{t('settings.documentTypes.edit.categoryRequired')}</Label>
                  <Select
                    value={formData.category}
                    onValueChange={(value) => setFormData({ ...formData, category: value })}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('settings.documentTypes.edit.selectCategory')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="identity">{t('settings.documentTypes.edit.catIdentity')}</SelectItem>
                      <SelectItem value="license">{t('settings.documentTypes.edit.catLicense')}</SelectItem>
                      <SelectItem value="medical">{t('settings.documentTypes.edit.catMedical')}</SelectItem>
                      <SelectItem value="legal">{t('settings.documentTypes.edit.catLegal')}</SelectItem>
                      <SelectItem value="employment">{t('settings.documentTypes.edit.catEmployment')}</SelectItem>
                      <SelectItem value="insurance">{t('settings.documentTypes.edit.catInsurance')}</SelectItem>
                      <SelectItem value="training">{t('settings.documentTypes.edit.catTraining')}</SelectItem>
                      <SelectItem value="other">{t('settings.documentTypes.edit.catOther')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {/* Document Settings */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.edit.documentSettings')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="required">{t('settings.documentTypes.edit.requiredDocument')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.documentTypes.edit.requiredHelper')}
                    </p>
                  </div>
                  <Switch
                    id="required"
                    checked={formData.required}
                    onCheckedChange={(checked) => setFormData({ ...formData, required: checked })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="expiryTracking">{t('settings.documentTypes.edit.expiryTracking')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.documentTypes.edit.expiryHelper')}
                    </p>
                  </div>
                  <Switch
                    id="expiryTracking"
                    checked={formData.expiryTracking}
                    onCheckedChange={(checked) => setFormData({ ...formData, expiryTracking: checked })}
                  />
                </div>

                {formData.expiryTracking && (
                  <div className="space-y-2 ps-4 border-s-2 border-[#2563EB]">
                    <Label htmlFor="expiryWarningDays">
                      {t('settings.documentTypes.edit.warningPeriod', { defaultValue: 'Notify how many days before expiry' })}
                    </Label>
                    <Input
                      id="expiryWarningDays"
                      type="number"
                      min="1"
                      placeholder="30"
                      value={formData.expiryWarningDays}
                      onChange={(e) => setFormData({ ...formData, expiryWarningDays: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Operators see an &quot;Expiring Soon&quot; notification when an uploaded document of this type has this many days or fewer until its expiry date. Common values: passport 90, driving licence 60, work permit 30.
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="allowMultiple">{t('settings.documentTypes.edit.allowMultiple')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.documentTypes.edit.allowMultipleHelper')}
                    </p>
                  </div>
                  <Switch
                    id="allowMultiple"
                    checked={formData.allowMultiple}
                    onCheckedChange={(checked) => setFormData({ ...formData, allowMultiple: checked })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="verificationRequired">{t('settings.documentTypes.edit.verificationRequired')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.documentTypes.edit.verificationHelper')}
                    </p>
                  </div>
                  <Switch
                    id="verificationRequired"
                    checked={formData.verificationRequired}
                    onCheckedChange={(checked) => setFormData({ ...formData, verificationRequired: checked })}
                  />
                </div>
              </CardContent>
            </Card>

            {/* File Upload Settings */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.edit.fileUploadSettings')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('settings.documentTypes.edit.allowedFileFormats')}</Label>
                  <div className="flex flex-wrap gap-2">
                    {fileFormats.map((format) => (
                      <Button
                        key={format}
                        type="button"
                        variant={selectedFormats.includes(format) ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleFormatToggle(format)}
                      >
                        {format}
                      </Button>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {selectedFormats.length > 0 ? selectedFormats.join(', ') : t('settings.documentTypes.edit.noneSelected')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maxFileSize">{t('settings.documentTypes.edit.maxFileSizeMb')}</Label>
                  <Input
                    id="maxFileSize"
                    type="number"
                    min="1"
                    max="100"
                    placeholder="10"
                    value={formData.maxFileSize}
                    onChange={(e) => setFormData({ ...formData, maxFileSize: e.target.value })}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Validation Rules */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.edit.validationRulesOptional')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <Label htmlFor="validationRules">{t('settings.documentTypes.edit.customValidationRules')}</Label>
                  <Textarea
                    id="validationRules"
                    placeholder={t('settings.documentTypes.edit.validationExample')}
                    rows={4}
                    value={formData.validationRules}
                    onChange={(e) => setFormData({ ...formData, validationRules: e.target.value })}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t('settings.documentTypes.edit.validationExample')}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Summary Card */}
            <Card className="bg-gradient-to-br from-[#EFF6FF] to-white border-[#2563EB]">
              <CardHeader>
                <CardTitle className="text-sm">{t('settings.documentTypes.edit.configSummary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.edit.statusLabel')}</span>
                    <span className="font-medium">{formData.required ? t('settings.documentTypes.edit.statusRequired') : t('settings.documentTypes.edit.statusOptional')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.edit.expiryTrackingLabel')}</span>
                    <span className="font-medium">{formData.expiryTracking ? t('settings.documentTypes.edit.expiryEnabled') : t('settings.documentTypes.edit.expiryDisabled')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.edit.verificationLabel')}</span>
                    <span className="font-medium">
                      {formData.verificationRequired ? t('settings.documentTypes.edit.statusRequired') : t('settings.documentTypes.edit.verificationNotRequired')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.edit.multipleFilesLabel')}</span>
                    <span className="font-medium">{formData.allowMultiple ? t('settings.documentTypes.edit.allowed') : t('settings.documentTypes.edit.singleFile')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.edit.maxSizeLabel')}</span>
                    <span className="font-medium">{formData.maxFileSize || '10'} MB</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Warning Card */}
            <Card className="bg-[#FEF3C7] border-[#F59E0B]">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Info className="w-4 h-4" />
                  {t('settings.documentTypes.edit.importantNotice')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="text-sm space-y-2 text-muted-foreground">
                  <li>• {t('settings.documentTypes.edit.notice1')}</li>
                  <li>• {t('settings.documentTypes.edit.notice2')}</li>
                  <li>• {t('settings.documentTypes.edit.notice3')}</li>
                </ul>
              </CardContent>
            </Card>

            {/* Usage Stats */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('settings.documentTypes.edit.currentUsage')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('settings.documentTypes.edit.totalUploads')}</span>
                  <span className="font-semibold">{documentCount}</span>
                </div>
              </CardContent>
            </Card>

            {/* Actions */}
            <div className="space-y-3">
              <Button type="submit" className="w-full" size="lg" disabled={saving}>
                <Save className="w-4 h-4 me-2" />
                {saving ? t('settings.documentTypes.edit.saving') : t('settings.documentTypes.edit.saveChanges')}
              </Button>
              <Button type="button" variant="outline" className="w-full" asChild>
                <Link to={`/dashboard/settings/document-types/${id}`}>{t('settings.documentTypes.edit.cancel')}</Link>
              </Button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
