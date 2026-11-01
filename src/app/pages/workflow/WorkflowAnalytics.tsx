import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Download, TrendingUp, TrendingDown, AlertCircle, Clock, ArrowLeft } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { usePermissions } from '../../hooks/usePermissions';

const stagePerformanceData = [
  { stage: 'Application', avgDays: 2, sla: 3, drivers: 12 },
  { stage: 'Doc Verify', avgDays: 5, sla: 5, drivers: 18 },
  { stage: 'Work Permit', avgDays: 15, sla: 14, drivers: 8 },
  { stage: 'Visa App', avgDays: 12, sla: 10, drivers: 15 },
  { stage: 'Embassy', avgDays: 8, sla: 7, drivers: 6 },
  { stage: 'Medical', avgDays: 4, sla: 5, drivers: 10 },
  { stage: 'C95', avgDays: 21, sla: 21, drivers: 7 },
  { stage: 'Contract', avgDays: 3, sla: 3, drivers: 5 },
];

const monthlyTrendData = [
  { month: 'Sep', started: 45, completed: 38, inProgress: 67 },
  { month: 'Oct', started: 52, completed: 42, inProgress: 77 },
  { month: 'Nov', started: 48, completed: 45, inProgress: 80 },
  { month: 'Dec', started: 38, completed: 40, inProgress: 78 },
  { month: 'Jan', started: 55, completed: 48, inProgress: 85 },
  { month: 'Feb', started: 62, completed: 52, inProgress: 95 },
  { month: 'Mar', started: 41, completed: 35, inProgress: 101 },
];

const bottleneckData = [
  { name: 'Work Permit', value: 35, color: '#EF4444' },
  { name: 'Visa Processing', value: 28, color: '#F59E0B' },
  { name: 'C95 Training', value: 20, color: '#F59E0B' },
  { name: 'Medical Exam', value: 10, color: '#22C55E' },
  { name: 'Others', value: 7, color: '#22C55E' },
];

const conversionFunnelData = [
  { stage: 'Applications', count: 420, percentage: 100 },
  { stage: 'Docs Verified', count: 385, percentage: 92 },
  { stage: 'Work Permits', count: 312, percentage: 74 },
  { stage: 'Visas Approved', count: 268, percentage: 64 },
  { stage: 'Completed', count: 215, percentage: 51 },
];

