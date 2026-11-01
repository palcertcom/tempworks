import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Award, Calendar, CheckCircle2, AlertTriangle, Download, Upload } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Progress } from '../../components/ui/progress';
import { mockDrivers } from '../../data/mockData';

interface Certification {
  id: string;
  type: string;
  category: string;
  number: string;
  issuedDate: string;
  expiryDate: string;
  issuingAuthority: string;
  status: 'valid' | 'expiring_soon' | 'expired' | 'renewal_required';
  verificationStatus: 'verified' | 'pending' | 'rejected';
  attachments: string[];
  restrictions?: string[];
  endorsements?: string[];
}

const mockCertifications: Certification[] = [
  {
    id: 'CERT001',
    type: 'CE Driving License',
    category: 'Driving License',
    number: 'PL-12345-CE',
    issuedDate: '2018-05-15',
    expiryDate: '2028-05-15',
    issuingAuthority: 'Polish Road Authority',
    status: 'valid',
    verificationStatus: 'verified',
    attachments: ['license-front.pdf', 'license-back.pdf'],
    endorsements: ['Passenger Transport', 'Dangerous Goods'],
    restrictions: ['Glasses Required']
  },
  {
    id: 'CERT002',
    type: 'C95 Professional Qualification',
    category: 'Professional Qualification',
    number: 'C95-2024-0045',
    issuedDate: '2024-01-20',
    expiryDate: '2029-01-20',
    issuingAuthority: 'EU Transport Commission',
    status: 'valid',
    verificationStatus: 'verified',
    attachments: ['c95-certificate.pdf'],
  },
  {
    id: 'CERT003',
    type: 'ADR - Dangerous Goods',
    category: 'Special License',
    number: 'ADR-PL-88921',
    issuedDate: '2022-03-10',
    expiryDate: '2025-03-10',
    issuingAuthority: 'Dangerous Goods Authority',
    status: 'expiring_soon',
    verificationStatus: 'verified',
    attachments: ['adr-certificate.pdf'],
  },
  {
    id: 'CERT004',
    type: 'Digital Tachograph Card',
    category: 'Equipment License',
    number: 'DTCO-PL-45678',
    issuedDate: '2023-06-15',
    expiryDate: '2028-06-15',
    issuingAuthority: 'Transport Authority',
    status: 'valid',
    verificationStatus: 'verified',
    attachments: ['tachograph-card.pdf'],
  },
  {
    id: 'CERT005',
    type: 'Medical Certificate',
    category: 'Health & Safety',
    number: 'MED-2024-7721',
    issuedDate: '2024-02-01',
    expiryDate: '2025-02-01',
    issuingAuthority: 'Occupational Health Center',
    status: 'valid',
    verificationStatus: 'verified',
    attachments: ['medical-cert.pdf'],
  },
  {
    id: 'CERT006',
    type: 'Forklift Operator License',
    category: 'Additional License',
    number: 'FKL-PL-2341',
    issuedDate: '2020-08-12',
    expiryDate: '2023-08-12',
    issuingAuthority: 'Industrial Training Center',
    status: 'expired',
    verificationStatus: 'verified',
    attachments: ['forklift-cert.pdf'],
  }
];

