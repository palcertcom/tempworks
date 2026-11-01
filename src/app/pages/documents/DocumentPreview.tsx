import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Download, FileText, CheckCircle2, XCircle, Edit, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Textarea } from '../../components/ui/textarea';
import { Label } from '../../components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { documentsApi } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { apiError } from '../../../i18n/apiError';
import { formatDate, formatDateTime } from '../../../i18n/formatters';
import { getDocumentDisplayName } from '../../utils/documentDisplay';
import { ErrorBanner } from '../../components/ui/error-banner';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');
/**
 * Build a fetchable URL from whatever shape the DB has.
 *  - Already-absolute URLs are returned as-is.
 *  - Legacy malformed values like
 *      "https://api.example.comhttps://spaces.example.com/foo.jpg"
 *    (an older bug saved API_BASE + absolute URL into the DB) are
 *    repaired by stripping everything before the second protocol.
 *  - Bare paths get the API base prepended.
 */
const getFileUrl = (fileUrl: string) => {
  if (!fileUrl) return '';
  // Repair legacy double-prefix rows.
  const dbl = fileUrl.search(/https?:\/\/.*?(https?:\/\/)/);
  if (dbl !== -1) {
    return fileUrl.slice(fileUrl.indexOf('http', 1));
  }
  return /^https?:\/\//i.test(fileUrl) ? fileUrl : `${API_BASE}${fileUrl}`;
};

