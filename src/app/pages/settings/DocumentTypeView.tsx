import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Edit, Trash2, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { settingsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { toast } from 'sonner';
import { formatDate } from '../../../i18n/formatters';

interface DocumentType {
  id: string;
  name: string;
  description?: string;
  category: string;
  required: boolean;
  trackExpiry: boolean;
  renewalPeriodDays?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count: { documents: number };
}

export function DocumentTypeView() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { id } = useParams();
  const navigate = useNavigate();
  const [docType, setDocType] = useState<DocumentType | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    settingsApi.getDocumentType(id)
      .then((data: any) => setDocType(data))
      .catch((err: any) => {
        toast.error(apiError(err, tc('toast.loadFailed')));
        navigate('/dashboard/settings/document-types');
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function handleDelete() {
    if (!docType) return;
    setDeleting(true);
    try {
      await settingsApi.deleteDocumentType(docType.id);
      toast.success(tc('toast.deactivatedSuccessfullyNamed', { name: docType.name }));
      navigate('/dashboard/settings/document-types');
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.deleteFailed')));
      setDeleting(false);
      setShowDeleteDialog(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        {t('settings.documentTypes.view.loading')}
      </div>
    );
  }

  if (!docType) return null;

  const totalUploads = docType._count?.documents ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/dashboard/settings/document-types">
              <ArrowLeft className="w-5 h-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{docType.name}</h1>
            <p className="text-muted-foreground mt-1 font-mono text-sm">ID: {docType.id}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" asChild>
            <Link to={`/dashboard/settings/document-types/${id}/edit`}>
              <Edit className="w-4 h-4 me-2" />
              {t('settings.documentTypes.view.editButton')}
            </Link>
          </Button>
          <Button
            variant="outline"
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            onClick={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="w-4 h-4 me-2" />
            {t('settings.documentTypes.view.deactivateButton')}
          </Button>
        </div>
      </div>

      {/* Status Badge */}
      <div className="flex items-center gap-2">
        <Badge className={docType.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}>
          {docType.isActive ? 'Active' : 'Inactive'}
        </Badge>
        {docType.required && <Badge variant="outline">{t('settings.documentTypes.view.badgeRequired')}</Badge>}
        {docType.trackExpiry && (
          <Badge variant="outline" className="bg-[#EFF6FF]">{t('settings.documentTypes.view.badgeExpiryEnabled')}</Badge>
        )}
      </div>

      {/* Usage Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <FileText className="w-5 h-5 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{totalUploads}</p>
                <p className="text-sm text-muted-foreground">{t('settings.documentTypes.view.totalUploads')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {docType.renewalPeriodDays && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-[#FEF3C7] flex items-center justify-center">
                  <span className="text-[#F59E0B] font-bold text-sm">{docType.renewalPeriodDays}d</span>
                </div>
                <div>
                  <p className="text-2xl font-semibold">{docType.renewalPeriodDays}</p>
                  <p className="text-sm text-muted-foreground">{t('settings.documentTypes.view.daysWarning')}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="details" className="space-y-6">
        <TabsList>
          <TabsTrigger value="details">{t('settings.documentTypes.view.tabDetails')}</TabsTrigger>
          <TabsTrigger value="settings">{t('settings.documentTypes.view.tabSettings')}</TabsTrigger>
        </TabsList>

        {/* Details Tab */}
        <TabsContent value="details" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Basic Information */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.view.basicInformation')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">{t('settings.documentTypes.view.documentTypeName')}</p>
                  <p className="font-medium">{docType.name}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">{t('settings.documentTypes.view.category')}</p>
                  <p className="font-medium">{docType.category}</p>
                </div>
                {docType.description && (
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">{t('settings.documentTypes.view.description')}</p>
                    <p className="font-medium">{docType.description}</p>
                  </div>
                )}
                <div>
                  <p className="text-sm text-muted-foreground mb-1">{t('settings.documentTypes.view.status')}</p>
                  <Badge className={docType.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}>
                    {docType.isActive ? t('settings.documentTypes.view.active') : t('settings.documentTypes.view.inactive')}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Configuration */}
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.documentTypes.view.configuration')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('settings.documentTypes.view.badgeRequired')}</span>
                  <Badge variant={docType.required ? 'default' : 'outline'}>
                    {docType.required ? t('settings.documentTypes.view.yes') : t('settings.documentTypes.view.no')}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('settings.documentTypes.view.expiryTracking')}</span>
                  <Badge variant={docType.trackExpiry ? 'default' : 'outline'}>
                    {docType.trackExpiry ? t('settings.documentTypes.view.expiryEnabled') : t('settings.documentTypes.view.expiryDisabled')}
                  </Badge>
                </div>
                {docType.trackExpiry && docType.renewalPeriodDays && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t('settings.documentTypes.view.warningPeriod')}</span>
                    <span className="font-medium">{docType.renewalPeriodDays} {t('settings.documentTypes.view.days')}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Metadata */}
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.documentTypes.view.metadata')}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground mb-1">{t('settings.documentTypes.view.createdOn')}</p>
                <p className="font-medium">{formatDate(docType.createdAt)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground mb-1">{t('settings.documentTypes.view.lastUpdated')}</p>
                <p className="font-medium">{formatDate(docType.updatedAt)}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.documentTypes.view.docTypeSettings')}</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {t('settings.documentTypes.view.settingsSubtitle')}
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-6">
                <div className="p-4 border rounded-lg">
                  <h3 className="font-semibold mb-3">{t('settings.documentTypes.view.basicSettings')}</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('settings.documentTypes.view.documentTypeLabel')}</span>
                      <span className="font-medium">{docType.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('settings.documentTypes.view.categoryLabel')}</span>
                      <span className="font-medium">{docType.category}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('settings.documentTypes.view.statusLabel')}</span>
                      <Badge className={docType.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}>
                        {docType.isActive ? t('settings.documentTypes.view.active') : t('settings.documentTypes.view.inactive')}
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="p-4 border rounded-lg">
                  <h3 className="font-semibold mb-3">{t('settings.documentTypes.view.requirements')}</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('settings.documentTypes.view.requiredLabel')}</span>
                      <span className="font-medium">{docType.required ? t('settings.documentTypes.view.yes') : t('settings.documentTypes.view.no')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('settings.documentTypes.view.totalUploadsLabel')}</span>
                      <span className="font-medium">{totalUploads}</span>
                    </div>
                  </div>
                </div>

                <div className="p-4 border rounded-lg">
                  <h3 className="font-semibold mb-3">{t('settings.documentTypes.view.expirySettingsCard')}</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('settings.documentTypes.view.trackingLabel')}</span>
                      <span className="font-medium">{docType.trackExpiry ? t('settings.documentTypes.view.expiryEnabled') : t('settings.documentTypes.view.expiryDisabled')}</span>
                    </div>
                    {docType.trackExpiry && docType.renewalPeriodDays && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('settings.documentTypes.view.warningPeriodLabel')}</span>
                        <span className="font-medium">{docType.renewalPeriodDays} {t('settings.documentTypes.view.days')}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.documentTypes.view.deactivateTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.documentTypes.view.deactivateDesc', { name: docType.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('settings.documentTypes.view.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? t('settings.documentTypes.view.deactivating') : t('settings.documentTypes.view.deactivateButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
