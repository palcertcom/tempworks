import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Clock, CheckCircle2, AlertCircle, Filter, Download, UserPlus, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Progress } from '../../components/ui/progress';
import { workflowStages, mockDrivers } from '../../data/mockData';

export function WorkflowStageDetail() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { stageId } = useParams();
  const stage = workflowStages.find(s => s.id === stageId);
  
  if (!stage) {
    return <div>Stage not found</div>;
  }

  const driversInStage = mockDrivers.filter(d => d.currentStage === stageId);
  const avgDaysInStage = 7; // Mock data
  const slaThreshold = 14; // Mock SLA threshold in days
  const atRiskCount = 3; // Mock count of drivers at risk of SLA breach

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/workflow">
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{stage.name}</h1>
          <p className="text-muted-foreground mt-1">Stage {stage.order} of {workflowStages.length} • Manage drivers in this workflow stage</p>
        </div>
        <Button>
          <Download className="w-4 h-4 me-2" />
          {t('workflow.stageDetail.exportReport')}
        </Button>
      </div>

      {/* Stage Overview Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <UserPlus className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{driversInStage.length}</p>
                <p className="text-sm text-muted-foreground">{t('workflow.stageDetail.driversInStage')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <Clock className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{avgDaysInStage}</p>
                <p className="text-sm text-muted-foreground">{t('workflow.stageDetail.avgDaysInStage')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#FEF3C7] flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-[#F59E0B]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{atRiskCount}</p>
                <p className="text-sm text-muted-foreground">{t('workflow.stageDetail.atRiskSla')}</p>
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
                <p className="text-2xl font-semibold">85%</p>
                <p className="text-sm text-muted-foreground">{t('workflow.stageDetail.completionRate')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Stage Requirements & Tasks */}
      <Card>
        <CardHeader>
          <CardTitle>{t('workflow.stageDetail.stageRequirements')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {getStageRequirements(stageId).map((req, index) => (
              <div key={index} className="flex items-start gap-3 p-3 border rounded-lg">
                <CheckCircle2 className="w-5 h-5 text-[#22C55E] mt-0.5" />
                <div className="flex-1">
                  <p className="font-medium">{req.title}</p>
                  <p className="text-sm text-muted-foreground mt-1">{req.description}</p>
                </div>
                {req.required && (
                  <Badge variant="outline" className="bg-[#FEE2E2] text-[#EF4444] border-[#EF4444]">
                    {tc('required')}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Drivers in Stage */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Drivers in {stage.name}</CardTitle>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Input 
                placeholder="Search drivers..." 
                className="w-64 ps-9"
              />
              <Filter className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            </div>
            <Button variant="outline">
              <Filter className="w-4 h-4 me-2" />
              Filter
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {driversInStage.map((driver) => {
              const daysInStage = Math.floor(Math.random() * 20) + 1; // Mock
              const isAtRisk = daysInStage > 10;
              
              return (
                <div 
                  key={driver.id} 
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-[#F8FAFC] transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <img 
                      src={driver.photo} 
                      alt={driver.firstName}
                      className="w-12 h-12 rounded-full"
                    />
                    <div>
                      <p className="font-medium">{driver.firstName} {driver.lastName}</p>
                      <p className="text-sm text-muted-foreground">{driver.nationality} • {driver.email}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-6">
                    <div className="text-end">
                      <p className="text-sm font-medium">{daysInStage} days</p>
                      <p className="text-xs text-muted-foreground">{t('workflow.stageDetail.inStage')}</p>
                    </div>
                    
                    {isAtRisk && (
                      <Badge variant="outline" className="bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]">
                        {t('workflow.stageDetail.atRisk')}
                      </Badge>
                    )}
                    
                    <Badge className={
                      driver.status === 'active' ? 'bg-[#22C55E]' :
                      driver.status === 'pending' ? 'bg-[#F59E0B]' :
                      'bg-gray-500'
                    }>
                      {driver.status}
                    </Badge>
                    
                    <Button size="sm" asChild>
                      <Link to={`/dashboard/drivers/${driver.id}`}>
                        View Profile
                        <ChevronRight className="w-4 h-4 ms-1" />
                      </Link>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* SLA Tracking */}
      <Card>
        <CardHeader>
          <CardTitle>SLA Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{t('workflow.stageDetail.stageCompletionRate')}</span>
                <span className="text-sm font-medium">85%</span>
              </div>
              <Progress value={85} className="h-2" />
            </div>
            
            <div className="grid grid-cols-3 gap-4 pt-4 border-t">
              <div className="text-center">
                <p className="text-2xl font-semibold text-[#22C55E]">{driversInStage.length - atRiskCount}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('workflow.stageDetail.onTrack')}</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-semibold text-[#F59E0B]">{atRiskCount}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('workflow.stageDetail.atRisk')}</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-semibold text-[#0F172A]">{slaThreshold} days</p>
                <p className="text-sm text-muted-foreground mt-1">{t('workflow.stageDetail.slaThreshold')}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function getStageRequirements(stageId: string) {
  const requirements: Record<string, Array<{ title: string; description: string; required: boolean }>> = {
    document_verification: [
      { title: 'Valid Passport', description: 'Passport must be valid for at least 6 months', required: true },
      { title: 'Driving License Verification', description: 'Verify CE category driving license', required: true },
      { title: 'Criminal Background Check', description: 'Complete background check clearance', required: true },
      { title: 'Educational Certificates', description: 'Verify driving school certificates', required: false },
    ],
    visa_application: [
      { title: 'Submit Visa Application', description: 'Complete visa application form and submit to embassy', required: true },
      { title: 'Biometric Data Collection', description: 'Schedule and complete biometric appointment', required: true },
      { title: 'Proof of Employment', description: 'Provide employment contract or job offer letter', required: true },
      { title: 'Financial Documents', description: 'Bank statements for last 3 months', required: false },
    ],
    work_permit: [
      { title: 'Work Permit Application', description: 'Submit work permit application to authorities', required: true },
      { title: 'Medical Certificate', description: 'Complete medical examination and obtain certificate', required: true },
      { title: 'Employer Sponsorship', description: 'Employer sponsorship documents verified', required: true },
    ],
    c95_training: [
      { title: 'Enroll in C95 Course', description: 'Register driver for C95 qualification training', required: true },
      { title: 'Complete Training Modules', description: '35 hours of professional training', required: true },
      { title: 'Pass C95 Examination', description: 'Successfully complete C95 qualification exam', required: true },
    ],
  };

  return requirements[stageId] || [
    { title: 'Stage Requirements', description: 'Complete all required tasks for this stage', required: true },
  ];
}