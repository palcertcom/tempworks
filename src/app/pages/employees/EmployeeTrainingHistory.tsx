import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, GraduationCap, Calendar, Clock, Award, CheckCircle2, XCircle, Plus, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Progress } from '../../components/ui/progress';
import { mockDrivers } from '../../data/mockData';

interface TrainingCourse {
  id: string;
  title: string;
  category: string;
  provider: string;
  status: 'completed' | 'in_progress' | 'scheduled' | 'failed' | 'cancelled';
  startDate: string;
  endDate?: string;
  duration: string;
  location: string;
  instructor?: string;
  score?: number;
  certificateNumber?: string;
  certificateExpiry?: string;
  required: boolean;
  completionProgress?: number;
  nextSession?: string;
}

const mockTrainingHistory: TrainingCourse[] = [
  {
    id: 'TR001',
    title: 'C95 Professional Driver Qualification',
    category: 'Mandatory',
    provider: 'EU Transport Academy',
    status: 'completed',
    startDate: '2024-01-08',
    endDate: '2024-01-20',
    duration: '35 hours',
    location: 'Warsaw Training Center',
    instructor: 'Prof. Marek Nowicki',
    score: 92,
    certificateNumber: 'C95-2024-0045',
    certificateExpiry: '2029-01-20',
    required: true,
  },
  {
    id: 'TR002',
    title: 'ADR - Dangerous Goods Transport',
    category: 'Specialized',
    provider: 'Safety Training Institute',
    status: 'completed',
    startDate: '2023-11-05',
    endDate: '2023-11-12',
    duration: '24 hours',
    location: 'Krakow Safety Center',
    instructor: 'Anna Kowalska',
    score: 88,
    certificateNumber: 'ADR-PL-88921',
    certificateExpiry: '2025-03-10',
    required: false,
  },
  {
    id: 'TR003',
    title: 'Defensive Driving & Road Safety',
    category: 'Safety',
    provider: 'Road Safety Academy',
    status: 'completed',
    startDate: '2023-09-12',
    endDate: '2023-09-14',
    duration: '16 hours',
    location: 'Online',
    instructor: 'Jan Wisniewski',
    score: 95,
    required: true,
  },
  {
    id: 'TR004',
    title: 'Digital Tachograph Operation',
    category: 'Equipment',
    provider: 'Transport Technology Institute',
    status: 'completed',
    startDate: '2023-08-20',
    endDate: '2023-08-21',
    duration: '8 hours',
    location: 'Gdansk',
    instructor: 'Piotr Lewandowski',
    score: 90,
    required: true,
  },
  {
    id: 'TR005',
    title: 'First Aid for Professional Drivers',
    category: 'Safety',
    provider: 'Red Cross Poland',
    status: 'completed',
    startDate: '2023-06-15',
    endDate: '2023-06-16',
    duration: '12 hours',
    location: 'Warsaw',
    instructor: 'Dr. Maria Kaminska',
    score: 85,
    certificateNumber: 'FA-2023-5521',
    certificateExpiry: '2026-06-16',
    required: true,
  },
  {
    id: 'TR006',
    title: 'Fuel-Efficient Driving Techniques',
    category: 'Efficiency',
    provider: 'Eco-Drive Academy',
    status: 'in_progress',
    startDate: '2024-03-01',
    duration: '6 hours',
    location: 'Online',
    required: false,
    completionProgress: 65,
    nextSession: '2024-03-15',
  },
  {
    id: 'TR007',
    title: 'Customer Service for Transport',
    category: 'Soft Skills',
    provider: 'Service Excellence Ltd',
    status: 'scheduled',
    startDate: '2024-04-10',
    duration: '4 hours',
    location: 'Online',
    required: false,
  },
  {
    id: 'TR008',
    title: 'Winter Driving Conditions',
    category: 'Safety',
    provider: 'Nordic Driver Training',
    status: 'completed',
    startDate: '2022-11-20',
    endDate: '2022-11-22',
    duration: '18 hours',
    location: 'Stockholm',
    instructor: 'Lars Andersson',
    score: 78,
    required: false,
  },
];

