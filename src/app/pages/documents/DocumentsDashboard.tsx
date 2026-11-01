import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Upload, FileCheck, AlertTriangle, Clock, Eye } from 'lucide-react';
import { usePermissions } from '../../hooks/usePermissions';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Progress } from '../../components/ui/progress';
import { toast } from 'sonner';
import { documentsApi } from '../../services/api';
import { formatDate } from '../../../i18n/formatters';
import { getDocumentDisplayName } from '../../utils/documentDisplay';

export function DocumentsDashboard() {
  const { canCreate } = usePermissions();
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    documentsApi.list({ limit: 200 })
      .then((res: any) => setDocuments(res?.data ?? []))
      .catch(() => toast.error(t('documents.dashboard.loadFailed')))
      .finally(() => setLoading(false));
  }, []);

  const validDocs = documents.filter(d => d.status === 'VERIFIED').length;
  const expiringDocs = documents.filter(d => d.status === 'EXPIRING_SOON').length;
  const pendingDocs = documents.filter(d => d.status === 'PENDING').length;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'VERIFIED': return 'bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]';
      case 'EXPIRING_SOON': return 'bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]';
      case 'EXPIRED': return 'bg-[#FEE2E2] text-[#EF4444] border-[#EF4444]';
      case 'PENDING': return 'bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]';
      default: return 'bg-[#F8FAFC] text-[#0F172A] border-[#E2E8F0]';
    }
  };

  const getCategoryCount = (typeName: string) =>
    documents.filter(d => d.documentType?.name === typeName).length;

  const categories = [...new Set(documents.map(d => d.documentType?.name).filter(Boolean))].slice(0, 4);

  if (loading) return <div className="p-8 text-muted-foreground">{tc('states.loading')}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('documents.dashboard.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('documents.dashboard.subtitle')}</p>
        </div>
        {canCreate('documents') && (
          <Button asChild>
            <Link to="/dashboard/documents/upload">
              <Upload className="w-4 h-4 me-2" />
              {t('documents.dashboard.uploadButton')}
            </Link>
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('documents.dashboard.totalDocuments')}</CardTitle>
            <FileCheck className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#0F172A]">{documents.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('documents.dashboard.valid')}</CardTitle>
            <FileCheck className="w-4 h-4 text-[#22C55E]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#22C55E]">{validDocs}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('documents.dashboard.expiringSoon')}</CardTitle>
            <AlertTriangle className="w-4 h-4 text-[#F59E0B]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#F59E0B]">{expiringDocs}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('documents.dashboard.pendingReview')}</CardTitle>
            <Clock className="w-4 h-4 text-[#2563EB]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#2563EB]">{pendingDocs}</div>
          </CardContent>
        </Card>
      </div>

      {categories.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('documents.dashboard.documentCategories')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {categories.map((category) => {
                const count = getCategoryCount(category);
                const pct = documents.length > 0 ? Math.round((count / documents.length) * 100) : 0;
                return (
                  <div key={category} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{category}</span>
                      <span className="font-medium">{t('documents.dashboard.categoryCount', { count })}</span>
                    </div>
                    <Progress value={pct} className="h-2" />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('documents.dashboard.recentDocuments')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('documents.dashboard.tableHeaders.documentName')}</TableHead>
                  <TableHead>{t('documents.dashboard.tableHeaders.type')}</TableHead>
                  <TableHead>{t('documents.dashboard.tableHeaders.uploaded')}</TableHead>
                  <TableHead>{t('documents.dashboard.tableHeaders.expiryDate')}</TableHead>
                  <TableHead>{t('documents.dashboard.tableHeaders.status')}</TableHead>
                  <TableHead className="text-end">{t('documents.dashboard.tableHeaders.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="p-8 text-center text-muted-foreground">
                      {t('documents.dashboard.noDocuments')} <Link to="/dashboard/documents/upload" className="text-[#2563EB] hover:underline">{t('documents.dashboard.uploadOne')}</Link>.
                    </TableCell>
                  </TableRow>
                ) : documents.slice(0, 20).map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className="font-medium">{getDocumentDisplayName(doc.name, doc.documentType?.name)}</TableCell>
                    <TableCell>{doc.documentType?.name ?? '-'}</TableCell>
                    <TableCell>{formatDate(doc.createdAt)}</TableCell>
                    <TableCell>{doc.expiryDate ? formatDate(doc.expiryDate) : 'N/A'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={getStatusColor(doc.status)}>
                        {doc.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/dashboard/documents/${doc.id}`}>
                          <Eye className="w-4 h-4 me-2" />
                          {tc('actions.view')}
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
