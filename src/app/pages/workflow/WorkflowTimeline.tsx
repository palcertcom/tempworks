import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FileText, CheckCircle2, Clock, AlertTriangle, User, Calendar, ArrowRight, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';

interface TimelineEvent {
  id: string;
  type: 'stage_completed' | 'document_uploaded' | 'approval_granted' | 'delay' | 'note_added';
  title: string;
  description: string;
  driverId: string;
  driverName: string;
  timestamp: string;
  user: string;
  metadata?: Record<string, string>;
}

const mockTimelineEvents: TimelineEvent[] = [
  {
    id: 'E001',
    type: 'stage_completed',
    title: 'Document Verification Completed',
    description: 'All required documents verified and approved',
    driverId: 'D001',
    driverName: 'Jan Kowalski',
    timestamp: '2024-03-12 14:30',
    user: 'Sarah Johnson',
    metadata: { stage: 'Document Verification', duration: '3 days' }
  },
  {
    id: 'E002',
    type: 'document_uploaded',
    title: 'Work Permit Document Uploaded',
    description: 'Driver uploaded work permit application documents',
    driverId: 'D002',
    driverName: 'Ivan Petrov',
    timestamp: '2024-03-12 12:15',
    user: 'Ivan Petrov',
    metadata: { documentType: 'Work Permit Application' }
  },
  {
    id: 'E003',
    type: 'approval_granted',
    title: 'Visa Application Approved',
    description: 'Embassy approved visa application',
    driverId: 'D003',
    driverName: 'Gheorghe Popescu',
    timestamp: '2024-03-12 10:45',
    user: 'Embassy Processing',
    metadata: { visaType: 'Work Visa', validUntil: '2026-03-12' }
  },
  {
    id: 'E004',
    type: 'delay',
    title: 'Stage Delay Alert',
    description: 'Driver has been in Medical Exam stage for 12 days (SLA: 10 days)',
    driverId: 'D004',
    driverName: 'Andrei Ivanov',
    timestamp: '2024-03-12 09:20',
    user: 'System',
    metadata: { stage: 'Medical Exam', daysInStage: '12', slaThreshold: '10' }
  },
  {
    id: 'E005',
    type: 'note_added',
    title: 'Internal Note Added',
    description: 'Follow-up required with recruitment agency regarding missing documents',
    driverId: 'D005',
    driverName: 'Tomasz Nowak',
    timestamp: '2024-03-11 16:50',
    user: 'Michael Chen',
    metadata: { priority: 'High' }
  },
  {
    id: 'E006',
    type: 'stage_completed',
    title: 'C95 Training Completed',
    description: 'Driver successfully completed C95 qualification training',
    driverId: 'D006',
    driverName: 'Piotr Kowalczyk',
    timestamp: '2024-03-11 14:20',
    user: 'Training Center',
    metadata: { stage: 'C95 Training', certificateNumber: 'C95-2024-0045' }
  },
  {
    id: 'E007',
    type: 'document_uploaded',
    title: 'Medical Certificate Uploaded',
    description: 'Driver uploaded medical examination certificate',
    driverId: 'D007',
    driverName: 'Viktor Kovalenko',
    timestamp: '2024-03-11 11:30',
    user: 'Viktor Kovalenko',
    metadata: { documentType: 'Medical Certificate', validUntil: '2025-03-11' }
  },
  {
    id: 'E008',
    type: 'approval_granted',
    title: 'Work Permit Approved',
    description: 'Government authorities approved work permit application',
    driverId: 'D008',
    driverName: 'Alexandru Ionescu',
    timestamp: '2024-03-11 09:15',
    user: 'Labor Department',
    metadata: { permitNumber: 'WP-2024-8821', validUntil: '2026-03-11' }
  },
];

export function WorkflowTimeline() {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{t('workflow.timeline.activityTitle')}</h1>
          </div>
          <p className="text-muted-foreground mt-1">{t('workflow.timeline.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Input placeholder="Search timeline..." className="w-64" />
          <Button variant="outline">{t('workflow.timeline.filterByType')}</Button>
          <Button variant="outline">{t('workflow.timeline.filterByDate')}</Button>
        </div>
      </div>

      {/* Timeline Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="text-center">
              <p className="text-3xl font-semibold text-[#22C55E]">24</p>
              <p className="text-sm text-muted-foreground mt-1">{t('workflow.timeline.eventsToday')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-center">
              <p className="text-3xl font-semibold text-[#2563EB]">156</p>
              <p className="text-sm text-muted-foreground mt-1">{t('workflow.timeline.thisWeek')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-center">
              <p className="text-3xl font-semibold text-[#F59E0B]">3</p>
              <p className="text-sm text-muted-foreground mt-1">Delays</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-center">
              <p className="text-3xl font-semibold text-[#22C55E]">18</p>
              <p className="text-sm text-muted-foreground mt-1">{t('workflow.timeline.completedStages')}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute start-6 top-0 bottom-0 w-0.5 bg-[#E2E8F0]" />
            
            <div className="space-y-6">
              {mockTimelineEvents.map((event) => (
                <div key={event.id} className="relative flex gap-6">
                  {/* Timeline dot and icon */}
                  <div className="relative flex-shrink-0">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center z-10 ${
                      event.type === 'stage_completed' ? 'bg-[#F0FDF4]' :
                      event.type === 'approval_granted' ? 'bg-[#EFF6FF]' :
                      event.type === 'document_uploaded' ? 'bg-[#F8FAFC]' :
                      event.type === 'delay' ? 'bg-[#FEF3C7]' :
                      'bg-[#F8FAFC]'
                    }`}>
                      {event.type === 'stage_completed' && <CheckCircle2 className="w-6 h-6 text-[#22C55E]" />}
                      {event.type === 'approval_granted' && <CheckCircle2 className="w-6 h-6 text-[#2563EB]" />}
                      {event.type === 'document_uploaded' && <FileText className="w-6 h-6 text-[#64748B]" />}
                      {event.type === 'delay' && <AlertTriangle className="w-6 h-6 text-[#F59E0B]" />}
                      {event.type === 'note_added' && <User className="w-6 h-6 text-[#64748B]" />}
                    </div>
                  </div>

                  {/* Event content */}
                  <div className="flex-1 pb-6">
                    <div className="bg-white border rounded-lg p-4 hover:shadow-md transition-shadow">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold text-[#0F172A]">{event.title}</h3>
                            <Badge variant="outline" className={
                              event.type === 'stage_completed' ? 'bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]' :
                              event.type === 'approval_granted' ? 'bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]' :
                              event.type === 'delay' ? 'bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]' :
                              'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0]'
                            }>
                              {event.type.replace(/_/g, ' ')}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">{event.description}</p>
                        </div>
                        <Button size="sm" variant="ghost" asChild>
                          <Link to={`/dashboard/drivers/${event.driverId}`}>
                            View Driver
                            <ArrowRight className="w-4 h-4 ms-1" />
                          </Link>
                        </Button>
                      </div>

                      <div className="flex items-center gap-6 mt-3 pt-3 border-t text-sm text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4" />
                          <span>{event.driverName}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4" />
                          <span>{event.timestamp}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4" />
                          <span>By {event.user}</span>
                        </div>
                      </div>

                      {/* Metadata */}
                      {event.metadata && Object.keys(event.metadata).length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {Object.entries(event.metadata).map(([key, value]) => (
                            <div key={key} className="text-xs bg-[#F8FAFC] px-2 py-1 rounded">
                              <span className="text-muted-foreground">{key}: </span>
                              <span className="font-medium">{value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="text-center pt-6">
            <Button variant="outline">{t('workflow.timeline.loadMore')}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}