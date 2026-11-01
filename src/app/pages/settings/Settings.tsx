import { Link } from 'react-router';
import { FileType, Bell, Shield, Activity, Layers, Briefcase, Palette, Trash2, Database, Server, Building2, Star, Truck, Tag, GitBranch, DollarSign } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuthContext } from '../../contexts/AuthContext';
import { API_URL, getCurrentUser, settingsApi } from '../../services/api';
import { toast } from 'sonner';
import { apiError } from '../../../i18n/apiError';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';

interface SystemInfo {
  version: string;
  organizationName: string;
  lastUpdated: string;
}

interface SystemStats {
  totalUsers: number;
  databaseStatus: string;
}

export function Settings() {
  const { t } = useTranslation('pages');
  // settings:update is the gate for admin-only configuration cards
  // (branding, skills, truck brands, database backup/cleanup, …).
  // System Admins pass via the usePermissions isAdmin bypass so the
  // legacy behaviour is preserved, and any role explicitly granted
  // `settings:update` via the Roles UI now also unlocks these cards.
  //
  // Fall back to the cached user from localStorage when AuthContext
  // hasn't populated yet — the Sidebar uses the same pattern so the
  // admin-only cards stay visible right after a hard reload instead of
  // briefly disappearing while /auth/me is in-flight.
  const { canView, canEdit } = usePermissions();
  const { user: ctxUser } = useAuthContext();
  const cachedUser = ctxUser ?? getCurrentUser();
  const cachedRole = typeof cachedUser?.role === 'string'
    ? cachedUser.role
    : ((cachedUser?.role as any)?.name ?? '');
  const isCachedAdmin = cachedRole.trim().toLowerCase() === 'system admin';
  const canEditSettings = canEdit('settings') || isCachedAdmin;
  // Hard guard — the sidebar already hides Settings from roles without
  // settings:read, but the route was reachable by URL. Stop rendering
  // anything below if the user holds neither settings:read nor the
  // System Admin role.
  const canReadSettings = canView('settings') || isCachedAdmin;

  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  // Log Retention — load the persisted value on mount; default to 90 days.
  // Backend stores it as a SystemSetting under key `logs.retentionDays`.
  const [logRetention, setLogRetention] = useState<string>('90');
  const [savingLogRetention, setSavingLogRetention] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('access_token') ?? '';
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch(`${API_URL}/settings/system-info`, { headers }).then((r) => r.json()).catch(() => null),
      fetch(`${API_URL}/settings/system-stats`, { headers }).then((r) => r.json()).catch(() => null),
    ]).then(([info, stats]) => {
      if (info) setSystemInfo(info);
      if (stats) setSystemStats(stats);
    });

    // Load the persisted log-retention setting separately so a system-info
    // failure can't take it down with it. Mirrors the SecuritySettings
    // pattern (Object.values(grouped).flat() find by key) which is the
    // shape settingsApi.getAll() actually returns.
    settingsApi.getAll(true)
      .then((grouped: any) => {
        const rows: any[] = grouped && typeof grouped === 'object'
          ? Object.values(grouped as Record<string, any[]>).flat()
          : [];
        const row = rows.find((r) => r?.key === 'logs.retentionDays');
        if (row?.value != null) setLogRetention(String(row.value));
      })
      .catch((err) => {
        // Surface the failure so the operator can see what's happening
        // when the dropdown refuses to remember its value.
        // eslint-disable-next-line no-console
        console.warn('[settings] Could not load log retention:', err);
      });
  }, []);

  const handleSaveLogRetention = async () => {
    setSavingLogRetention(true);
    try {
      await settingsApi.update({ 'logs.retentionDays': logRetention });
      toast.success(t('settings.index.logRetention.savedToast', { defaultValue: 'Log retention updated' }));
    } catch (err) {
      toast.error(apiError(err, t('settings.index.logRetention.saveFailed', { defaultValue: 'Could not save log retention' })));
    } finally {
      setSavingLogRetention(false);
    }
  };

  const settingsCategories = [
    {
      icon: Briefcase,
      title: t('settings.index.cards.jobCategoriesTitle'),
      description: t('settings.index.cards.jobCategoriesDesc'),
      path: '/dashboard/settings/job-types',
      badge: t('settings.index.cards.newBadge'),
    },
    {
      icon: FileType,
      title: t('settings.index.cards.documentTypesTitle'),
      description: t('settings.index.cards.documentTypesDesc'),
      path: '/dashboard/settings/document-types',
    },
    {
      icon: DollarSign,
      title: t('settings.index.cards.transactionTypesTitle'),
      description: t('settings.index.cards.transactionTypesDesc'),
      path: '/dashboard/settings/transaction-types',
    },
    {
      icon: Briefcase,
      title: t('settings.index.cards.workHistoryTitle'),
      description: t('settings.index.cards.workHistoryDesc'),
      path: '/dashboard/settings/work-history-event-types',
    },
    {
      icon: Bell,
      title: t('settings.index.cards.notificationRulesTitle'),
      description: t('settings.index.cards.notificationRulesDesc'),
      path: '/dashboard/settings/notifications',
    },
    {
      icon: Shield,
      title: t('settings.index.cards.securitySettingsTitle'),
      description: t('settings.index.cards.securitySettingsDesc'),
      path: '/dashboard/settings/security',
    },
  ];

  if (!canReadSettings) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        {t('settings.index.noAccess', { defaultValue: "You don't have permission to view Settings." })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-foreground">{t('settings.index.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('settings.index.subtitle')}</p>
      </div>

      {/* Settings Menu */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Appearance – always first */}
        <Link to="/dashboard/settings/color-scheme">
          <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
            <CardHeader>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Palette className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <CardTitle>{t('settings.index.cards.appearanceTitle')}</CardTitle>
                    <Badge className="bg-primary text-primary-foreground">{t('settings.index.cards.appearanceBadge')}</Badge>
                  </div>
                  <CardDescription>{t('settings.index.cards.appearanceDesc')}</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
        </Link>

        <Link to="/dashboard/workflows">
          <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
            <CardHeader>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                  <Layers className="w-6 h-6 text-[#2563EB]" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <CardTitle>{t('settings.index.cards.manageWorkflowsTitle')}</CardTitle>
                    <Badge className="bg-[#EF4444]">{t('settings.index.cards.adminOnlyBadge')}</Badge>
                  </div>
                  <CardDescription>{t('settings.index.cards.manageWorkflowsDesc')}</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
        </Link>

        {settingsCategories.map((category) => {
          const Icon = category.icon;
          return (
            <Link key={category.path} to={category.path}>
              <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
                <CardHeader>
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                      <Icon className="w-6 h-6 text-[#2563EB]" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <CardTitle>{category.title}</CardTitle>
                        {category.badge && (
                          <Badge className="bg-[#22C55E]">{category.badge}</Badge>
                        )}
                      </div>
                      <CardDescription>{category.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          );
        })}

        {/* Company Branding — System Admin only */}
        {canEditSettings && (
          <Link to="/dashboard/settings/branding">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-indigo-200 hover:border-indigo-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-indigo-100 flex items-center justify-center">
                    <Building2 className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-indigo-800">{t('settings.index.cards.brandingTitle')}</CardTitle>
                      <Badge className="bg-[#EF4444]">{t('settings.index.cards.adminOnlyBadge')}</Badge>
                    </div>
                    <CardDescription>{t('settings.index.cards.brandingDesc')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* Company Export Profiles — header info shown on exported timesheets */}
        {canEditSettings && (
          <Link to="/dashboard/settings/company-profiles">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-emerald-200 hover:border-emerald-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-emerald-100 flex items-center justify-center">
                    <Building2 className="w-6 h-6 text-emerald-600" />
                  </div>
                  <div className="flex-1">
                    <CardTitle className="text-emerald-800">Company Export Profiles</CardTitle>
                    <CardDescription>
                      Manage the company-details blocks (name, address, VAT, contact) shown in the header of exported Excel timesheets.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* Skills List */}
        {canEditSettings && (
          <Link to="/dashboard/settings/skills">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-amber-200 hover:border-amber-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-amber-100 flex items-center justify-center">
                    <Star className="w-6 h-6 text-amber-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-amber-800">{t('settings.index.cards.skillsTitle')}</CardTitle>
                      <Badge className="bg-[#EF4444]">{t('settings.index.cards.adminOnlyBadge')}</Badge>
                    </div>
                    <CardDescription>{t('settings.index.cards.skillsDesc')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* Transport Types */}
        {canEditSettings && (
          <Link to="/dashboard/settings/transport-types">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-blue-200 hover:border-blue-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center">
                    <GitBranch className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-blue-800">{t('settings.index.cards.transportTypesTitle')}</CardTitle>
                      <Badge className="bg-[#EF4444]">{t('settings.index.cards.adminOnlyBadge')}</Badge>
                    </div>
                    <CardDescription>{t('settings.index.cards.transportTypesDesc')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* Truck Brands */}
        {canEditSettings && (
          <Link to="/dashboard/settings/truck-brands">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-blue-200 hover:border-blue-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Truck className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-blue-800">{t('settings.index.cards.truckBrandsTitle')}</CardTitle>
                      <Badge className="bg-[#EF4444]">{t('settings.index.cards.adminOnlyBadge')}</Badge>
                    </div>
                    <CardDescription>{t('settings.index.cards.truckBrandsDesc')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* Trailer Types */}
        {canEditSettings && (
          <Link to="/dashboard/settings/trailer-types">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-blue-200 hover:border-blue-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Tag className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-blue-800">{t('settings.index.cards.trailerTypesTitle')}</CardTitle>
                      <Badge className="bg-[#EF4444]">{t('settings.index.cards.adminOnlyBadge')}</Badge>
                    </div>
                    <CardDescription>{t('settings.index.cards.trailerTypesDesc')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* Vehicle Settings — central hub for every vehicle-form lookup list and maintenance types */}
        {canEditSettings && (
          <Link to="/dashboard/settings/vehicles">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-blue-200 hover:border-blue-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Truck className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-blue-800">{t('settings.index.cards.vehicleSettingsTitle')}</CardTitle>
                      <Badge className="bg-[#EF4444]">{t('settings.index.cards.adminOnlyBadge')}</Badge>
                    </div>
                    <CardDescription>
                      {t('settings.index.cards.vehicleSettingsDesc')}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* Database Backup & Restore — System Admin only */}
        {canEditSettings && (
          <Link to="/dashboard/settings/database-backup">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-blue-200 hover:border-blue-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Database className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-blue-800">{t('settings.index.cards.databaseBackupTitle')}</CardTitle>
                      <Badge className="bg-blue-600">{t('settings.index.cards.databaseBackupAdminBadge')}</Badge>
                    </div>
                    <CardDescription>{t('settings.index.cards.databaseBackupDesc')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* System Information — System Admin only */}
        {canEditSettings && (
          <Link to="/dashboard/settings/system-information">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-slate-200 hover:border-slate-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center">
                    <Server className="w-6 h-6 text-slate-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-slate-800">{t('settings.index.cards.systemInformationTitle')}</CardTitle>
                      <Badge className="bg-[#EF4444]">{t('settings.index.cards.adminOnlyBadge')}</Badge>
                    </div>
                    <CardDescription>{t('settings.index.cards.systemInformationDesc')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}

        {/* Database Cleanup — System Admin only */}
        {canEditSettings && (
          <Link to="/dashboard/settings/database-cleanup">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full border-red-200 hover:border-red-400">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-red-100 flex items-center justify-center">
                    <Trash2 className="w-6 h-6 text-red-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-red-800">{t('settings.index.cards.databaseCleanupTitle')}</CardTitle>
                      <Badge className="bg-red-600">{t('settings.index.cards.dangerZoneBadge')}</Badge>
                    </div>
                    <CardDescription>{t('settings.index.cards.databaseCleanupDesc')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        )}
      </div>

      {/* Log Retention Policy */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
              <Activity className="w-5 h-5 text-[#22C55E]" />
            </div>
            <div>
              <CardTitle>{t('settings.index.logRetention.cardTitle')}</CardTitle>
              <CardDescription>{t('settings.index.logRetention.cardDesc')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <Label htmlFor="logRetention">{t('settings.index.logRetention.periodLabel')}</Label>
            <p className="text-sm text-muted-foreground mt-1 mb-3">
              {t('settings.index.logRetention.periodHelper')}
            </p>
            <Select value={logRetention} onValueChange={setLogRetention} disabled={!canEditSettings || savingLogRetention}>
              <SelectTrigger id="logRetention" className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">{t('settings.index.logRetention.days30')}</SelectItem>
                <SelectItem value="90">{t('settings.index.logRetention.days90')}</SelectItem>
                <SelectItem value="180">{t('settings.index.logRetention.days180')}</SelectItem>
                <SelectItem value="365">{t('settings.index.logRetention.days365')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end pt-4 border-t">
            <Button onClick={handleSaveLogRetention} disabled={!canEditSettings || savingLogRetention}>
              {savingLogRetention ? t('actions.saving', { ns: 'common', defaultValue: 'Saving…' }) : t('settings.index.logRetention.saveButton')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
                <Server className="w-5 h-5 text-slate-600" />
              </div>
              <div>
                <CardTitle>{t('settings.index.sysInfoCard.cardTitle')}</CardTitle>
                <CardDescription>
                  {systemInfo?.organizationName ? systemInfo.organizationName : t('settings.index.sysInfoCard.cardDescFallback')}
                </CardDescription>
              </div>
            </div>
            {canEditSettings && (
              <Link to="/dashboard/settings/system-information">
                <Button variant="outline" size="sm">{t('settings.index.sysInfoCard.editButton')}</Button>
              </Link>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">{t('settings.index.sysInfoCard.systemVersion')}</p>
              <p className="font-medium mt-1">{systemInfo?.version || t('settings.index.sysInfoCard.notSet')}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('settings.index.sysInfoCard.lastUpdated')}</p>
              <p className="font-medium mt-1">{systemInfo?.lastUpdated || t('settings.index.sysInfoCard.notSet')}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('settings.index.sysInfoCard.databaseStatus')}</p>
              <p className="font-medium mt-1 text-[#22C55E]">{systemStats?.databaseStatus ?? '…'}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('settings.index.sysInfoCard.totalUsers')}</p>
              <p className="font-medium mt-1">{systemStats?.totalUsers ?? '…'}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
