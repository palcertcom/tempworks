import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { mockNotifications } from '../../data/mockData';
import { usePermissions } from '../../hooks/usePermissions';

export function ComplianceAlerts() {
  const { canEdit } = usePermissions();
  const navigate = useNavigate();
  const { t } = useTranslation('pages');

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('compliance.alerts.title')}</h1>
        </div>
        <p className="text-muted-foreground mt-1">{t('compliance.alerts.subtitle', { defaultValue: '' })}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('compliance.alerts.active')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {mockNotifications.map((notification) => (
              <div key={notification.id} className="flex items-start gap-4 p-4 rounded-lg border">
                <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${
                  notification.type === 'warning' ? 'bg-[#F59E0B]' :
                  notification.type === 'success' ? 'bg-[#22C55E]' :
                  notification.type === 'error' ? 'bg-[#EF4444]' :
                  'bg-[#2563EB]'
                }`} />
                <div className="flex-1">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-medium">{notification.title}</p>
                      <p className="text-sm text-muted-foreground mt-1">{notification.message}</p>
                      <p className="text-xs text-muted-foreground mt-2">{notification.timestamp}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={notification.read ? 'secondary' : 'default'}>
                        {notification.read ? 'Read' : 'Unread'}
                      </Badge>
                      {canEdit('compliance') && !notification.read && (
                        <Button size="sm" variant="outline">
                          Resolve
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
