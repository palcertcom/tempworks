import { Link, Navigate } from 'react-router';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Users, FileCheck, Clock, AlertTriangle, TrendingUp,
  CheckCircle2, ArrowUp, ArrowDown, Minus, Activity,
  FileX, Zap, BarChart3, UserPlus, RefreshCw, ChevronRight,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Progress } from '../components/ui/progress';
import { dashboardApi, getCurrentUser } from '../services/api';
import { usePermissions } from '../hooks/usePermissions';
import { useTenantSyncVersion } from '../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../components/ui/tenant-filter-select';
import { enumLabel } from '../../i18n/enumLabel';
import { formatDate } from '../../i18n/formatters';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getStatusColor(status: string) {
  const map: Record<string, string> = {
    ACTIVE:      'bg-emerald-100 text-emerald-700',
    INACTIVE:    'bg-gray-100 text-gray-600',
    PENDING:     'bg-amber-100 text-amber-700',
    ONBOARDING:  'bg-blue-100 text-blue-700',
    TERMINATED:  'bg-red-100 text-red-600',
    ON_LEAVE:    'bg-purple-100 text-purple-700',
  };
  return map[status] ?? 'bg-gray-100 text-gray-600';
}

function activityColor(action: string) {
  const a = action?.toUpperCase() ?? '';
  if (a.includes('DELETE') || a.includes('REJECT'))   return 'bg-red-500';
  if (a.includes('CREATE') || a.includes('UPLOAD'))   return 'bg-emerald-500';
  if (a.includes('UPDATE') || a.includes('EDIT'))     return 'bg-blue-500';
  if (a.includes('VERIFY') || a.includes('APPROVE'))  return 'bg-emerald-500';
  if (a.includes('LOGIN') || a.includes('LOGOUT'))    return 'bg-gray-400';
  return 'bg-amber-500';
}

function useActivityLabel() {
  const { t } = useTranslation('dashboard');
  return (action: string, entity: string): string => {
    const a = action?.toUpperCase() ?? '';
    const e = entity ? entity.charAt(0).toUpperCase() + entity.slice(1).toLowerCase() : '';
    if (a === 'UPLOAD')  return t('recentActivity.uploaded',  { entity: e });
    if (a === 'VERIFY')  return t('recentActivity.verified',  { entity: e });
    if (a === 'REJECT')  return t('recentActivity.rejected',  { entity: e });
    if (a === 'CREATE')  return t('recentActivity.created',   { entity: e });
    if (a === 'UPDATE')  return t('recentActivity.updated',   { entity: e });
    if (a === 'DELETE')  return t('recentActivity.deleted',   { entity: e });
    if (a === 'RENEW')   return t('recentActivity.renewed',   { entity: e });
    if (a === 'CONVERT') return t('recentActivity.converted', { entity: e });
    return t('recentActivity.fallback', { entity: e, action: action?.toLowerCase() ?? '' });
  };
}

