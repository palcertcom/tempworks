import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { mockDocuments, mockDrivers } from '../../data/mockData';
import { usePermissions } from '../../hooks/usePermissions';

export function ComplianceDashboard() {
  const { canView } = usePermissions();
  const { t } = useTranslation('pages');
  const expiringDocs = mockDocuments.filter(d => d.status === 'expiring_soon');
  const expiredDocs = mockDocuments.filter(d => d.status === 'expired');
  const validDocs = mockDocuments.filter(d => d.status === 'valid');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-[#0F172A]">{t('compliance.dashboard.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('documents.compliance.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('compliance.dashboard.stats.validDocuments')}</CardTitle>
            <CheckCircle2 className="w-4 h-4 text-[#22C55E]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#22C55E]">{validDocs.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('compliance.dashboard.stats.expiringSoon')}</CardTitle>
            <Clock className="w-4 h-4 text-[#F59E0B]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#F59E0B]">{expiringDocs.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('compliance.dashboard.stats.expired')}</CardTitle>
            <AlertTriangle className="w-4 h-4 text-[#EF4444]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#EF4444]">{expiredDocs.length}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Expiring Documents - Attention Required</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Document Type</TableHead>
                  <TableHead>Expiry Date</TableHead>
                  <TableHead>Days Remaining</TableHead>
                  <TableHead>Priority</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {expiringDocs.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className="font-medium">{doc.driverName}</TableCell>
                    <TableCell>{doc.type}</TableCell>
                    <TableCell>{doc.expiryDate}</TableCell>
                    <TableCell>28 days</TableCell>
                    <TableCell>
                      <Badge className="bg-[#F59E0B]">High</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Driver Compliance Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {mockDrivers.slice(0, 5).map((driver) => (
              canView('compliance') ? (
                <Link
                  key={driver.id}
                  to={`/compliance/drivers/${driver.id}`}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-[#F8FAFC] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <img src={driver.photo} alt={driver.firstName} className="w-10 h-10 rounded-full" />
                    <div>
                      <p className="font-medium">{driver.firstName} {driver.lastName}</p>
                      <p className="text-sm text-muted-foreground">{driver.nationality}</p>
                    </div>
                  </div>
                  <Badge className="bg-[#22C55E]">Compliant</Badge>
                </Link>
              ) : (
                <div
                  key={driver.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <img src={driver.photo} alt={driver.firstName} className="w-10 h-10 rounded-full" />
                    <div>
                      <p className="font-medium">{driver.firstName} {driver.lastName}</p>
                      <p className="text-sm text-muted-foreground">{driver.nationality}</p>
                    </div>
                  </div>
                  <Badge className="bg-[#22C55E]">Compliant</Badge>
                </div>
              )
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
