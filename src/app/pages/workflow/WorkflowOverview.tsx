import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import { Link, useNavigate } from 'react-router';
import { Clock, BarChart3, ChevronRight, ArrowLeft } from 'lucide-react';
import { employeeWorkflowApi } from '../../services/api';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';

export function WorkflowOverview() {
  const navigate = useNavigate();
  const { t } = useTranslation('pages');
  const tenantVersion = useTenantSyncVersion();
  const [stages, setStages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    employeeWorkflowApi.getOverview()
      .then((data: any) => setStages(Array.isArray(data) ? data : []))
      .catch(() => setStages([]))
      .finally(() => setLoading(false));
    // Phase 3 (#1 R-3) — refetch on SUPER tenant switch.
  }, [tenantVersion]);

  const totalStages = stages.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{t('workflow.overview.title')}</h1>
          </div>
          <p className="text-muted-foreground mt-1">{t('workflow.overview.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" asChild>
            <Link to="/dashboard/workflow/timeline">
              <Clock className="w-4 h-4 me-2" />
              Activity Timeline
            </Link>
          </Button>
          <Button asChild>
            <Link to="/dashboard/workflow/analytics">
              <BarChart3 className="w-4 h-4 me-2" />
              Analytics
            </Link>
          </Button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-5 h-36 bg-muted/30" />
            </Card>
          ))}
        </div>
      )}

      {/* Workflow - Grid Cards */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {stages.map((stage) => {
            const activeCount = stage.inProgress ?? 0;
            const completed = stage.completed ?? 0;
            const total = stage.total ?? 0;
            const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
            const stageColor = stage.color || '#2563EB';

            return (
              <Card key={stage.id} className="relative hover:shadow-md transition-shadow">
                <CardContent className="p-5">
                  {/* Count Badge */}
                  <div className="absolute top-4 end-4">
                    <Badge
                      className="rounded-full w-7 h-7 flex items-center justify-center p-0 text-white"
                      style={{ backgroundColor: stageColor }}
                    >
                      {activeCount}
                    </Badge>
                  </div>

                  {/* Stage Name */}
                  <h3 className="font-semibold text-[#0F172A] mb-4 pe-8">{stage.name}</h3>

                  {/* Progress */}
                  <div className="space-y-2 mb-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Progress</span>
                      <span className="font-medium">{progress}%</span>
                    </div>
                    <Progress value={progress} className="h-1.5" />
                  </div>

                  {/* Stage position + counts */}
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm text-muted-foreground">
                      Stage {stage.order} of {totalStages}
                    </p>
                    {total > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {completed}/{total} completed
                      </p>
                    )}
                  </div>

                  {/* View Details Link */}
                  <Link
                    to={`/dashboard/workflow/stage/${stage.id}`}
                    className="text-sm text-[#2563EB] hover:text-[#1d4ed8] flex items-center gap-1 font-medium"
                  >
                    View Details
                    <ChevronRight className="w-4 h-4" />
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {!loading && stages.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          No workflow stages configured yet.
        </div>
      )}
    </div>
  );
}
