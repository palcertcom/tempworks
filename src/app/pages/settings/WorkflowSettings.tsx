import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { workflowStages } from '../../data/mockData';

export function WorkflowSettings() {
  const { t } = useTranslation('pages');
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/settings"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('settings.workflowConfiguration.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('settings.workflowConfiguration.subtitle')}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workflow Stages</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {workflowStages.map((stage, index) => (
              <div key={stage.id} className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-4">
                  <div className="w-8 h-8 rounded-full bg-[#EFF6FF] flex items-center justify-center font-medium text-[#2563EB]">
                    {stage.order}
                  </div>
                  <div>
                    <p className="font-medium">{stage.name}</p>
                    <p className="text-sm text-muted-foreground">Stage ID: {stage.id}</p>
                  </div>
                </div>
                <Badge variant="outline">Active</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}