export function WorkflowAnalytics() {
  const { t } = useTranslation('pages');
  const { canEdit } = usePermissions();
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{t('workflow.analytics.title')}</h1>
          </div>
          <p className="text-muted-foreground mt-1">{t('workflow.analytics.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline">{t('workflow.analytics.periodLast30')}</Button>
          {canEdit('reports') && (
            <Button>
              <Download className="w-4 h-4 me-2" />
              {t('workflow.analytics.exportReport')}
            </Button>
          )}
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t('workflow.analytics.avgTimeLabel')}</p>
                <p className="text-3xl font-semibold text-[#0F172A] mt-1">{t('workflow.analytics.avgTimeValue')}</p>
                <div className="flex items-center gap-1 mt-2">
                  <TrendingDown className="w-4 h-4 text-[#22C55E]" />
                  <span className="text-sm text-[#22C55E]">{t('workflow.analytics.avgTimeTrend')}</span>
                </div>
              </div>
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Clock className="w-6 h-6 text-[#2563EB]" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t('workflow.analytics.completionRateLabel')}</p>
                <p className="text-3xl font-semibold text-[#0F172A] mt-1">{t('workflow.analytics.completionRateValue')}</p>
                <div className="flex items-center gap-1 mt-2">
                  <TrendingUp className="w-4 h-4 text-[#22C55E]" />
                  <span className="text-sm text-[#22C55E]">{t('workflow.analytics.completionRateTrend')}</span>
                </div>
              </div>
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-[#22C55E]" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t('workflow.analytics.slaBreachesLabel')}</p>
                <p className="text-3xl font-semibold text-[#0F172A] mt-1">{t('workflow.analytics.slaBreachesValue')}</p>
                <div className="flex items-center gap-1 mt-2">
                  <TrendingUp className="w-4 h-4 text-[#EF4444]" />
                  <span className="text-sm text-[#EF4444]">{t('workflow.analytics.slaBreachesTrend')}</span>
                </div>
              </div>
              <div className="w-12 h-12 rounded-lg bg-[#FEE2E2] flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-[#EF4444]" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t('workflow.analytics.activeInWorkflow')}</p>
                <p className="text-3xl font-semibold text-[#0F172A] mt-1">{t('workflow.analytics.activeValue')}</p>
                <div className="flex items-center gap-1 mt-2">
                  <TrendingUp className="w-4 h-4 text-[#2563EB]" />
                  <span className="text-sm text-[#2563EB]">{t('workflow.analytics.activeTrend')}</span>
                </div>
              </div>
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-[#2563EB]" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Stage Performance */}
      <Card>
        <CardHeader>
          <CardTitle>{t('workflow.analytics.stageVsSlaCardTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">{t('workflow.analytics.stageVsSlaTitle')}</p>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={stagePerformanceData}>
              <CartesianGrid key="grid" strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis key="xaxis" dataKey="stage" stroke="#64748B" />
              <YAxis key="yaxis" stroke="#64748B" label={{ value: 'Days', angle: -90, position: 'insideLeft' }} />
              <Tooltip key="tooltip" />
              <Legend key="legend" />
              <Bar key="bar-avgDays" dataKey="avgDays" name="Avg Days" fill="#2563EB" radius={[4, 4, 0, 0]} />
              <Bar key="bar-sla" dataKey="sla" name="SLA Threshold" fill="#22C55E" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly Trends */}
        <Card>
          <CardHeader>
            <CardTitle>{t('workflow.analytics.monthlyTrendCardTitle')}</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{t('workflow.analytics.monthlyTrendTitle')}</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={monthlyTrendData}>
                <CartesianGrid key="grid-line" strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis key="xaxis-line" dataKey="month" stroke="#64748B" />
                <YAxis key="yaxis-line" stroke="#64748B" />
                <Tooltip key="tooltip-line" />
                <Legend key="legend-line" />
                <Line key="line-started" type="monotone" dataKey="started" name="Started" stroke="#2563EB" strokeWidth={2} dot={{ r: 4 }} />
                <Line key="line-completed" type="monotone" dataKey="completed" name="Completed" stroke="#22C55E" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Bottleneck Analysis */}
        <Card>
          <CardHeader>
            <CardTitle>{t('workflow.analytics.bottleneckCardTitle')}</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{t('workflow.analytics.bottleneckTitle')}</p>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center">
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={bottleneckData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percentage }) => `${name}: ${percentage}%`}
                    outerRadius={100}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {bottleneckData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-4">
              {bottleneckData.map((item) => (
                <div key={item.name} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-sm">{item.name}</span>
                  <Badge variant="outline" className="ms-auto">{item.value}%</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Conversion Funnel */}
      <Card>
        <CardHeader>
          <CardTitle>{t('workflow.analytics.dropOffCardTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">{t('workflow.analytics.dropOffTitle')}</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {conversionFunnelData.map((item, index) => (
              <div key={item.stage}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-semibold ${
                      item.percentage >= 80 ? 'bg-[#22C55E]' :
                      item.percentage >= 60 ? 'bg-[#2563EB]' :
                      item.percentage >= 40 ? 'bg-[#F59E0B]' :
                      'bg-[#EF4444]'
                    }`}>
                      {index + 1}
                    </div>
                    <div>
                      <p className="font-medium">{item.stage}</p>
                      <p className="text-sm text-muted-foreground">{item.count} drivers</p>
                    </div>
                  </div>
                  <div className="text-end">
                    <p className="text-2xl font-semibold">{item.percentage}%</p>
                    {index > 0 && (
                      <p className="text-xs text-muted-foreground">
                        -{conversionFunnelData[index - 1].percentage - item.percentage}% drop
                      </p>
                    )}
                  </div>
                </div>
                <div className="relative h-2 bg-[#F1F5F9] rounded-full overflow-hidden">
                  <div 
                    className={`absolute top-0 start-0 h-full rounded-full ${
                      item.percentage >= 80 ? 'bg-[#22C55E]' :
                      item.percentage >= 60 ? 'bg-[#2563EB]' :
                      item.percentage >= 40 ? 'bg-[#F59E0B]' :
                      'bg-[#EF4444]'
                    }`}
                    style={{ width: `${item.percentage}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle>{t('workflow.analytics.insightsCardTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-4 bg-[#FEF3C7] border border-[#F59E0B] rounded-lg">
              <AlertCircle className="w-5 h-5 text-[#F59E0B] mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-[#0F172A]">{t('workflow.analytics.insight1Title')}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Work permit stage is 7% over SLA. Consider increasing staff or outsourcing to specialized agencies.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-4 bg-[#EFF6FF] border border-[#2563EB] rounded-lg">
              <TrendingUp className="w-5 h-5 text-[#2563EB] mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-[#0F172A]">{t('workflow.analytics.insight2Title')}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Document verification time decreased by 15% this month. Great work from the verification team!
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-4 bg-[#FEE2E2] border border-[#EF4444] rounded-lg">
              <AlertCircle className="w-5 h-5 text-[#EF4444] mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-[#0F172A]">{t('workflow.analytics.insight3Title')}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  26% of applications don't proceed past visa approval. Review rejection reasons and improve application quality.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}