function useTimeAgo() {
  const { t } = useTranslation('dashboard');
  return (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return t('timeAgo.justNow');
    if (m < 60) return t('timeAgo.minutesAgo', { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('timeAgo.hoursAgo', { count: h });
    return t('timeAgo.daysAgo', { count: Math.floor(h / 24) });
  };
}

// Map workflow stage names to the 4 required display categories. The `id` is
// stable; the user-facing label is resolved via t() at render time.
const STAGE_KEYWORDS: { id: 'documentVerification' | 'workPermit' | 'visa' | 'onboarding'; keywords: string[] }[] = [
  { id: 'documentVerification', keywords: ['document', 'verification', 'doc'] },
  { id: 'workPermit',           keywords: ['permit', 'work permit'] },
  { id: 'visa',                 keywords: ['visa'] },
  { id: 'onboarding',           keywords: ['onboard', 'onboarding', 'deployment'] },
];

function matchStageToCategory(stageName: string) {
  const lower = stageName.toLowerCase();
  for (const cat of STAGE_KEYWORDS) {
    if (cat.keywords.some(k => lower.includes(k))) return cat.id;
  }
  return null;
}

// ── Permission-based landing helper ───────────────────────────────────────────
//
// Mirrors the order of Sidebar.tsx's primary navigation items so the
// fallback page after a /dashboard redirect is the same one the user
// would have clicked first in the menu. Returns null when the user
// holds no view permission — the caller renders an access-denied
// screen in that case.
function firstAccessibleRoute(canView: (mod: string) => boolean): string | null {
  const ordered: Array<[string, string]> = [
    ['applicants',  '/dashboard/applicants'],
    ['employees',   '/dashboard/employees'],
    ['attendance',  '/dashboard/attendance'],
    ['vehicles',    '/dashboard/vehicles'],
    ['documents',   '/dashboard/documents-compliance'],
    ['workflow',    '/dashboard/workflows'],
    ['agencies',    '/dashboard/agencies'],
    ['reports',     '/dashboard/reports'],
    ['finance',     '/dashboard/finance'],
    ['job-ads',     '/dashboard/job-ads'],
    ['notifications', '/dashboard/notifications'],
    ['users',       '/dashboard/users'],
    ['roles',       '/dashboard/roles-permissions'],
    ['logs',        '/dashboard/system-logs'],
    ['recycle-bin', '/dashboard/deleted-records'],
    ['settings',    '/dashboard/settings'],
  ];
  for (const [perm, path] of ordered) {
    if (canView(perm)) return path;
  }
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Dashboard() {
  const { t } = useTranslation('dashboard');
  const { t: tc } = useTranslation('common');
  const activityLabel = useActivityLabel();
  const timeAgo = useTimeAgo();
  const currentUser = getCurrentUser();
  const isAgencyUser = currentUser?.role === 'Agency User' || currentUser?.role === 'Agency Manager';
  const applicantsPath = '/dashboard/applicants';
  const { canView, canCreate, can } = usePermissions();

  // Permission-gated landing. Users without `dashboard:read` should
  // never see the empty-data shell with a 403 "Failed to load
  // dashboard data" banner — bounce them to the first sidebar item
  // they CAN access, mirroring the Sidebar permission map. If they
  // hold no view permission at all, the access-denied screen below
  // renders.
  const dashboardFallback = firstAccessibleRoute(canView);

  const [data,       setData]       = useState<any>(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // SUPER USERs get a per-page Tenant filter so the dashboard KPIs
  // can be scoped to a specific tenant — matching the list pages
  // (Documents/Applicants/Employees/...). Non-SUPER callers see no
  // selector; the backend ignores any override they send.
  const tenant = useSuperUserTenantFilter();

  const load = async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else             setLoading(true);
    setError(false);
    try {
      const params = tenant.applyToParams({});
      const result = await dashboardApi.getOverview(params);
      setData(result);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const tenantVersion = useTenantSyncVersion();
  // Phase 2B (#5) — refetch on tenant switch (deps include tenantVersion).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [tenantVersion, tenant.tenantFilter]);

  // ── Derived values ─────────────────────────────────────────────────────────

  const employees      = data?.employees   ?? {};
  const applicants     = data?.applicants  ?? {};
  const documents      = data?.documents   ?? {};
  const workflow       = data?.pipeline    ?? {};
  const recentEmps     = data?.recentEmployees   ?? [];
  const expiredDocs    = data?.expiredDocuments  ?? [];
  const recentActivity = data?.recentActivity    ?? [];

  const totalEmp       = employees.total        ?? 0;
  const activeEmp      = employees.active       ?? 0;
  const deltaThisMonth = employees.newThisMonth ?? 0;

  const pendingApps    = applicants.pending      ?? 0;
  const totalApps      = applicants.total        ?? 0;
  const appByStatus: { status: string; count: number }[] = applicants.byStatus ?? [];

  const expiringSoon        = documents.expiringSoon          ?? 0;
  const expiredUnrenewed    = documents.expiredUnrenewedCount ?? 0;

  const workflowStages: any[]    = workflow.stages           ?? [];
  const avgDays:         number | null = workflow.avgProcessingDays ?? null;
  const approvalRate:    number | null = workflow.approvalRate      ?? null;

  // Aggregate workflow into the 4 required categories
  const workflowSummary = STAGE_KEYWORDS.map(cat => {
    const matching = workflowStages.filter(s => matchStageToCategory(s.name) === cat.id);
    const count    = matching.reduce((sum, s) => sum + (s.count ?? 0), 0);
    return { id: cat.id, label: t(`workflow.${cat.id}`), count };
  });
  const workflowTotal = workflowSummary.reduce((s, c) => s + c.count, 0);

  // Applicant status lookups
  const appStatus = (s: string) => appByStatus.find(x => x.status === s)?.count ?? 0;

  // ── Stat card sub-component ────────────────────────────────────────────────
  const Skeleton = () => <div className="h-7 w-16 bg-muted animate-pulse rounded" />;

  // Permission gate. Redirect users without `dashboard:read` to the
  // first sidebar item they can access; if they hold no view
  // permission, show the access-denied screen used throughout the
  // app (AddAgency, EditUser, FinanceDashboard, etc.).
  if (!canView('dashboard')) {
    if (dashboardFallback) return <Navigate to={dashboardFallback} replace />;
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <p className="text-lg font-semibold text-[#0F172A]">{tc('permissions.accessDenied')}</p>
        <p className="text-sm text-muted-foreground mt-1">{tc('permissions.noPermission')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">
            {t('welcomeBack', {
              name: currentUser ? `${currentUser.firstName} ${currentUser.lastName}` : t('user'),
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tenant.isPlatformSuper && (
            <TenantFilterSelect
              value={tenant.tenantFilter}
              onChange={tenant.setTenantFilter}
              options={tenant.tenantOptions}
            />
          )}
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 me-2 ${refreshing ? 'animate-spin' : ''}`} />
            {t('refresh')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {t('loadFailed')} <button className="underline" onClick={() => load()}>{t('retry')}</button>
        </div>
      )}

      {/* ── Widget Row 1: Summary KPI Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* 1. Total Employees */}
        <Link to="/dashboard/employees" className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('kpi.totalEmployees')}</CardTitle>
              <Users className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton /> : <div className="text-3xl font-bold text-[#0F172A]">{totalEmp}</div>}
              <div className="flex items-center gap-1 mt-1 text-xs">
                {deltaThisMonth > 0
                  ? <><ArrowUp className="w-3 h-3 text-emerald-500" /><span className="text-emerald-600 font-medium">+{deltaThisMonth}</span><span className="text-muted-foreground ms-1">{t('kpi.thisMonth')}</span></>
                  : deltaThisMonth < 0
                  ? <><ArrowDown className="w-3 h-3 text-red-500" /><span className="text-red-600 font-medium">{deltaThisMonth}</span><span className="text-muted-foreground ms-1">{t('kpi.thisMonth')}</span></>
                  : <><Minus className="w-3 h-3 text-muted-foreground" /><span className="text-muted-foreground">{t('kpi.noChangeThisMonth')}</span></>
                }
              </div>
            </CardContent>
          </Card>
        </Link>

        {/* 2. Active Employees */}
        <Link to="/dashboard/employees?status=ACTIVE" className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('kpi.activeEmployees')}</CardTitle>
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton /> : <div className="text-3xl font-bold text-[#0F172A]">{activeEmp}</div>}
              <div className="flex items-center gap-1 mt-1 text-xs">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-emerald-600 font-medium">{t('kpi.active')}</span>
                {totalEmp > 0 && !loading && (
                  <span className="text-muted-foreground ms-1">
                    {t('kpi.ofTotal', { percent: ((activeEmp / totalEmp) * 100).toFixed(0) })}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        </Link>

        {/* 3. Pending Applications */}
        <Link to={`${applicantsPath}?status=NEW`} className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('kpi.pendingApplications')}</CardTitle>
              <Clock className="w-4 h-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton /> : <div className="text-3xl font-bold text-[#0F172A]">{pendingApps}</div>}
              <div className="flex items-center gap-1 mt-1 text-xs">
                {pendingApps > 0
                  ? <><span className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">{t('kpi.needReview', { count: pendingApps })}</span></>
                  : <span className="text-muted-foreground">{t('kpi.allReviewed')}</span>
                }
              </div>
            </CardContent>
          </Card>
        </Link>

        {/* 4. Expired Documents — already past expiry. */}
        <Link to="/dashboard/documents-compliance?status=EXPIRED" className="group">
          <Card className={`hover:shadow-md transition-shadow cursor-pointer h-full ${expiredUnrenewed > 0 ? 'border-red-300' : ''}`}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('kpi.expiredDocuments')}</CardTitle>
              <AlertTriangle className={`w-4 h-4 ${expiredUnrenewed > 0 ? 'text-red-500' : 'text-muted-foreground'}`} />
            </CardHeader>
            <CardContent>
              {loading
                ? <Skeleton />
                : <div className={`text-3xl font-bold ${expiredUnrenewed > 0 ? 'text-red-600' : 'text-[#0F172A]'}`}>{expiredUnrenewed}</div>
              }
              <div className="mt-1 text-xs">
                {expiredUnrenewed > 0
                  ? <span className="text-red-600 font-medium">{t('kpi.expiredAction')}</span>
                  : <span className="text-muted-foreground">{t('kpi.noExpired')}</span>
                }
              </div>
            </CardContent>
          </Card>
        </Link>

        {/* 5. Expiring Soon — expiryDate within 60 days. */}
        <Link to="/dashboard/documents-compliance?status=EXPIRING_SOON" className="group">
          <Card className={`hover:shadow-md transition-shadow cursor-pointer h-full ${expiringSoon > 0 ? 'border-amber-300' : ''}`}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('kpi.expiringDocuments')}</CardTitle>
              <AlertTriangle className={`w-4 h-4 ${expiringSoon > 0 ? 'text-amber-500' : 'text-muted-foreground'}`} />
            </CardHeader>
            <CardContent>
              {loading
                ? <Skeleton />
                : <div className={`text-3xl font-bold ${expiringSoon > 0 ? 'text-amber-600' : 'text-[#0F172A]'}`}>{expiringSoon}</div>
              }
              <div className="mt-1 text-xs">
                {expiringSoon > 0
                  ? <span className="text-amber-600 font-medium">{t('kpi.within60DaysAction')}</span>
                  : <span className="text-muted-foreground">{t('kpi.within60Days')}</span>
                }
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* ── Widget Row 2: Applicants Overview ── */}
      <Card className="bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200">
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-[#0F172A]">
                <Users className="w-5 h-5 text-[#2563EB]" />
                {t('applicants.title')}
              </CardTitle>
              <CardDescription>{t('applicants.subtitle')}</CardDescription>
            </div>
            <Button asChild size="sm">
              <Link to={applicantsPath}>{isAgencyUser ? t('applicants.viewAllCandidates') : t('applicants.viewAllApplicants')}</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { key: 'total',         label: t('applicants.total'),         value: totalApps,             color: 'text-[#0F172A]',  link: applicantsPath },
              { key: 'newUnreviewed', label: t('applicants.newUnreviewed'), value: appStatus('NEW'),      color: 'text-blue-600',   link: `${applicantsPath}?status=NEW` },
              { key: 'screening',     label: t('applicants.screening'),     value: appStatus('SCREENING'),color: 'text-amber-600',  link: `${applicantsPath}?status=SCREENING` },
              { key: 'interview',     label: t('applicants.interview'),     value: appStatus('INTERVIEW'),color: 'text-purple-600', link: `${applicantsPath}?status=INTERVIEW` },
              { key: 'offerMade',     label: t('applicants.offerMade'),     value: appStatus('OFFER'),    color: 'text-indigo-600', link: `${applicantsPath}?status=OFFER` },
              { key: 'accepted',      label: t('applicants.accepted'),      value: appStatus('ACCEPTED'), color: 'text-emerald-600',link: `${applicantsPath}?status=ACCEPTED` },
            ].map(({ key, label, value, color, link }) => (
              <Link key={key} to={link}>
                <div className="text-center p-3 bg-white rounded-lg hover:shadow-sm transition-shadow cursor-pointer">
                  {loading
                    ? <div className="h-7 w-10 bg-muted animate-pulse rounded mx-auto" />
                    : <div className={`text-2xl font-bold ${color}`}>{value}</div>
                  }
                  <div className="text-xs text-muted-foreground mt-1 leading-tight">{label}</div>
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Widget Row 3: Workflow + Activity ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 5. Recruitment Workflow */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{t('workflow.title')}</CardTitle>
                <CardDescription>{t('workflow.subtitle')}</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link to="/dashboard/workflows">{t('workflow.viewWorkflow')} <ChevronRight className="w-3 h-3 ms-1 rtl:rotate-180" /></Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading
              ? [1, 2, 3, 4].map(i => (
                  <div key={i} className="space-y-1">
                    <div className="h-4 bg-muted animate-pulse rounded w-1/3" />
                    <div className="h-2 bg-muted animate-pulse rounded" />
                  </div>
                ))
              : workflowStages.length === 0
              ? <p className="text-sm text-muted-foreground py-4 text-center">{t('workflow.noStages')}</p>
              : workflowSummary.map(({ id, label, count }) => {
                  const pct = workflowTotal > 0 ? Math.round((count / workflowTotal) * 100) : 0;
                  return (
                    <div key={id} className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium">{t('workflow.employees', { count })}</span>
                      </div>
                      <Progress value={pct} className="h-2" />
                    </div>
                  );
                })
            }

            <div className="pt-4 border-t">
              <div className="grid grid-cols-2 gap-4 text-center">
                <div>
                  <div className="text-2xl font-semibold text-[#2563EB]">
                    {loading ? '—' : avgDays !== null ? t('workflow.daysSuffix', { count: avgDays }) : '—'}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{t('workflow.avgProcessingDays')}</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold text-emerald-600">
                    {loading ? '—' : approvalRate !== null ? `${approvalRate}%` : '—'}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{t('workflow.approvalRate')}</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 6. Recent Activity Feed */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              {t('recentActivity.title')}
            </CardTitle>
            <CardDescription>{t('recentActivity.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            {loading
              ? <div className="space-y-3">
                  {[1,2,3,4].map(i => <div key={i} className="h-12 bg-muted animate-pulse rounded" />)}
                </div>
              : recentActivity.length === 0
              ? <p className="text-sm text-muted-foreground py-4 text-center">{t('recentActivity.empty')}</p>
              : <div className="space-y-3">
                  {recentActivity.map((item: any) => (
                    <div key={item.id} className="flex gap-3">
                      <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${activityColor(item.action)}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[#0F172A] leading-tight">
                          {activityLabel(item.action, item.entity)}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {item.userEmail ?? t('recentActivity.system')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {timeAgo(item.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
            }
            <Button variant="outline" className="w-full mt-4" size="sm" asChild>
              <Link to="/dashboard/logs">{t('recentActivity.viewAll')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* ── Widget Row 4: Recent Employees + Expired Documents ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 7. Recent Employees */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{t('recentEmployees.title')}</CardTitle>
                <CardDescription>{t('recentEmployees.subtitle')}</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link to="/dashboard/employees">{t('recentEmployees.viewAll')} <ChevronRight className="w-3 h-3 ms-1 rtl:rotate-180" /></Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loading
              ? <div className="space-y-3">
                  {[1,2,3].map(i => <div key={i} className="h-14 bg-muted animate-pulse rounded" />)}
                </div>
              : recentEmps.length === 0
              ? <div className="text-center py-8 text-muted-foreground text-sm">{t('recentEmployees.empty')}</div>
              : <div className="space-y-2">
                  {recentEmps.map((emp: any) => (
                    <Link key={emp.id} to={`/dashboard/employees/${emp.id}`}>
                      <div className="flex items-center justify-between p-3 rounded-lg hover:bg-[#F8FAFC] transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full overflow-hidden bg-blue-100 flex items-center justify-center shrink-0">
                            {emp.photoUrl
                              ? <img
                                  src={emp.photoUrl?.startsWith('http') ? emp.photoUrl : `${API_BASE}${emp.photoUrl}`}
                                  alt={emp.firstName}
                                  className="w-full h-full object-cover"
                                />
                              : <span className="text-blue-600 text-sm font-semibold">
                                  {emp.firstName?.[0]}{emp.lastName?.[0]}
                                </span>
                            }
                          </div>
                          <div>
                            <p className="text-sm font-medium text-[#0F172A]">
                              {emp.firstName} {emp.lastName}
                            </p>
                            <p className="text-xs text-muted-foreground font-mono">
                              {emp.employeeNumber ?? '—'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {emp.createdAt ? formatDate(emp.createdAt) : '—'}
                            </p>
                          </div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getStatusColor(emp.status)}`}>
                          {enumLabel('employeeStatus', emp.status)}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
            }
          </CardContent>
        </Card>

        {/* 8. Expired Documents (not yet renewed) */}
        <Card className={expiredUnrenewed > 0 ? 'border-red-200' : ''}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FileX className={`w-4 h-4 ${expiredUnrenewed > 0 ? 'text-red-500' : 'text-muted-foreground'}`} />
                  {t('expiredDocuments.title')}
                </CardTitle>
                <CardDescription>
                  {loading ? t('expiredDocuments.subtitleLoading') : t('expiredDocuments.subtitleCount', { count: expiredUnrenewed })}
                </CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link to="/dashboard/documents-compliance">{t('expiredDocuments.viewAll')} <ChevronRight className="w-3 h-3 ms-1 rtl:rotate-180" /></Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loading
              ? <div className="space-y-3">
                  {[1,2,3].map(i => <div key={i} className="h-14 bg-muted animate-pulse rounded" />)}
                </div>
              : expiredDocs.length === 0
              ? <div className="text-center py-8 text-muted-foreground text-sm">
                  {expiredUnrenewed === 0 ? t('expiredDocuments.emptyZero') : t('expiredDocuments.emptyOther')}
                </div>
              : <div className="space-y-2">
                  {expiredDocs.map((doc: any) => {
                    const expDate  = doc.expiryDate ? new Date(doc.expiryDate) : null;
                    const daysAgo  = expDate ? Math.floor((Date.now() - expDate.getTime()) / 86400000) : null;
                    return (
                      <Link key={doc.id} to={`/dashboard/documents/${doc.id}`}>
                        <div className="flex items-center justify-between p-3 rounded-lg hover:bg-red-50 transition-colors">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-[#0F172A] truncate">{doc.name}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {doc.ownerName ?? doc.entityId?.slice(0, 8)}
                              {doc.documentType?.name ? ` · ${doc.documentType.name}` : ''}
                            </p>
                            {expDate && (
                              <p className="text-xs text-red-500">
                                {t('expiredDocuments.expiredOn', { date: formatDate(expDate), days: daysAgo })}
                              </p>
                            )}
                          </div>
                          <Badge variant="outline" className="bg-red-50 text-red-600 border-red-300 ms-2 shrink-0">
                            {t('expiredDocuments.expiredBadge')}
                          </Badge>
                        </div>
                      </Link>
                    );
                  })}
                  {expiredUnrenewed > 5 && (
                    <p className="text-xs text-muted-foreground text-center pt-1">
                      {t('expiredDocuments.more', { count: expiredUnrenewed - 5 })}{' '}
                      <Link to="/dashboard/documents-compliance" className="underline">{t('expiredDocuments.moreLink')}</Link>
                    </p>
                  )}
                </div>
            }
          </CardContent>
        </Card>
      </div>

      {/* ── Widget Row 5: Quick Actions ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-muted-foreground" />
            {t('quickActions.title')}
          </CardTitle>
          <CardDescription>{t('quickActions.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {canCreate('employees') && (
              <Button variant="outline" className="h-auto flex-col gap-2 p-4 hover:bg-blue-50 hover:border-blue-300" asChild>
                <Link to="/dashboard/employees/add">
                  <UserPlus className="w-6 h-6 text-blue-600" />
                  <span className="text-sm">{t('quickActions.addEmployee')}</span>
                </Link>
              </Button>
            )}
            {canCreate('documents') && (
              <Button variant="outline" className="h-auto flex-col gap-2 p-4 hover:bg-emerald-50 hover:border-emerald-300" asChild>
                <Link to="/dashboard/documents/upload">
                  <FileCheck className="w-6 h-6 text-emerald-600" />
                  <span className="text-sm">{t('quickActions.uploadDocument')}</span>
                </Link>
              </Button>
            )}
            {can('workflow', 'read') && (
              <Button variant="outline" className="h-auto flex-col gap-2 p-4 hover:bg-purple-50 hover:border-purple-300" asChild>
                <Link to="/dashboard/workflows">
                  <TrendingUp className="w-6 h-6 text-purple-600" />
                  <span className="text-sm">{t('quickActions.viewWorkflow')}</span>
                </Link>
              </Button>
            )}
            {can('reports', 'read') && (
              <Button variant="outline" className="h-auto flex-col gap-2 p-4 hover:bg-amber-50 hover:border-amber-300" asChild>
                <Link to="/dashboard/reports">
                  <BarChart3 className="w-6 h-6 text-amber-600" />
                  <span className="text-sm">{t('quickActions.reports')}</span>
                </Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
