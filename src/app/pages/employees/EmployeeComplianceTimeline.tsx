import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CheckCircle2, AlertTriangle, XCircle, Clock, FileText, Shield, Calendar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { mockDrivers } from '../../data/mockData';

interface ComplianceEvent {
  id: string;
  type: 'document_verified' | 'license_renewed' | 'medical_check' | 'training_completed' | 
        'compliance_issue' | 'violation' | 'warning' | 'audit_passed' | 'permit_granted';
  title: string;
  description: string;
  date: string;
  status: 'completed' | 'warning' | 'critical' | 'resolved';
  category: string;
  actionedBy?: string;
  documentRef?: string;
  notes?: string;
}

const mockComplianceTimeline: ComplianceEvent[] = [
  {
    id: 'CE001',
    type: 'document_verified',
    title: 'Work Permit Renewed',
    description: 'Work permit successfully renewed for another 2 years',
    date: '2024-03-10',
    status: 'completed',
    category: 'Legal Documents',
    actionedBy: 'Sarah Johnson',
    documentRef: 'WP-2024-8821',
  },
  {
    id: 'CE002',
    type: 'training_completed',
    title: 'C95 Training Completed',
    description: 'Successfully completed mandatory C95 professional qualification training',
    date: '2024-01-20',
    status: 'completed',
    category: 'Training',
    actionedBy: 'Training Center',
    documentRef: 'C95-2024-0045',
  },
  {
    id: 'CE003',
    type: 'medical_check',
    title: 'Annual Medical Examination Passed',
    description: 'Driver passed all required medical tests and health screenings',
    date: '2024-02-01',
    status: 'completed',
    category: 'Health & Safety',
    actionedBy: 'Dr. Maria Kaminska',
    documentRef: 'MED-2024-7721',
  },
  {
    id: 'CE004',
    type: 'compliance_issue',
    title: 'Tachograph Data Gap Detected',
    description: 'Missing tachograph data for 3 days due to card malfunction',
    date: '2024-01-15',
    status: 'resolved',
    category: 'Equipment Compliance',
    actionedBy: 'Compliance Team',
    notes: 'Card replaced, written explanation provided and accepted',
  },
  {
    id: 'CE005',
    type: 'audit_passed',
    title: 'Quarterly Compliance Audit Passed',
    description: 'All documents and records verified during routine compliance audit',
    date: '2024-01-05',
    status: 'completed',
    category: 'Audit',
    actionedBy: 'Compliance Officer',
  },
  {
    id: 'CE006',
    type: 'license_renewed',
    title: 'ADR Certificate Renewed',
    description: 'Dangerous goods transport certificate renewed after refresher course',
    date: '2023-11-12',
    status: 'completed',
    category: 'Certifications',
    actionedBy: 'Safety Training Institute',
    documentRef: 'ADR-PL-88921',
  },
  {
    id: 'CE007',
    type: 'warning',
    title: 'Driving Hours Limit Warning',
    description: 'Approached maximum weekly driving hours (56h limit)',
    date: '2023-10-18',
    status: 'warning',
    category: 'Working Time',
    actionedBy: 'Fleet Manager',
    notes: 'Driver counseled on proper rest period planning',
  },
  {
    id: 'CE008',
    type: 'document_verified',
    title: 'Passport Verification Completed',
    description: 'Passport validity verified - expires 2028',
    date: '2023-09-20',
    status: 'completed',
    category: 'Travel Documents',
    actionedBy: 'HR Department',
  },
  {
    id: 'CE009',
    type: 'training_completed',
    title: 'Defensive Driving Course Completed',
    description: 'Successfully completed advanced defensive driving training',
    date: '2023-09-14',
    status: 'completed',
    category: 'Training',
    actionedBy: 'Road Safety Academy',
  },
  {
    id: 'CE010',
    type: 'permit_granted',
    title: 'Cross-Border Transport Permit Granted',
    description: 'Authorized for international transport operations in EU',
    date: '2023-08-25',
    status: 'completed',
    category: 'Permits',
    actionedBy: 'Transport Authority',
    documentRef: 'CBT-EU-2023-5512',
  },
];

