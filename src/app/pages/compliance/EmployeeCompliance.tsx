import { Link, useParams } from 'react-router';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileCheck, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { employeesApi } from '../../services/api';
import { formatDate } from '../../../i18n/formatters';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';

export function EmployeeCompliance() {
  const { t } = useTranslation('pages');
  const { id } = useParams();
  const tenantVersion = useTenantSyncVersion();
  const [employee, setEmployee] = useState<any>(null);
  const [documents, setDocuments] = useState<any[]>([]);
  const [compliance, setCompliance] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    Promise.all([
      employeesApi.get(id!),
      employeesApi.getDocuments(id!),
      employeesApi.getCompliance(id!),
    ]).then(([emp, docs, comp]) => {
      setEmployee(emp);
      setDocuments(docs ?? []);
      setCompliance(comp);
    }).catch(() => setNotFound(true))
      .finally(() => setLoading(false));
    // Phase 3 (#1 R-3) — refetch when SUPER switches the active tenant.
  }, [id, tenantVersion]);

  if (loading) return <div className="p-8 text-muted-foreground">{t('compliance.employee.loading')}</div>;
  if (notFound || !employee) return <div className="p-8">{t('compliance.employee.notFound')}</div>;

  const getDocStatusIcon = (status: string) => {
    switch (status) {
      case 'VALID': return <CheckCircle2 className="w-4 h-4 text-[#22C55E]" />;
      case 'EXPIRED': return <AlertTriangle className="w-4 h-4 text-[#EF4444]" />;
      case 'EXPIRING_SOON': return <Clock className="w-4 h-4 text-[#F59E0B]" />;
      default: return <FileCheck className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getDocStatusBadge = (status: string) => {
    switch (status) {
      case 'VALID': return <Badge className="bg-[#22C55E]">{t('compliance.employee.statusBadge.valid')}</Badge>;
      case 'EXPIRED': return <Badge className="bg-[#EF4444]">{t('compliance.employee.statusBadge.expired')}</Badge>;
      case 'EXPIRING_SOON': return <Badge className="bg-[#F59E0B]">{t('compliance.employee.statusBadge.expiringSoon')}</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/compliance"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">
            {employee.firstName} {employee.lastName}{t('compliance.employee.headerSuffix')}
          </h1>
          <p className="text-muted-foreground mt-1">{t('compliance.employee.subtitle')}</p>
        </div>
      </div>

      {/* Compliance Summary */}
      {compliance && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card>
            <CardContent className="p-6 flex items-center gap-3">
              <CheckCircle2 className="w-8 h-8 text-[#22C55E]" />
              <div>
                <p className="text-2xl font-semibold">{compliance.validDocuments ?? 0}</p>
                <p className="text-sm text-muted-foreground">{t('compliance.employee.validDocuments')}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6 flex items-center gap-3">
              <Clock className="w-8 h-8 text-[#F59E0B]" />
              <div>
                <p className="text-2xl font-semibold">{compliance.expiringSoon ?? 0}</p>
                <p className="text-sm text-muted-foreground">{t('compliance.employee.expiringSoon')}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6 flex items-center gap-3">
              <AlertTriangle className="w-8 h-8 text-[#EF4444]" />
              <div>
                <p className="text-2xl font-semibold">{compliance.expiredDocuments ?? 0}</p>
                <p className="text-sm text-muted-foreground">{t('compliance.employee.expiredDocuments')}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Documents */}
      <Card>
        <CardHeader>
          <CardTitle>{t('compliance.employee.documentsCount', { count: documents.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <p className="text-muted-foreground">{t('compliance.employee.noDocuments')}</p>
          ) : (
            <div className="space-y-3">
              {documents.map((doc: any) => (
                <div key={doc.id} className="flex items-center justify-between p-4 rounded-lg border hover:bg-[#F8FAFC] transition-colors">
                  <div className="flex items-center gap-3">
                    {getDocStatusIcon(doc.status)}
                    <div>
                      <p className="font-medium">{doc.type}</p>
                      <p className="text-sm text-muted-foreground">
                        {doc.expiryDate ? t('compliance.employee.expiresPrefix', { date: formatDate(doc.expiryDate) }) : t('compliance.employee.noExpiry')}
                      </p>
                    </div>
                  </div>
                  {getDocStatusBadge(doc.status)}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
