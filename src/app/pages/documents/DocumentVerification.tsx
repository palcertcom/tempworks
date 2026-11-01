import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Search, CheckCircle2, XCircle, FileText, Eye, Clock, ShieldCheck, ArrowLeft,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { Textarea } from '../../components/ui/textarea';
import { Label } from '../../components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';
import { toast } from 'sonner';
import { documentsApi, employeesApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { formatDate } from '../../../i18n/formatters';
import { getDocumentDisplayName } from '../../utils/documentDisplay';

export function DocumentVerification() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [documents, setDocuments]     = useState<any[]>([]);
  const [employeeMap, setEmployeeMap] = useState<Record<string, string>>({});
  const [loading, setLoading]         = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [verifying, setVerifying]     = useState<string | null>(null);

  const [rejectDialog, setRejectDialog] = useState<{
    open: boolean; docId: string; docName: string;
  }>({ open: false, docId: '', docName: '' });
  const [rejectionReason, setRejectionReason] = useState('');

  useEffect(() => {
    const loadDocs = documentsApi.list({ limit: 200 })
      .then((res: any) => {
        const all: any[] = res?.data ?? [];
        setDocuments(all.filter(d => d.status === 'PENDING'));
      })
      .catch(() => toast.error(tc('toast.loadFailed')));

    const loadEmps = employeesApi.list({ limit: 500 })
      .then((res: any) => {
        const map: Record<string, string> = {};
        (res?.data ?? []).forEach((e: any) => { map[e.id] = `${e.firstName} ${e.lastName}`; });
        setEmployeeMap(map);
      })
      .catch(() => {});

    Promise.all([loadDocs, loadEmps]).finally(() => setLoading(false));
  }, []);

  const handleApprove = async (doc: any) => {
    setVerifying(doc.id);
    try {
      await documentsApi.verify(doc.id, { action: 'VERIFY' });
      setDocuments(prev => prev.filter(d => d.id !== doc.id));
      toast.success(tc('toast.approvedNamed', { name: doc.name }));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.operationFailed')));
    } finally {
      setVerifying(null);
    }
  };

  const openRejectDialog = (doc: any) => {
    setRejectDialog({ open: true, docId: doc.id, docName: doc.name });
    setRejectionReason('');
  };

  const handleReject = async () => {
    if (!rejectionReason.trim()) {
      toast.error(tc('toast.rejectionReasonRequired'));
      return;
    }
    setVerifying(rejectDialog.docId);
    try {
      await documentsApi.verify(rejectDialog.docId, {
        action: 'REJECT',
        reason: rejectionReason.trim(),
      });
      setDocuments(prev => prev.filter(d => d.id !== rejectDialog.docId));
      toast.success(tc('toast.rejectedNamed', { name: rejectDialog.docName }));
      setRejectDialog({ open: false, docId: '', docName: '' });
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.operationFailed')));
    } finally {
      setVerifying(null);
    }
  };

  const filtered = documents.filter(doc => {
    const entityName = employeeMap[doc.entityId] ?? '';
    const q = searchQuery.toLowerCase();
    return (
      doc.name.toLowerCase().includes(q) ||
      entityName.toLowerCase().includes(q) ||
      (doc.documentType?.name ?? '').toLowerCase().includes(q)
    );
  });

  const docTypeCount = [...new Set(documents.map(d => d.documentType?.name).filter(Boolean))].length;

  if (loading) return <div className="p-8 text-muted-foreground">{t('documents.verification.loading')}</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{t('documents.verification.title')}</h1>
          </div>
          <p className="text-muted-foreground mt-1">
            {t('documents.dashboard.subtitle')}
          </p>
        </div>
        {!can('documents', 'verify') && (
          <Badge className="bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]">
            {t('documents.verification.viewOnly')}
          </Badge>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-6 flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-[#F8FAFC] flex items-center justify-center">
              <Clock className="w-6 h-6 text-[#64748B]" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{documents.length}</p>
              <p className="text-sm text-muted-foreground">{t('documents.verification.awaitingReview')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6 flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
              <FileText className="w-6 h-6 text-[#3B82F6]" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{docTypeCount}</p>
              <p className="text-sm text-muted-foreground">{t('documents.verification.documentTypes')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6 flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
              <ShieldCheck className="w-6 h-6 text-[#22C55E]" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{filtered.length}</p>
              <p className="text-sm text-muted-foreground">{t('documents.verification.matchingSearch')}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t('documents.verification.searchPh')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="ps-9"
            />
          </div>
        </CardContent>
      </Card>

      {/* Verification Queue */}
      <Card>
        <CardHeader>
          <CardTitle>{t('documents.verification.pending', { count: filtered.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="py-16 text-center">
              <CheckCircle2 className="w-12 h-12 mx-auto mb-4 text-[#22C55E]" />
              <p className="font-medium text-[#0F172A]">{t('documents.verification.allClear')}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {documents.length === 0
                  ? t('documents.verification.noPending')
                  : t('documents.verification.noMatches')}
              </p>
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-[#F8FAFC] border-b">
                  <tr>
                    <th className="text-start p-4 text-sm font-semibold">{t('documents.verification.tableHeaders.document')}</th>
                    <th className="text-start p-4 text-sm font-semibold">{t('documents.verification.tableHeaders.type')}</th>
                    <th className="text-start p-4 text-sm font-semibold">{t('documents.verification.tableHeaders.entity')}</th>
                    <th className="text-start p-4 text-sm font-semibold">{t('documents.verification.tableHeaders.uploadedBy')}</th>
                    <th className="text-start p-4 text-sm font-semibold">{t('documents.verification.tableHeaders.expiryDate')}</th>
                    <th className="text-start p-4 text-sm font-semibold">{t('documents.verification.tableHeaders.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(doc => (
                    <tr key={doc.id} className="border-b hover:bg-[#F8FAFC] transition-colors">
                      <td className="p-4">
                        <p className="font-medium">{getDocumentDisplayName(doc.name, doc.documentType?.name)}</p>
                        {doc.documentNumber && (
                          <p className="text-xs text-muted-foreground">#{doc.documentNumber}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {(doc.fileSize / 1024).toFixed(1)} KB · {doc.mimeType?.split('/')[1]?.toUpperCase()}
                        </p>
                      </td>
                      <td className="p-4 text-sm">{doc.documentType?.name ?? '—'}</td>
                      <td className="p-4">
                        <p className="font-medium text-sm">
                          {employeeMap[doc.entityId] ?? doc.entityId}
                        </p>
                        <p className="text-xs text-muted-foreground">{doc.entityType}</p>
                      </td>
                      <td className="p-4 text-sm">
                        <p>
                          {doc.uploadedBy
                            ? `${doc.uploadedBy.firstName} ${doc.uploadedBy.lastName}`
                            : '—'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(doc.createdAt)}
                        </p>
                      </td>
                      <td className="p-4 text-sm">
                        {doc.expiryDate
                          ? formatDate(doc.expiryDate)
                          : 'N/A'}
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          {/* Preview */}
                          <Button size="sm" variant="ghost" title="Preview document" asChild>
                            <Link to={`/dashboard/documents/${doc.id}`}>
                              <Eye className="w-4 h-4" />
                            </Link>
                          </Button>

                          {can('documents', 'verify') && (
                            <>
                              <Button
                                size="sm"
                                className="bg-[#22C55E] hover:bg-[#16A34A] text-white"
                                onClick={() => handleApprove(doc)}
                                disabled={verifying === doc.id}
                              >
                                <CheckCircle2 className="w-4 h-4 me-1" />
                                {verifying === doc.id ? '…' : 'Approve'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-[#EF4444] border-[#EF4444] hover:bg-[#FEF2F2]"
                                onClick={() => openRejectDialog(doc)}
                                disabled={verifying === doc.id}
                              >
                                <XCircle className="w-4 h-4 me-1" />
                                Reject
                              </Button>
                            </>
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

      {/* Rejection Reason Dialog */}
      <Dialog
        open={rejectDialog.open}
        onOpenChange={open => !open && setRejectDialog(s => ({ ...s, open: false }))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Rejecting:{' '}
              <span className="font-medium text-[#0F172A]">{rejectDialog.docName}</span>
            </p>
            <div className="space-y-2">
              <Label htmlFor="reject-reason">
                Rejection Reason <span className="text-[#EF4444]">*</span>
              </Label>
              <Textarea
                id="reject-reason"
                placeholder="Explain why this document is being rejected (e.g. illegible, expired, wrong document type…)"
                value={rejectionReason}
                onChange={e => setRejectionReason(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejectDialog(s => ({ ...s, open: false }))}
            >
              Cancel
            </Button>
            <Button
              className="bg-[#EF4444] hover:bg-[#DC2626] text-white"
              onClick={handleReject}
              disabled={!!verifying || !rejectionReason.trim()}
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