export function EmployeeComplianceTimeline() {
  const { t } = useTranslation('pages');
  const { id } = useParams();
  const driver = mockDrivers.find(d => d.id === id);
  
  if (!driver) {
    return <div>Driver not found</div>;
  }

  const completedEvents = mockComplianceTimeline.filter(e => e.status === 'completed').length;
  const warningEvents = mockComplianceTimeline.filter(e => e.status === 'warning').length;
  const resolvedIssues = mockComplianceTimeline.filter(e => e.status === 'resolved').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/employees/${id}`}>
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('employees.complianceTimeline.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('employees.complianceTimeline.subtitle', { name: `${driver.firstName} ${driver.lastName}` })}</p>
        </div>
        <Button variant="outline">{t('employees.complianceTimeline.exportTimeline')}</Button>
      </div>

      {/* Compliance Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{completedEvents}</p>
                <p className="text-sm text-muted-foreground">{t('employees.complianceTimeline.completed')}</p>
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
                <p className="text-2xl font-semibold">{warningEvents}</p>
                <p className="text-sm text-muted-foreground">{t('employees.complianceTimeline.warnings')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Shield className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{resolvedIssues}</p>
                <p className="text-sm text-muted-foreground">{t('employees.complianceTimeline.resolved')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">100%</p>
                <p className="text-sm text-muted-foreground">{t('employees.complianceTimeline.complianceRate')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Compliance Status Summary */}
      <Card>
        <CardHeader>
          <CardTitle>{t('employees.complianceTimeline.currentStatusTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex items-start gap-3 p-4 border rounded-lg bg-[#F0FDF4]">
              <CheckCircle2 className="w-5 h-5 text-[#22C55E] mt-0.5" />
              <div>
                <p className="font-medium text-[#22C55E]">{t('employees.complianceTimeline.allDocsValid')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('employees.complianceTimeline.allDocsValidHelp')}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-4 border rounded-lg bg-[#F0FDF4]">
              <CheckCircle2 className="w-5 h-5 text-[#22C55E] mt-0.5" />
              <div>
                <p className="font-medium text-[#22C55E]">{t('employees.complianceTimeline.trainingUpToDate')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('employees.complianceTimeline.trainingUpToDateHelp')}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-4 border rounded-lg bg-[#F0FDF4]">
              <CheckCircle2 className="w-5 h-5 text-[#22C55E] mt-0.5" />
              <div>
                <p className="font-medium text-[#22C55E]">{t('employees.complianceTimeline.noActiveIssues')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('employees.complianceTimeline.noActiveIssuesHelp')}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle>{t('employees.complianceTimeline.eventTimelineTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">{t('employees.complianceTimeline.eventTimelineSubtitle')}</p>
        </CardHeader>
        <CardContent>
          <div className="relative">
            {/* Timeline vertical line */}
            <div className="absolute start-6 top-0 bottom-0 w-0.5 bg-[#E2E8F0]" />
            
            <div className="space-y-6">
              {mockComplianceTimeline.map((event) => (
                <div key={event.id} className="relative flex gap-6">
                  {/* Timeline icon */}
                  <div className="relative flex-shrink-0">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center z-10 ${
                      event.status === 'completed' ? 'bg-[#F0FDF4]' :
                      event.status === 'warning' ? 'bg-[#FEF3C7]' :
                      event.status === 'critical' ? 'bg-[#FEE2E2]' :
                      'bg-[#EFF6FF]'
                    }`}>
                      {event.status === 'completed' && <CheckCircle2 className="w-6 h-6 text-[#22C55E]" />}
                      {event.status === 'warning' && <AlertTriangle className="w-6 h-6 text-[#F59E0B]" />}
                      {event.status === 'critical' && <XCircle className="w-6 h-6 text-[#EF4444]" />}
                      {event.status === 'resolved' && <Shield className="w-6 h-6 text-[#2563EB]" />}
                    </div>
                  </div>

                  {/* Event content */}
                  <div className="flex-1 pb-6">
                    <div className="bg-white border rounded-lg p-4 hover:shadow-md transition-shadow">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold text-[#0F172A]">{event.title}</h3>
                            <Badge 
                              variant="outline"
                              className={
                                event.status === 'completed' ? 'bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]' :
                                event.status === 'warning' ? 'bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]' :
                                event.status === 'critical' ? 'bg-[#FEE2E2] text-[#EF4444] border-[#EF4444]' :
                                'bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]'
                              }
                            >
                              {event.status}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {event.category}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">{event.description}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mt-3 pt-3 border-t text-sm">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-muted-foreground" />
                          <div>
                            <p className="text-xs text-muted-foreground">{t('employees.complianceTimeline.date')}</p>
                            <p className="font-medium">{event.date}</p>
                          </div>
                        </div>
                        {event.actionedBy && (
                          <div className="flex items-center gap-2">
                            <Shield className="w-4 h-4 text-muted-foreground" />
                            <div>
                              <p className="text-xs text-muted-foreground">{t('employees.complianceTimeline.actionedBy')}</p>
                              <p className="font-medium">{event.actionedBy}</p>
                            </div>
                          </div>
                        )}
                        {event.documentRef && (
                          <div className="flex items-center gap-2">
                            <FileText className="w-4 h-4 text-muted-foreground" />
                            <div>
                              <p className="text-xs text-muted-foreground">{t('employees.complianceTimeline.reference')}</p>
                              <p className="font-medium">{event.documentRef}</p>
                            </div>
                          </div>
                        )}
                      </div>

                      {event.notes && (
                        <div className="mt-3 pt-3 border-t">
                          <p className="text-xs text-muted-foreground mb-1">{t('employees.complianceTimeline.notesLabel')}</p>
                          <p className="text-sm bg-[#F8FAFC] p-2 rounded">{event.notes}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="text-center pt-6 border-t">
            <Button variant="outline">{t('employees.complianceTimeline.loadOlder')}</Button>
          </div>
        </CardContent>
      </Card>

      {/* Upcoming Compliance Requirements */}
      <Card>
        <CardHeader>
          <CardTitle>{t('employees.complianceTimeline.upcomingTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-4 border rounded-lg">
              <Clock className="w-5 h-5 text-[#F59E0B] mt-0.5" />
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <p className="font-medium">{t('employees.complianceTimeline.adrTitle')}</p>
                  <Badge variant="outline" className="bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]">
                    {t('employees.complianceTimeline.adrBadge')}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{t('employees.complianceTimeline.adrHelp')}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-4 border rounded-lg">
              <Clock className="w-5 h-5 text-[#2563EB] mt-0.5" />
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <p className="font-medium">{t('employees.complianceTimeline.medicalTitle')}</p>
                  <Badge variant="outline" className="bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]">
                    {t('employees.complianceTimeline.medicalBadge')}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{t('employees.complianceTimeline.medicalHelp')}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}