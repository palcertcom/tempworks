import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
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

export function DocumentTypeNew() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    category: '',
    required: false,
    expiryTracking: false,
    expiryWarningDays: '30',
    allowMultiple: false,
    verificationRequired: true,
    applicableJobTypes: [] as string[],
    fileFormats: [] as string[],
    maxFileSize: '10',
    validationRules: '',
  });

  const [selectedJobTypes, setSelectedJobTypes] = useState<string[]>([]);
  const [selectedFormats, setSelectedFormats] = useState<string[]>([]);

  const jobTypes = [
    'Truck Driver',
    'Delivery Driver',
    'Warehouse Worker',
    'Forklift Operator',
    'Logistics Coordinator',
    'Construction Worker',
    'Technician',
    'General Worker',
  ];

  const fileFormats = ['PDF', 'JPG', 'PNG', 'DOCX', 'XLSX'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await settingsApi.createDocumentType({
        name: formData.name,
        description: formData.description || undefined,
        category: CATEGORY_LABELS[formData.category] ?? formData.category,
        required: formData.required,
        trackExpiry: formData.expiryTracking,
        renewalPeriodDays: formData.expiryTracking && formData.expiryWarningDays
          ? parseInt(formData.expiryWarningDays, 10)
          : undefined,
        isActive: true,
      });
      toast.success(tc('toast.savedSuccessfully'));
      navigate('/dashboard/settings/document-types');
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleJobTypeToggle = (jobType: string) => {
    setSelectedJobTypes(prev =>
      prev.includes(jobType)
        ? prev.filter(j => j !== jobType)
        : [...prev, jobType]
    );
  };

  const handleFormatToggle = (format: string) => {
    setSelectedFormats(prev =>
      prev.includes(format)
        ? prev.filter(f => f !== format)
        : [...prev, format]
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/settings/document-types">
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('settings.documentTypes.new.headerTitle')}</h1>
          <p className="text-muted-foreground mt-1">{t('settings.documentTypes.new.headerSubtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Configuration */}
          <div className="lg:col-span-2 space-y-6">
            {/* Basic Information */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.new.basicInformation')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">{t('settings.documentTypes.new.nameRequired')}</Label>
                  <Input
                    id="name"
                    placeholder={t('settings.documentTypes.new.namePlaceholder')}
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">{t('settings.documentTypes.new.description')}</Label>
                  <Textarea
                    id="description"
                    placeholder={t('settings.documentTypes.new.descriptionPlaceholder')}
                    rows={3}
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="category">{t('settings.documentTypes.new.categoryRequired')}</Label>
                  <Select
                    value={formData.category}
                    onValueChange={(value) => setFormData({ ...formData, category: value })}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('settings.documentTypes.new.selectCategory')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="identity">{t('settings.documentTypes.new.catIdentity')}</SelectItem>
                      <SelectItem value="license">{t('settings.documentTypes.new.catLicense')}</SelectItem>
                      <SelectItem value="medical">{t('settings.documentTypes.new.catMedical')}</SelectItem>
                      <SelectItem value="legal">{t('settings.documentTypes.new.catLegal')}</SelectItem>
                      <SelectItem value="employment">{t('settings.documentTypes.new.catEmployment')}</SelectItem>
                      <SelectItem value="insurance">{t('settings.documentTypes.new.catInsurance')}</SelectItem>
                      <SelectItem value="training">{t('settings.documentTypes.new.catTraining')}</SelectItem>
                      <SelectItem value="other">{t('settings.documentTypes.new.catOther')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {/* Document Settings */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.new.documentSettings')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="required">{t('settings.documentTypes.new.requiredDocument')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.documentTypes.new.requiredHelper')}
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
                    <Label htmlFor="expiryTracking">{t('settings.documentTypes.new.expiryTracking')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.documentTypes.new.expiryHelper')}
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
                      {t('settings.documentTypes.new.warningPeriod', { defaultValue: 'Notify how many days before expiry' })}
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
                    <Label htmlFor="allowMultiple">{t('settings.documentTypes.new.allowMultiple')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.documentTypes.new.allowMultipleHelper')}
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
                    <Label htmlFor="verificationRequired">{t('settings.documentTypes.new.verificationRequired')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.documentTypes.new.verificationHelper')}
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
                <CardTitle>{t('settings.documentTypes.new.fileUploadSettings')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('settings.documentTypes.new.allowedFileFormats')}</Label>
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
                    {selectedFormats.length > 0 ? selectedFormats.join(', ') : t('settings.documentTypes.new.noneSelected')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maxFileSize">{t('settings.documentTypes.new.maxFileSize')}</Label>
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

            {/* Job Category Applicability */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.new.jobCategoryApplicability')}</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('settings.documentTypes.new.jobCategorySubtitle')}
                </p>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  {jobTypes.map((jobType) => (
                    <div
                      key={jobType}
                      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                        selectedJobTypes.includes(jobType)
                          ? 'border-[#2563EB] bg-[#EFF6FF]'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                      onClick={() => handleJobTypeToggle(jobType)}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                            selectedJobTypes.includes(jobType)
                              ? 'border-[#2563EB] bg-[#2563EB]'
                              : 'border-gray-300'
                          }`}
                        >
                          {selectedJobTypes.includes(jobType) && (
                            <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 12 12">
                              <path d="M10 3L4.5 8.5L2 6" stroke="currentColor" strokeWidth="2" fill="none" />
                            </svg>
                          )}
                        </div>
                        <span className="text-sm font-medium">{jobType}</span>
                      </div>
                    </div>
                  ))}
                </div>
                {selectedJobTypes.length === 0 && (
                  <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex gap-2">
                      <Info className="w-4 h-4 text-[#2563EB] mt-0.5" />
                      <p className="text-sm text-[#2563EB]">
                        {t('settings.documentTypes.new.allCategoriesInfo')}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Validation Rules */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.new.validationRulesOptional')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <Label htmlFor="validationRules">{t('settings.documentTypes.new.customValidationRules')}</Label>
                  <Textarea
                    id="validationRules"
                    placeholder={t('settings.documentTypes.new.validationExample')}
                    rows={4}
                    value={formData.validationRules}
                    onChange={(e) => setFormData({ ...formData, validationRules: e.target.value })}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t('settings.documentTypes.new.validationExample')}
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
                <CardTitle className="text-sm">{t('settings.documentTypes.new.configSummary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.new.statusLabel')}</span>
                    <span className="font-medium">
                      {formData.required ? t('settings.documentTypes.new.statusRequired') : t('settings.documentTypes.new.statusOptional')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.new.expiryTrackingLabel')}</span>
                    <span className="font-medium">
                      {formData.expiryTracking ? t('settings.documentTypes.new.expiryEnabled') : t('settings.documentTypes.new.expiryDisabled')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.new.verificationLabel')}</span>
                    <span className="font-medium">
                      {formData.verificationRequired ? t('settings.documentTypes.new.statusRequired') : t('settings.documentTypes.edit.verificationNotRequired')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.new.multipleFilesLabel')}</span>
                    <span className="font-medium">
                      {formData.allowMultiple ? t('settings.documentTypes.new.allowed') : t('settings.documentTypes.new.singleFile')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.new.fileFormatsLabel')}</span>
                    <span className="font-medium">
                      {selectedFormats.length || t('settings.documentTypes.new.anyFormat')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.new.maxSizeLabel')}</span>
                    <span className="font-medium">
                      {formData.maxFileSize || '10'} MB
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('settings.documentTypes.new.jobCategoriesLabel')}</span>
                    <span className="font-medium">
                      {selectedJobTypes.length || t('settings.documentTypes.new.allCategories')}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Info Card */}
            <Card className="bg-[#FEF3C7] border-[#F59E0B]">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Info className="w-4 h-4" />
                  {t('settings.documentTypes.new.importantInformation')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="text-sm space-y-2 text-muted-foreground">
                  <li>• {t('settings.documentTypes.new.info1')}</li>
                  <li>• {t('settings.documentTypes.new.info2')}</li>
                  <li>• {t('settings.documentTypes.new.info3')}</li>
                  <li>• {t('settings.documentTypes.new.info4')}</li>
                </ul>
              </CardContent>
            </Card>

            {/* Actions */}
            <div className="space-y-3">
              <Button type="submit" className="w-full" size="lg" disabled={saving}>
                <Save className="w-4 h-4 me-2" />
                {saving ? t('settings.documentTypes.new.creating') : t('settings.documentTypes.new.createButton')}
              </Button>
              <Button type="button" variant="outline" className="w-full" asChild>
                <Link to="/dashboard/settings/document-types">{t('settings.documentTypes.new.cancel')}</Link>
              </Button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
