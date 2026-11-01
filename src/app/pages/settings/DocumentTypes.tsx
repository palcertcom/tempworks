import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Eye, Edit, Trash2, ShieldOff } from 'lucide-react';
import { usePermissions } from '../../hooks/usePermissions';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
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
import { settingsApi, contractsApi } from '../../services/api';
import { Checkbox } from '../../components/ui/checkbox';
import { apiError } from '../../../i18n/apiError';
import { toast } from 'sonner';

interface DocumentType {
  id: string;
  name: string;
  category: string;
  required: boolean;
  trackExpiry: boolean;
  isActive: boolean;
  _count: { documents: number };
}

export function DocumentTypes() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete } = usePermissions();
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<DocumentType | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Contracts integration — which document types auto-create/update a
  // contract record when uploaded.
  const [contractTypeIds, setContractTypeIds] = useState<string[]>([]);
  const [savingContractMap, setSavingContractMap] = useState(false);

  useEffect(() => {
    loadDocumentTypes();
    contractsApi.getDocumentTypeSettings()
      .then(s => setContractTypeIds(s.documentTypeIds))
      .catch(() => { /* non-fatal */ });
  }, []);

  const toggleContractType = async (id: string) => {
    const next = contractTypeIds.includes(id)
      ? contractTypeIds.filter(x => x !== id)
      : [...contractTypeIds, id];
    setContractTypeIds(next);
    setSavingContractMap(true);
    try {
      await contractsApi.setDocumentTypeSettings(next);
      toast.success(t('settings.documentTypes.contractMapSaved', { defaultValue: 'Contract mapping updated' }));
    } catch (err: any) {
      // revert on failure
      setContractTypeIds(contractTypeIds);
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSavingContractMap(false);
    }
  };

  async function loadDocumentTypes() {
    try {
      const data = await settingsApi.getDocumentTypes();
      setDocumentTypes(data);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.loadFailed')));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await settingsApi.deleteDocumentType(deleteTarget.id);
      toast.success(tc('toast.deactivatedSuccessfullyNamed', { name: deleteTarget.name }));
      setDocumentTypes((prev) => prev.filter((d) => d.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.deleteFailed')));
    } finally {
      setDeleting(false);
    }
  }

  const totalDocuments = documentTypes.reduce((sum, d) => sum + (d._count?.documents ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/settings"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('settings.documentTypes.list')}</h1>
          <p className="text-muted-foreground mt-1">{t('settings.documentTypes.headerSubtitle')}</p>
        </div>
        {canCreate('settings') && (
          <Button asChild>
            <Link to="/dashboard/settings/document-types/new">
              <Plus className="w-4 h-4 me-2" />
              {t('settings.documentTypes.addDocumentType')}
            </Link>
          </Button>
        )}
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{documentTypes.length}</div>
            <p className="text-sm text-muted-foreground">{t('settings.documentTypes.statTotal')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{documentTypes.filter((d) => d.required).length}</div>
            <p className="text-sm text-muted-foreground">{t('settings.documentTypes.statRequired')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{documentTypes.filter((d) => d.trackExpiry).length}</div>
            <p className="text-sm text-muted-foreground">{t('settings.documentTypes.statExpiry')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{totalDocuments}</div>
            <p className="text-sm text-muted-foreground">{t('settings.documentTypes.statDocuments')}</p>
          </CardContent>
        </Card>
      </div>

      {/* Documents ↔ Contracts mapping */}
      {canEdit('settings') && !loading && (
        <Card className="border-blue-200 bg-blue-50/40 dark:bg-blue-950/10">
          <CardHeader>
            <CardTitle className="text-base">
              {t('settings.documentTypes.contractMapTitle', { defaultValue: 'Auto-create contracts from documents' })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              {t('settings.documentTypes.contractMapHelp', {
                defaultValue: 'Select which document types create or update an employment contract when uploaded. The document\'s Issue Date becomes the contract start and its Expiry Date the contract end.',
              })}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {documentTypes.map(dt => (
                <label key={dt.id} className="flex items-center gap-2 text-sm rounded border bg-card px-3 py-2 cursor-pointer">
                  <Checkbox
                    checked={contractTypeIds.includes(dt.id)}
                    disabled={savingContractMap}
                    onCheckedChange={() => toggleContractType(dt.id)}
                  />
                  <span className="truncate">{dt.name}</span>
                  <span className="ms-auto text-xs text-muted-foreground">{dt.category}</span>
                </label>
              ))}
            </div>
            {contractTypeIds.length === 0 && (
              <p className="text-xs text-muted-foreground mt-3">
                {t('settings.documentTypes.contractMapDefault', {
                  defaultValue: 'None selected — the system falls back to document types named "Employment Contract" or "Work Contract".',
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.documentTypes.listCardTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">{t('settings.documentTypes.loading')}</div>
          ) : documentTypes.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              {t('settings.documentTypes.emptyState')}{' '}
              <Link to="/dashboard/settings/document-types/new" className="text-[#2563EB] underline">
                {t('settings.documentTypes.emptyAddLink')}
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-start py-3 px-4 font-medium text-sm text-muted-foreground">{t('settings.documentTypes.colDocumentType')}</th>
                    <th className="text-start py-3 px-4 font-medium text-sm text-muted-foreground">{t('settings.documentTypes.colCategory')}</th>
                    <th className="text-start py-3 px-4 font-medium text-sm text-muted-foreground">{t('settings.documentTypes.colStatus')}</th>
                    <th className="text-start py-3 px-4 font-medium text-sm text-muted-foreground">{t('settings.documentTypes.colUploads')}</th>
                    <th className="text-start py-3 px-4 font-medium text-sm text-muted-foreground">{t('settings.documentTypes.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {documentTypes.map((docType) => (
                    <tr key={docType.id} className="border-b hover:bg-[#F8FAFC]">
                      <td className="py-3 px-4">
                        <div>
                          <p className="font-medium text-[#0F172A]">{docType.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">{docType.id.slice(0, 8)}…</p>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm">{docType.category}</span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-2">
                          {docType.required && <Badge variant="outline">Required</Badge>}
                          {docType.trackExpiry && (
                            <Badge variant="outline" className="bg-[#EFF6FF]">{t('settings.documentTypes.expiryTrackingBadge')}</Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm font-medium">{docType._count?.documents ?? 0}</span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/dashboard/settings/document-types/${docType.id}`}>
                              <Eye className="w-4 h-4" />
                            </Link>
                          </Button>
                          {canEdit('settings') && (
                            <Button variant="ghost" size="sm" asChild>
                              <Link to={`/dashboard/settings/document-types/${docType.id}/edit`}>
                                <Edit className="w-4 h-4" />
                              </Link>
                            </Button>
                          )}
                          {canDelete('settings') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              onClick={() => setDeleteTarget(docType)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.documentTypes.deactivateTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.documentTypes.deactivateDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('settings.documentTypes.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? t('settings.documentTypes.deactivating') : t('settings.documentTypes.deactivateAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
