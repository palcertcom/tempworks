import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { mockDrivers } from '../../data/mockData';

export function VisaTracking() {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();
  const visaDrivers = mockDrivers.filter(d =>
    d.currentStage === 'visa_application' || d.currentStage === 'visa_approved' || d.currentStage === 'embassy_appointment'
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('workflow.visas.title')}</h1>
        </div>
        <p className="text-muted-foreground mt-1">{t('workflow.visas.subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Visa Applications Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Citizenship</TableHead>
                  <TableHead>Applied Date</TableHead>
                  <TableHead>Embassy</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visaDrivers.map((driver) => (
                  <TableRow key={driver.id}>
                    <TableCell className="font-medium">
                      {driver.firstName} {driver.lastName}
                    </TableCell>
                    <TableCell>{driver.nationality}</TableCell>
                    <TableCell>{driver.joinedDate}</TableCell>
                    <TableCell>Embassy of {driver.nationality}</TableCell>
                    <TableCell>
                      <Badge className="bg-[#2563EB]">
                        {driver.currentStage.replace(/_/g, ' ')}
                      </Badge>
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