export function DocumentPreview() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete, can } = usePermissions();

  const [document, setDocument] = useState<any>(null);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Rejection dialog
  const [rejectOpen, setRejectOpen]       = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    documentsApi.get(id!)
      .then((doc) => { setDocument(doc); setLoadError(null); })
      .catch((err: any) => setLoadError(apiError(err, t('documents.preview.notFound'))))
      .finally(() => setLoading(false));
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  const handleApprove = async () => {
    setVerifying(true);
    try {
      const updated = await documentsApi.verify(id!, { action: 'VERIFY' });
      setDocument(updated);
      toast.success(t('documents.preview.approveSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('documents.preview.approveFailed')));
    } finally {
      setVerifying(false);
    }
  };

  const handleReject = async () => {
    if (!rejectionReason.trim()) {
      toast.error(t('documents.preview.rejectionRequired'));
      return;
    }
    setVerifying(true);
    try {
      const updated = await documentsApi.verify(id!, {
        action: 'REJECT',
        reason: rejectionReason.trim(),
      });
      setDocument(updated);
      toast.success(t('documents.preview.rejectSuccess'));
      setRejectOpen(false);
    } catch (err: any) {
      toast.error(apiError(err, t('documents.preview.rejectFailed')));
    } finally {
      setVerifying(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({
      title: tc('confirm.deleteDocumentTitle'),
      description: tc('confirm.deleteDocumentBodyDefault'),
      confirmText: tc('actions.delete'), tone: 'destructive',
    }))) return;
    try {
      await documentsApi.delete(id!);
      toast.success(t('documents.preview.deleteSuccess'));
      navigate('/dashboard/documents-compliance');
    } catch (err: any) {
      toast.error(apiError(err, t('documents.preview.deleteFailed')));
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'VERIFIED':      return <Badge className="bg-[#22C55E]">{t('documents.preview.statusBadge.valid')}</Badge>;
      case 'EXPIRING_SOON': return <Badge className="bg-[#F59E0B]">{t('documents.preview.statusBadge.expiringSoon')}</Badge>;
      case 'EXPIRED':       return <Badge className="bg-[#EF4444]">{t('documents.preview.statusBadge.expired')}</Badge>;
      case 'REJECTED':      return <Badge className="bg-[#EF4444]">{t('documents.preview.statusBadge.rejected')}</Badge>;
      case 'PENDING':       return <Badge className="bg-[#64748B]">{t('documents.preview.statusBadge.pending')}</Badge>;
      default:              return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (loading) return <div className="p-8 text-muted-foreground">{t('documents.preview.loading')}</div>;
  if (loadError || !document) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/dashboard/documents-compliance">
              <ArrowLeft className="w-5 h-5" />
            </Link>
          </Button>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('documents.preview.pageTitle')}</h1>
        </div>
        <ErrorBanner
          message={loadError ?? t('documents.preview.notFound')}
          title={t('documents.preview.unableToLoad', { defaultValue: 'Unable to load document' })}
          onRetry={load}
          autoFocus={false}
        />
      </div>
    );
  }

  const isImage = document.mimeType?.startsWith('image/');

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/documents-compliance">
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('documents.preview.pageTitle')}</h1>
          <p className="text-muted-foreground mt-1">
            {document.documentType?.name} — {getDocumentDisplayName(document.name, document.documentType?.name)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit('documents') && (
            <Button variant="outline" asChild>
              <Link to={`/dashboard/documents/${id}/edit`}>
                <Edit className="w-4 h-4 me-2" />Edit
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <a href={getFileUrl(document.fileUrl)} target="_blank" rel="noopener noreferrer" download>
              <Download className="w-4 h-4 me-2" />Download
            </a>
          </Button>
          {canDelete('documents') && (
            <Button
              variant="outline"
              className="text-[#EF4444] border-[#EF4444]"
              onClick={handleDelete}
            >
              <Trash2 className="w-4 h-4 me-2" />Delete
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Preview pane */}
        <div className="col-span-2">
          <Card className="h-[600px] flex items-center justify-center overflow-hidden">
            {isImage ? (
              <img
                src={getFileUrl(document.fileUrl)}
                alt={document.name}
                className="max-h-full max-w-full object-contain"
              />
            ) : document.mimeType === 'application/pdf' ? (
              <iframe
                src={getFileUrl(document.fileUrl)}
                title={document.name}
                className="w-full h-full"
              />
            ) : (
              <div className="text-center">
                <FileText className="w-24 h-24 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">{t('documents.preview.previewNotAvailable')}</p>
                <p className="text-sm text-muted-foreground mt-2">{getDocumentDisplayName(document.name, document.documentType?.name)}</p>
                <Button variant="outline" className="mt-4" asChild>
                  <a href={getFileUrl(document.fileUrl)} target="_blank" rel="noopener noreferrer" download>
                    <Download className="w-4 h-4 me-2" />{t('documents.preview.downloadToView')}
                  </a>
                </Button>
              </div>
            )}
          </Card>
        </div>

        {/* Details pane */}
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>{t('documents.preview.details')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {document.docId && (
                <div>
                  <p className="text-sm text-muted-foreground">{t('documents.preview.docId', { defaultValue: 'Document ID' })}</p>
                  <p className="font-mono font-semibold mt-1 text-[#2563EB]">{document.docId}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">{t('documents.preview.name')}</p>
                <p className="font-medium mt-1">{getDocumentDisplayName(document.name, document.documentType?.name)}</p>
              </div>
              {document.ownerName && (
                <div>
                  <p className="text-sm text-muted-foreground">{t('documents.preview.owner', { defaultValue: 'Owner' })}</p>
                  <p className="font-medium mt-1">
                    {document.ownerName}
                    {document.ownerSystemId && <span className="text-muted-foreground font-normal"> · {document.ownerSystemId}</span>}
                  </p>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">{t('documents.preview.type')}</p>
                <p className="font-medium mt-1">{document.documentType?.name ?? '—'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('documents.preview.status')}</p>
                <div className="mt-1">{getStatusBadge(document.status)}</div>
              </div>
              {document.documentNumber && (
                <div>
                  <p className="text-sm text-muted-foreground">{t('documents.preview.documentNumber')}</p>
                  <p className="font-medium mt-1">{document.documentNumber}</p>
                </div>
              )}
              {document.issuer && (
                <div>
                  <p className="text-sm text-muted-foreground">{t('documents.preview.issuer')}</p>
                  <p className="font-medium mt-1">{document.issuer}</p>
                </div>
              )}
              {document.issueDate && (
                <div>
                  <p className="text-sm text-muted-foreground">{t('documents.preview.issueDate')}</p>
                  <p className="font-medium mt-1">{formatDate(document.issueDate)}</p>
                </div>
              )}
              {document.expiryDate && (
                <div>
                  <p className="text-sm text-muted-foreground">{t('documents.preview.expiryDate')}</p>
                  <p className="font-medium mt-1">{formatDate(document.expiryDate)}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">{t('documents.preview.uploaded')}</p>
                <p className="font-medium mt-1">{formatDate(document.createdAt)}</p>
              </div>
              {document.uploadedBy && (
                <div>
                  <p className="text-sm text-muted-foreground">{t('documents.preview.uploadedBy')}</p>
                  <p className="font-medium mt-1">
                    {document.uploadedBy.firstName} {document.uploadedBy.lastName}
                  </p>
                </div>
              )}
              {document.verifiedBy && (
                <div>
                  <p className="text-sm text-muted-foreground">
                    {document.status === 'REJECTED' ? t('documents.preview.rejectedBy') : t('documents.preview.verifiedBy')}
                  </p>
                  <p className="font-medium mt-1">
                    {document.verifiedBy.firstName} {document.verifiedBy.lastName}
                  </p>
                  {document.verifiedAt && (
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(document.verifiedAt)}
                    </p>
                  )}
                </div>
              )}
              {document.notes && (
                <div>
                  <p className="text-sm text-muted-foreground">Notes</p>
                  <p className="font-medium mt-1 whitespace-pre-line">{document.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Approve / Reject — only for PENDING docs, gated on
              documents:update (the "Documents → Edit" toggle in the
              Roles UI, same key the backend verify endpoint enforces).
              Visibility == capability: only roles with Documents → Edit
              see these. */}
          {document.status === 'PENDING' && can('documents', 'update') && (
            <div className="space-y-3">
              <Button
                className="w-full bg-[#22C55E] hover:bg-[#16A34A]"
                onClick={handleApprove}
                disabled={verifying}
              >
                <CheckCircle2 className="w-4 h-4 me-2" />
                {verifying ? 'Processing…' : 'Approve Document'}
              </Button>
              <Button
                variant="outline"
                className="w-full text-[#EF4444] border-[#EF4444] hover:bg-[#FEF2F2]"
                onClick={() => { setRejectionReason(''); setRejectOpen(true); }}
                disabled={verifying}
              >
                <XCircle className="w-4 h-4 me-2" />
                Reject Document
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Rejection Reason Dialog */}
      <Dialog open={rejectOpen} onOpenChange={open => !open && setRejectOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Rejecting:{' '}
              <span className="font-medium text-[#0F172A]">{getDocumentDisplayName(document.name, document.documentType?.name)}</span>
            </p>
            <div className="space-y-2">
              <Label htmlFor="reject-reason-preview">
                Rejection Reason <span className="text-[#EF4444]">*</span>
              </Label>
              <Textarea
                id="reject-reason-preview"
                placeholder="Explain why this document is being rejected…"
                value={rejectionReason}
                onChange={e => setRejectionReason(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-[#EF4444] hover:bg-[#DC2626] text-white"
              onClick={handleReject}
              disabled={verifying || !rejectionReason.trim()}
            >
              <XCircle className="w-4 h-4 me-2" />
              {verifying ? 'Rejecting…' : 'Confirm Rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
