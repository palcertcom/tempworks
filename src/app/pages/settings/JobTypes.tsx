import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { apiError } from '../../../i18n/apiError';
import { useValidationErrors } from '../../../i18n/useValidationErrors';
import { FieldError } from '../../components/ui/field-error';
import { ValidationSummary } from '../../components/ui/validation-summary';
import { usePermissions } from '../../hooks/usePermissions';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import {
  Plus,
  Pencil,
  Trash2,
  Search,
  CheckCircle,
  XCircle,
  Briefcase,
  Save,
  X,
  ArrowLeft,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
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
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { settingsApi } from '../../services/api';
import { toast } from 'sonner';
import { formatDate } from '../../../i18n/formatters';

interface JobType {
  id: string;
  name: string;
  description: string | null;
  requiredDocuments: string[];
  isActive: boolean;
  createdAt: string;
  _count?: { applicants: number; applications: number };
}

interface FormData {
  name: string;
  description: string;
  requiredDocuments: string[];
  isActive: boolean;
}

const DOCUMENT_OPTIONS = [
  'Passport',
  'Driving License',
  'Work Permit',
  'Medical Certificate',
  'Educational Certificate',
  'Driver Qualification Card',
  'Forklift License',
  'Safety Training Certificate',
  'Technical Certification',
  'Employment Contract',
  'Police Clearance',
  'Visa Documents',
];

export function JobTypes() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canCreate, canEdit, canDelete } = usePermissions();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [jobTypes, setJobTypes] = useState<JobType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Dialog state
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingJobType, setEditingJobType] = useState<JobType | null>(null);
  const [formData, setFormData] = useState<FormData>({
    name: '',
    description: '',
    requiredDocuments: [],
    isActive: true,
  });

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<JobType | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { errors: fieldErrs, setFromError, clearAll: clearFieldErrors, clearError } = useValidationErrors();

  useEffect(() => {
    loadJobTypes();
  }, []);

  async function loadJobTypes() {
    setLoading(true);
    try {
      const data = await settingsApi.getJobTypes(true);
      setJobTypes(data);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.loadFailed')));
    } finally {
      setLoading(false);
    }
  }

  const filteredJobTypes = jobTypes.filter(
    (jt) =>
      jt.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (jt.description ?? '').toLowerCase().includes(searchQuery.toLowerCase()),
  );

  function openCreateDialog() {
    setEditingJobType(null);
    setFormData({ name: '', description: '', requiredDocuments: [], isActive: true });
    setIsDialogOpen(true);
  }

  function openEditDialog(jobType: JobType) {
    setEditingJobType(jobType);
    setFormData({
      name: jobType.name,
      description: jobType.description ?? '',
      requiredDocuments: jobType.requiredDocuments ?? [],
      isActive: jobType.isActive,
    });
    setIsDialogOpen(true);
  }

  function toggleDocument(doc: string) {
    setFormData((prev) => ({
      ...prev,
      requiredDocuments: prev.requiredDocuments.includes(doc)
        ? prev.requiredDocuments.filter((d) => d !== doc)
        : [...prev.requiredDocuments, doc],
    }));
  }

  async function handleSave() {
    if (!formData.name.trim()) return;
    clearFieldErrors();
    setSaving(true);
    try {
      const payload = {
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        requiredDocuments: formData.requiredDocuments,
        isActive: formData.isActive,
      };

      if (editingJobType) {
        const updated = await settingsApi.updateJobType(editingJobType.id, payload);
        setJobTypes((prev) => prev.map((jt) => (jt.id === editingJobType.id ? { ...jt, ...updated } : jt)));
        toast.success(tc('toast.savedSuccessfully'));
      } else {
        const created = await settingsApi.createJobType(payload);
        setJobTypes((prev) => [...prev, created]);
        toast.success(tc('toast.savedSuccessfully'));
      }
      setIsDialogOpen(false);
    } catch (err: any) {
      setFromError(err);
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(jobType: JobType) {
    try {
      const updated = await settingsApi.updateJobType(jobType.id, { isActive: !jobType.isActive });
      setJobTypes((prev) => prev.map((jt) => (jt.id === jobType.id ? { ...jt, ...updated } : jt)));
      toast.success(
        !jobType.isActive ? tc('toast.activatedNamed', { name: jobType.name }) : tc('toast.deactivatedNamed', { name: jobType.name }),
      );
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await settingsApi.deleteJobType(deleteTarget.id);
      // Soft-deleted: row leaves this page and shows up in Deleted Records.
      setJobTypes((prev) => prev.filter((jt) => jt.id !== deleteTarget.id));
      toast.success(tc('toast.deletedSuccessfullyNamed', { name: deleteTarget.name, defaultValue: `${deleteTarget.name} deleted` }));
      setDeleteTarget(null);
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.deleteFailed')));
    } finally {
      setDeleting(false);
    }
  }

  const totalActive = jobTypes.filter((jt) => jt.isActive).length;
  const totalInactive = jobTypes.filter((jt) => !jt.isActive).length;
  const totalApplicants = jobTypes.reduce((acc, jt) => acc + (jt._count?.applicants ?? 0), 0);

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-3xl font-bold text-[#0F172A]">{t('settings.jobTypes.headerTitle')}</h1>
        </div>
        <p className="text-muted-foreground">
          {t('settings.jobTypes.headerSubtitle')}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">{t('settings.jobTypes.statTotal')}</p>
                <p className="text-2xl font-bold">{loading ? '—' : jobTypes.length}</p>
              </div>
              <Briefcase className="w-8 h-8 text-[#2563EB]" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">{t('settings.jobTypes.statActive')}</p>
                <p className="text-2xl font-bold text-[#22C55E]">{loading ? '—' : totalActive}</p>
              </div>
              <CheckCircle className="w-8 h-8 text-[#22C55E]" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">{t('settings.jobTypes.statInactive')}</p>
                <p className="text-2xl font-bold text-muted-foreground">{loading ? '—' : totalInactive}</p>
              </div>
              <XCircle className="w-8 h-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">{t('settings.jobTypes.statApplicants')}</p>
                <p className="text-2xl font-bold">{loading ? '—' : totalApplicants}</p>
              </div>
              <Briefcase className="w-8 h-8 text-[#F59E0B]" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search + Add */}
      <div className="flex items-center gap-4">
        <div className="flex-1 relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search job categories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-10"
          />
        </div>

        {canCreate('settings') && (
          <Button className="bg-[#2563EB] hover:bg-[#1d4ed8]" onClick={openCreateDialog}>
            <Plus className="w-4 h-4 me-2" />
            Add Job Category
          </Button>
        )}
      </div>

      {/* Job Categories List */}
      {loading ? (
        <div className="py-12 text-center text-muted-foreground">{t('settings.jobTypes.loading')}</div>
      ) : (
        <div className="space-y-4">
          {filteredJobTypes.map((jobType) => {
            const applicantCount = jobType._count?.applicants ?? 0;
            return (
              <Card key={jobType.id}>
                <CardContent className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold">{jobType.name}</h3>
                        <Badge
                          variant={jobType.isActive ? 'default' : 'secondary'}
                          className={jobType.isActive ? 'bg-[#22C55E]' : ''}
                        >
                          {jobType.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                        <Badge variant="outline">
                          {applicantCount} {applicantCount === 1 ? 'Applicant' : 'Applicants'}
                        </Badge>
                      </div>

                      {jobType.description && (
                        <p className="text-sm text-muted-foreground mb-3">{jobType.description}</p>
                      )}

                      {jobType.requiredDocuments?.length > 0 && (
                        <div className="space-y-1 mb-3">
                          <p className="text-sm font-medium">{t('settings.jobTypes.requiredDocuments')}</p>
                          <div className="flex flex-wrap gap-2">
                            {jobType.requiredDocuments.map((doc) => (
                              <Badge key={doc} variant="outline" className="bg-[#F8FAFC]">
                                {doc}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      <p className="text-xs text-muted-foreground">
                        Created: {formatDate(jobType.createdAt)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 ms-4">
                      {canEdit('settings') && (
                        <Button variant="outline" size="sm" onClick={() => handleToggleActive(jobType)}>
                          {jobType.isActive ? (
                            <>
                              <XCircle className="w-4 h-4 me-1" />
                              Deactivate
                            </>
                          ) : (
                            <>
                              <CheckCircle className="w-4 h-4 me-1" />
                              Activate
                            </>
                          )}
                        </Button>
                      )}
                      {canEdit('settings') && (
                        <Button variant="outline" size="sm" onClick={() => openEditDialog(jobType)}>
                          <Pencil className="w-4 h-4 me-1" />
                          Edit
                        </Button>
                      )}
                      {canDelete('settings') && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setDeleteTarget(jobType)}
                        >
                          <Trash2 className="w-4 h-4 me-1" />
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {filteredJobTypes.length === 0 && !loading && (
            <Card>
              <CardContent className="p-12 text-center">
                <Briefcase className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">
                  {searchQuery ? 'No job categories found matching your search' : 'No job categories yet. Add one to get started.'}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={(open) => !saving && setIsDialogOpen(open)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingJobType ? 'Edit Job Category' : 'Create New Job Category'}</DialogTitle>
            <DialogDescription>Configure job category settings and required documents</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <ValidationSummary errors={fieldErrs} />
            <div className="space-y-2">
              <Label htmlFor="jt-name">{t('settings.jobTypes.dialogNameRequired')}</Label>
              <Input
                id="jt-name"
                placeholder="e.g., Truck Driver"
                value={formData.name}
                onChange={(e) => { setFormData({ ...formData, name: e.target.value }); if (fieldErrs.name) clearError('name'); }}
                aria-invalid={!!fieldErrs.name}
                className={fieldErrs.name ? 'border-red-500 focus-visible:ring-red-500' : ''}
              />
              <FieldError errors={fieldErrs} name="name" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="jt-description">Description</Label>
              <Input
                id="jt-description"
                placeholder="Brief description of the job category"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <Label htmlFor="jt-isActive">{t('settings.jobTypes.activeStatus')}</Label>
                <p className="text-sm text-muted-foreground">{t('settings.jobTypes.activeStatusHelper')}</p>
              </div>
              <Switch
                id="jt-isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
              />
            </div>

            <div className="space-y-2">
              <Label>Required Documents</Label>
              <p className="text-sm text-muted-foreground mb-2">
                Documents that employees must provide for this job category
              </p>
              <div className="grid grid-cols-2 gap-2">
                {DOCUMENT_OPTIONS.map((doc) => (
                  <label
                    key={doc}
                    className="flex items-center gap-2 p-2 border rounded cursor-pointer hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={formData.requiredDocuments.includes(doc)}
                      onChange={() => toggleDocument(doc)}
                    />
                    <span className="text-sm">{doc}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsDialogOpen(false)} disabled={saving}>
              <X className="w-4 h-4 me-2" />
              Cancel
            </Button>
            <Button
              className="bg-[#2563EB] hover:bg-[#1d4ed8]"
              onClick={handleSave}
              disabled={!formData.name.trim() || saving}
            >
              <Save className="w-4 h-4 me-2" />
              {saving ? 'Saving...' : editingJobType ? 'Update' : 'Create'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Job Category</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? The category will be
              permanently removed if no applicants or employees reference it; otherwise it is deactivated
              and hidden from selectors so historical records stay intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tc('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
