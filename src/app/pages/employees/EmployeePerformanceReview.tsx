import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Star, TrendingUp, TrendingDown, Award, AlertTriangle, ThumbsUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Progress } from '../../components/ui/progress';
import { mockDrivers } from '../../data/mockData';
import { RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, Legend, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

interface PerformanceReview {
  id: string;
  period: string;
  reviewDate: string;
  reviewer: string;
  overallRating: number;
  categories: {
    safety: number;
    punctuality: number;
    professionalism: number;
    vehicleCare: number;
    customerService: number;
    communication: number;
  };
  strengths: string[];
  improvements: string[];
  incidents: number;
  onTimeDelivery: number;
  feedback: string;
}

const mockPerformanceReviews: PerformanceReview[] = [
  {
    id: 'PR001',
    period: 'Q1 2024',
    reviewDate: '2024-03-30',
    reviewer: 'Michael Chen - Fleet Manager',
    overallRating: 4.5,
    categories: {
      safety: 5,
      punctuality: 4.5,
      professionalism: 4.5,
      vehicleCare: 4,
      customerService: 5,
      communication: 4.5,
    },
    strengths: [
      'Excellent safety record with zero incidents',
      'Outstanding customer feedback and service',
      'Consistently meets delivery deadlines',
      'Professional communication with dispatch',
    ],
    improvements: [
      'Vehicle pre-trip inspection documentation could be more detailed',
      'Consider fuel efficiency optimization training',
    ],
    incidents: 0,
    onTimeDelivery: 98,
    feedback: 'Jan continues to be one of our top-performing drivers. His safety record is exemplary and customer feedback is consistently positive. Would benefit from advanced fuel efficiency training to optimize costs.',
  },
  {
    id: 'PR002',
    period: 'Q4 2023',
    reviewDate: '2023-12-28',
    reviewer: 'Sarah Johnson - Operations Manager',
    overallRating: 4.3,
    categories: {
      safety: 5,
      punctuality: 4,
      professionalism: 4.5,
      vehicleCare: 4,
      customerService: 4.5,
      communication: 4,
    },
    strengths: [
      'Zero safety incidents throughout the quarter',
      'Excellent vehicle maintenance awareness',
      'Strong customer relationship building',
    ],
    improvements: [
      'Improve response time to dispatch communications',
      'More proactive route planning during peak seasons',
    ],
    incidents: 0,
    onTimeDelivery: 95,
    feedback: 'Solid performance with room for improvement in communication responsiveness. Jan demonstrates excellent safety awareness and customer service skills.',
  },
  {
    id: 'PR003',
    period: 'Q3 2023',
    reviewDate: '2023-09-29',
    reviewer: 'Michael Chen - Fleet Manager',
    overallRating: 4.6,
    categories: {
      safety: 5,
      punctuality: 4.5,
      professionalism: 5,
      vehicleCare: 4.5,
      customerService: 4.5,
      communication: 4.5,
    },
    strengths: [
      'Perfect safety record',
      'Exceptional professionalism and work ethic',
      'Proactive vehicle maintenance reporting',
    ],
    improvements: [
      'Continue current performance standards',
    ],
    incidents: 0,
    onTimeDelivery: 97,
    feedback: 'Outstanding quarter with exceptional performance across all metrics. Jan is a model driver and sets the standard for the team.',
  },
];

const performanceMetricsData = [
  {
    subject: 'Safety',
    current: mockPerformanceReviews[0].categories.safety,
    previous: mockPerformanceReviews[1].categories.safety,
    fullMark: 5,
  },
  {
    subject: 'Punctuality',
    current: mockPerformanceReviews[0].categories.punctuality,
    previous: mockPerformanceReviews[1].categories.punctuality,
    fullMark: 5,
  },
  {
    subject: 'Professionalism',
    current: mockPerformanceReviews[0].categories.professionalism,
    previous: mockPerformanceReviews[1].categories.professionalism,
    fullMark: 5,
  },
  {
    subject: 'Vehicle Care',
    current: mockPerformanceReviews[0].categories.vehicleCare,
    previous: mockPerformanceReviews[1].categories.vehicleCare,
    fullMark: 5,
  },
  {
    subject: 'Customer Service',
    current: mockPerformanceReviews[0].categories.customerService,
    previous: mockPerformanceReviews[1].categories.customerService,
    fullMark: 5,
  },
  {
    subject: 'Communication',
    current: mockPerformanceReviews[0].categories.communication,
    previous: mockPerformanceReviews[1].categories.communication,
    fullMark: 5,
  },
];

const ratingTrendData = mockPerformanceReviews.reverse().map(review => ({
  period: review.period,
  rating: review.overallRating,
  onTime: review.onTimeDelivery,
}));

export function EmployeePerformanceReview() {
  const { t } = useTranslation('pages');
  const { id } = useParams();
  const driver = mockDrivers.find(d => d.id === id);
  
  if (!driver) {
    return <div>Driver not found</div>;
  }

  const latestReview = mockPerformanceReviews[0];
  const avgRating = (mockPerformanceReviews.reduce((sum, r) => sum + r.overallRating, 0) / mockPerformanceReviews.length).toFixed(1);
  const totalIncidents = mockPerformanceReviews.reduce((sum, r) => sum + r.incidents, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/employees/${id}`}>
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('employees.performance.performanceReviewsTitle')}</h1>
          <p className="text-muted-foreground mt-1">{driver.firstName} {driver.lastName} • Comprehensive performance evaluations and ratings</p>
        </div>
        <Button>Schedule Review</Button>
      </div>

      {/* Performance Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#FEF3C7] flex items-center justify-center">
                <Star className="w-6 h-6 text-[#F59E0B]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{latestReview.overallRating}</p>
                <p className="text-sm text-muted-foreground">{t('employees.performance.latestRating')}</p>
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
                <p className="text-2xl font-semibold">{avgRating}</p>
                <p className="text-sm text-muted-foreground">{t('employees.performance.avgRating')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <ThumbsUp className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{latestReview.onTimeDelivery}%</p>
                <p className="text-sm text-muted-foreground">{t('employees.performance.onTimeRate')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{totalIncidents}</p>
                <p className="text-sm text-muted-foreground">{t('employees.performance.totalIncidents')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Performance Radar Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Performance Categories</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{t('employees.performance.comparisonHelp')}</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={350}>
              <RadarChart data={performanceMetricsData}>
                <PolarGrid stroke="#E2E8F0" />
                <PolarAngleAxis dataKey="subject" tick={{ fill: '#64748B', fontSize: 12 }} />
                <PolarRadiusAxis angle={90} domain={[0, 5]} tick={{ fill: '#64748B' }} />
                <Radar key="radar-current" name="Current Quarter" dataKey="current" stroke="#2563EB" fill="#2563EB" fillOpacity={0.5} />
                <Radar key="radar-previous" name="Previous Quarter" dataKey="previous" stroke="#94A3B8" fill="#94A3B8" fillOpacity={0.3} />
                <Legend />
              </RadarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Rating Trend */}
        <Card>
          <CardHeader>
            <CardTitle>Performance Trend</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{t('employees.performance.trendHelp')}</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={ratingTrendData}>
                <CartesianGrid key="grid" strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis key="xaxis" dataKey="period" stroke="#64748B" />
                <YAxis key="yaxis" domain={[0, 5]} stroke="#64748B" />
                <Tooltip key="tooltip" />
                <Legend key="legend" />
                <Bar key="bar-rating" dataKey="rating" name="Overall Rating" fill="#2563EB" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Latest Review Details */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Latest Performance Review - {latestReview.period}</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">Reviewed on {latestReview.reviewDate} by {latestReview.reviewer}</p>
            </div>
            <div className="text-end">
              <div className="flex items-center gap-2">
                <Star className="w-6 h-6 text-[#F59E0B] fill-[#F59E0B]" />
                <span className="text-3xl font-semibold">{latestReview.overallRating}</span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Category Ratings */}
          <div>
            <h3 className="font-semibold mb-4">{t('employees.performance.categoryRatings')}</h3>
            <div className="space-y-3">
              {Object.entries(latestReview.categories).map(([category, rating]) => (
                <div key={category}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium capitalize">{category.replace(/([A-Z])/g, ' $1').trim()}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{rating}/5</span>
                      {rating >= 4.5 && <TrendingUp className="w-4 h-4 text-[#22C55E]" />}
                    </div>
                  </div>
                  <Progress value={(rating / 5) * 100} className="h-2" />
                </div>
              ))}
            </div>
          </div>

          {/* Strengths */}
          <div>
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <ThumbsUp className="w-5 h-5 text-[#22C55E]" />
              Strengths
            </h3>
            <div className="space-y-2">
              {latestReview.strengths.map((strength, index) => (
                <div key={index} className="flex items-start gap-2 text-sm bg-[#F0FDF4] p-3 rounded-lg border border-[#22C55E]">
                  <span className="text-[#22C55E] font-medium">✓</span>
                  <span>{strength}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Areas for Improvement */}
          <div>
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-[#F59E0B]" />
              Areas for Improvement
            </h3>
            <div className="space-y-2">
              {latestReview.improvements.map((improvement, index) => (
                <div key={index} className="flex items-start gap-2 text-sm bg-[#FEF3C7] p-3 rounded-lg border border-[#F59E0B]">
                  <span className="text-[#F59E0B] font-medium">→</span>
                  <span>{improvement}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Reviewer Feedback */}
          <div>
            <h3 className="font-semibold mb-3">{t('employees.performance.reviewerFeedback')}</h3>
            <div className="bg-[#F8FAFC] p-4 rounded-lg border">
              <p className="text-sm leading-relaxed">{latestReview.feedback}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Historical Reviews */}
      <Card>
        <CardHeader>
          <CardTitle>Historical Reviews</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {mockPerformanceReviews.slice(1).map((review) => (
              <div key={review.id} className="border rounded-lg p-4 hover:bg-[#F8FAFC] transition-colors">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold">{review.period}</h3>
                      <Badge variant="outline">{review.reviewDate}</Badge>
                      <div className="flex items-center gap-1">
                        <Star className="w-4 h-4 text-[#F59E0B] fill-[#F59E0B]" />
                        <span className="font-semibold">{review.overallRating}</span>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">Reviewed by {review.reviewer}</p>
                    <p className="text-sm">{review.feedback}</p>
                    
                    <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t">
                      <div>
                        <p className="text-xs text-muted-foreground">{t('employees.performance.safetyRating')}</p>
                        <p className="font-semibold">{review.categories.safety}/5</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('employees.performance.onTimeDelivery')}</p>
                        <p className="font-semibold">{review.onTimeDelivery}%</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Incidents</p>
                        <p className="font-semibold">{review.incidents}</p>
                      </div>
                    </div>
                  </div>
                  <Button size="sm" variant="outline">{t('employees.performance.viewFullReview')}</Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}