export function EmployeeTrainingHistory() {
  const { t } = useTranslation('pages');
  const { id } = useParams();
  const driver = mockDrivers.find(d => d.id === id);
  
  if (!driver) {
    return <div>Driver not found</div>;
  }

  const completedCourses = mockTrainingHistory.filter(t => t.status === 'completed').length;
  const inProgressCourses = mockTrainingHistory.filter(t => t.status === 'in_progress').length;
  const totalHours = mockTrainingHistory
    .filter(t => t.status === 'completed')
    .reduce((sum, t) => sum + parseInt(t.duration), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/employees/${id}`}>
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('employees.training.title')}</h1>
          <p className="text-muted-foreground mt-1">{driver.firstName} {driver.lastName} • Complete training and course records</p>
        </div>
        <Button>
          <Plus className="w-4 h-4 me-2" />
          Enroll in Course
        </Button>
      </div>

      {/* Training Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{completedCourses}</p>
                <p className="text-sm text-muted-foreground">Completed</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Clock className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{inProgressCourses}</p>
                <p className="text-sm text-muted-foreground">{t('employees.training.inProgress')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#FEF3C7] flex items-center justify-center">
                <Calendar className="w-6 h-6 text-[#F59E0B]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{totalHours}h</p>
                <p className="text-sm text-muted-foreground">{t('employees.training.totalHours')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <Award className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">89%</p>
                <p className="text-sm text-muted-foreground">{t('employees.training.avgScore')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Current/Upcoming Courses */}
      {(mockTrainingHistory.filter(t => t.status === 'in_progress' || t.status === 'scheduled').length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Current & Upcoming Courses</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {mockTrainingHistory
                .filter(t => t.status === 'in_progress' || t.status === 'scheduled')
                .map((course) => (
                  <div key={course.id} className="border rounded-lg p-4 bg-[#F8FAFC]">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-start gap-3">
                        <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${
                          course.status === 'in_progress' ? 'bg-[#EFF6FF]' : 'bg-[#FEF3C7]'
                        }`}>
                          <GraduationCap className={`w-6 h-6 ${
                            course.status === 'in_progress' ? 'text-[#2563EB]' : 'text-[#F59E0B]'
                          }`} />
                        </div>
                        <div>
                          <h3 className="font-semibold text-[#0F172A]">{course.title}</h3>
                          <p className="text-sm text-muted-foreground">{course.provider}</p>
                          <div className="flex items-center gap-3 mt-2 text-sm">
                            <Badge variant="outline" className={
                              course.status === 'in_progress' 
                                ? 'bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]'
                                : 'bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]'
                            }>
                              {course.status.replace(/_/g, ' ')}
                            </Badge>
                            <span className="text-muted-foreground">{course.duration}</span>
                            <span className="text-muted-foreground">• {course.location}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {course.status === 'in_progress' && course.completionProgress && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-sm mb-2">
                          <span className="text-muted-foreground">Progress</span>
                          <span className="font-medium">{course.completionProgress}%</span>
                        </div>
                        <Progress value={course.completionProgress} className="h-2" />
                        {course.nextSession && (
                          <p className="text-xs text-muted-foreground mt-2">
                            Next session: {course.nextSession}
                          </p>
                        )}
                      </div>
                    )}

                    {course.status === 'scheduled' && (
                      <div className="flex items-center gap-2 mt-3 text-sm">
                        <Calendar className="w-4 h-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Starts on {course.startDate}</span>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Completed Training by Category */}
      {['Mandatory', 'Specialized', 'Safety', 'Equipment', 'Efficiency', 'Soft Skills'].map((category) => {
        const categoryCourses = mockTrainingHistory.filter(t => t.category === category && t.status === 'completed');
        if (categoryCourses.length === 0) return null;

        return (
          <Card key={category}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{category} Training</CardTitle>
                <Badge>{categoryCourses.length} courses</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {categoryCourses.map((course) => (
                  <div key={course.id} className="border rounded-lg p-4 hover:bg-[#F8FAFC] transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 flex-1">
                        <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center flex-shrink-0">
                          <CheckCircle2 className="w-6 h-6 text-[#22C55E]" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold text-[#0F172A]">{course.title}</h3>
                            {course.required && (
                              <Badge variant="outline" className="bg-[#FEE2E2] text-[#EF4444] border-[#EF4444] text-xs">
                                Required
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">{course.provider}</p>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm">
                            <div>
                              <p className="text-xs text-muted-foreground">Duration</p>
                              <p className="font-medium">{course.duration}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">Completed</p>
                              <p className="font-medium">{course.endDate}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">Location</p>
                              <p className="font-medium">{course.location}</p>
                            </div>
                            {course.instructor && (
                              <div>
                                <p className="text-xs text-muted-foreground">Instructor</p>
                                <p className="font-medium">{course.instructor}</p>
                              </div>
                            )}
                          </div>
                          {course.certificateNumber && (
                            <div className="mt-3 pt-3 border-t">
                              <div className="flex items-center gap-4 text-sm">
                                <div>
                                  <span className="text-muted-foreground">{t('employees.training.certificate')} </span>
                                  <span className="font-medium">{course.certificateNumber}</span>
                                </div>
                                {course.certificateExpiry && (
                                  <div>
                                    <span className="text-muted-foreground">{t('employees.training.expires')} </span>
                                    <span className="font-medium">{course.certificateExpiry}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2 ms-4">
                        {course.score && (
                          <div className="text-center">
                            <div className={`text-2xl font-semibold ${
                              course.score >= 90 ? 'text-[#22C55E]' :
                              course.score >= 75 ? 'text-[#2563EB]' :
                              course.score >= 60 ? 'text-[#F59E0B]' :
                              'text-[#EF4444]'
                            }`}>
                              {course.score}%
                            </div>
                            <p className="text-xs text-muted-foreground">Score</p>
                          </div>
                        )}
                        <Button size="sm" variant="outline">
                          <Download className="w-4 h-4 me-1" />
                          Certificate
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Training Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle>Recommended Training</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-4 border rounded-lg bg-[#F8FAFC]">
              <GraduationCap className="w-5 h-5 text-[#2563EB] mt-0.5" />
              <div className="flex-1">
                <p className="font-medium">{t('employees.training.advancedRouteTitle')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('employees.training.advancedRouteHelp')}</p>
                <Button size="sm" className="mt-2">{t('employees.training.enrollNow')}</Button>
              </div>
            </div>
            <div className="flex items-start gap-3 p-4 border rounded-lg bg-[#F8FAFC]">
              <GraduationCap className="w-5 h-5 text-[#2563EB] mt-0.5" />
              <div className="flex-1">
                <p className="font-medium">{t('employees.training.electricTruckTitle')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('employees.training.electricTruckHelp')}</p>
                <Button size="sm" className="mt-2">{t('employees.training.enrollNow')}</Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}