export function EmployeeCertifications() {
  const { t } = useTranslation('pages');
  const { id } = useParams();
  const driver = mockDrivers.find(d => d.id === id);
  
  if (!driver) {
    return <div>Driver not found</div>;
  }

  const validCerts = mockCertifications.filter(c => c.status === 'valid').length;
  const expiringSoon = mockCertifications.filter(c => c.status === 'expiring_soon').length;
  const expired = mockCertifications.filter(c => c.status === 'expired').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/employees/${id}`}>
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('employees.certifications.pageTitle')}</h1>
          <p className="text-muted-foreground mt-1">{driver.firstName} {driver.lastName} • All professional certifications and licenses</p>
        </div>
        <Button>
          <Plus className="w-4 h-4 me-2" />
          Add Certification
        </Button>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{validCerts}</p>
                <p className="text-sm text-muted-foreground">Valid</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#FEF3C7] flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-[#F59E0B]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{expiringSoon}</p>
                <p className="text-sm text-muted-foreground">{t('employees.certifications.expiringSoon')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#FEE2E2] flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-[#EF4444]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{expired}</p>
                <p className="text-sm text-muted-foreground">Expired</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Award className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{mockCertifications.length}</p>
                <p className="text-sm text-muted-foreground">Total</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Certifications by Category */}
      {['Driving License', 'Professional Qualification', 'Special License', 'Equipment License', 'Health & Safety', 'Additional License'].map((category) => {
        const categoryCerts = mockCertifications.filter(c => c.category === category);
        if (categoryCerts.length === 0) return null;

        return (
          <Card key={category}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{category}</CardTitle>
                <Badge>{categoryCerts.length}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {categoryCerts.map((cert) => {
                  const daysUntilExpiry = Math.floor((new Date(cert.expiryDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
                  
                  return (
                    <div key={cert.id} className="border rounded-lg p-4 hover:bg-[#F8FAFC] transition-colors">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-start gap-4">
                          <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${
                            cert.status === 'valid' ? 'bg-[#F0FDF4]' :
                            cert.status === 'expiring_soon' ? 'bg-[#FEF3C7]' :
                            'bg-[#FEE2E2]'
                          }`}>
                            <Award className={`w-6 h-6 ${
                              cert.status === 'valid' ? 'text-[#22C55E]' :
                              cert.status === 'expiring_soon' ? 'text-[#F59E0B]' :
                              'text-[#EF4444]'
                            }`} />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold text-[#0F172A]">{cert.type}</h3>
                              <Badge 
                                variant="outline"
                                className={
                                  cert.status === 'valid' ? 'bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]' :
                                  cert.status === 'expiring_soon' ? 'bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]' :
                                  'bg-[#FEE2E2] text-[#EF4444] border-[#EF4444]'
                                }
                              >
                                {cert.status.replace(/_/g, ' ')}
                              </Badge>
                              {cert.verificationStatus === 'verified' && (
                                <Badge variant="outline" className="bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]">
                                  Verified
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">Certificate #: {cert.number}</p>
                            <p className="text-sm text-muted-foreground">{cert.issuingAuthority}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="ghost">
                            <Download className="w-4 h-4 me-1" />
                            Download
                          </Button>
                          <Button size="sm" variant="outline">
                            <Upload className="w-4 h-4 me-1" />
                            Renew
                          </Button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mb-3">
                        <div>
                          <div className="flex items-center gap-2 text-sm mb-1">
                            <Calendar className="w-4 h-4 text-muted-foreground" />
                            <span className="text-muted-foreground">{t('employees.certifications.issued')}</span>
                            <span className="font-medium">{cert.issuedDate}</span>
                          </div>
                        </div>
                        <div>
                          <div className="flex items-center gap-2 text-sm mb-1">
                            <Calendar className="w-4 h-4 text-muted-foreground" />
                            <span className="text-muted-foreground">{t('employees.certifications.expires')}</span>
                            <span className="font-medium">{cert.expiryDate}</span>
                            {daysUntilExpiry > 0 && daysUntilExpiry < 90 && (
                              <span className="text-xs text-[#F59E0B]">({daysUntilExpiry} days)</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Validity Progress */}
                      {cert.status !== 'expired' && (
                        <div className="mb-3">
                          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                            <span>Validity Period</span>
                            <span>{daysUntilExpiry} days remaining</span>
                          </div>
                          <Progress 
                            value={Math.max(0, Math.min(100, (daysUntilExpiry / 365) * 100))} 
                            className="h-1.5"
                          />
                        </div>
                      )}

                      {/* Endorsements */}
                      {cert.endorsements && cert.endorsements.length > 0 && (
                        <div className="mb-2">
                          <p className="text-xs text-muted-foreground mb-1">{t('employees.certifications.endorsements')}</p>
                          <div className="flex flex-wrap gap-1">
                            {cert.endorsements.map((endorsement, idx) => (
                              <Badge key={idx} variant="outline" className="text-xs bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]">
                                {endorsement}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Restrictions */}
                      {cert.restrictions && cert.restrictions.length > 0 && (
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">{t('employees.certifications.restrictions')}</p>
                          <div className="flex flex-wrap gap-1">
                            {cert.restrictions.map((restriction, idx) => (
                              <Badge key={idx} variant="outline" className="text-xs bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]">
                                {restriction}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Attachments */}
                      {cert.attachments.length > 0 && (
                        <div className="mt-3 pt-3 border-t">
                          <p className="text-xs text-muted-foreground mb-2">{t('employees.certifications.attachedDocs')}</p>
                          <div className="flex flex-wrap gap-2">
                            {cert.attachments.map((attachment, idx) => (
                              <Badge key={idx} variant="outline" className="text-xs">
                                {attachment}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}