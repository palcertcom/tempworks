import { Link, useParams } from 'react-router';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Building2, Mail, Phone, MapPin, Users, Shield, ChevronRight, Settings, Pencil } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { toast } from 'sonner';
import { agenciesApi, getCurrentUser } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { FinancialRecordsTab } from '../../components/finance/FinancialRecordsTab';
import { apiError } from '../../../i18n/apiError';
import { enumLabel } from '../../../i18n/enumLabel';

// Roles that can SEE the internal agency financial records. Agency users
// (external) are intentionally excluded from every list so the tab does
// not render at all for them.
const FINANCE_VIEW_ROLES   = ['System Admin', 'HR Manager', 'Finance', 'Recruiter'];
const FINANCE_WRITE_ROLES  = ['System Admin', 'HR Manager', 'Finance'];
const FINANCE_STATUS_ROLES = ['System Admin', 'Finance'];

export function AgencyProfile() {
  const { id } = useParams();
  const { canEdit } = usePermissions();
  const { t } = useTranslation(['pages', 'common']);
  const [agency, setAgency] = useState<any>(null);
  const [employees, setEmployees] = useState<any[]>([]);
  const [agencyUsers, setAgencyUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settings, setSettings] = useState({ maxUsers: '10' });

  // Financial records are for Tempworks-internal staff only. Agency users
  // never see the tab, and the backend enforces role checks independently
  // so hiding is defence-in-depth not the primary gate.
  const currentUser = getCurrentUser();
  const userRole = currentUser?.role ?? '';
  const canViewFinance   = FINANCE_VIEW_ROLES.includes(userRole);
  const canWriteFinance  = FINANCE_WRITE_ROLES.includes(userRole);
  const canStatusFinance = FINANCE_STATUS_ROLES.includes(userRole);

  useEffect(() => {
    Promise.all([
      agenciesApi.get(id!),
      agenciesApi.getEmployees(id!, { limit: 50 }),
      agenciesApi.getUsers(id!),
    ]).then(([agencyData, empData, usersData]) => {
      setAgency(agencyData);
      setEmployees((empData as any)?.data ?? empData ?? []);
      setAgencyUsers((usersData as any)?.data ?? usersData ?? []);
      setSettings({ maxUsers: String((agencyData as any).maxUsersPerAgency ?? 10) });
    }).catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await agenciesApi.update(id!, { maxUsersPerAgency: parseInt(settings.maxUsers, 10) });
      toast.success(t('pages:agencies.profile.toast.settingsSaved'));
    } catch (err) {
      toast.error(apiError(err, t('pages:agencies.profile.toast.settingsFailed')));
    } finally {
      setSavingSettings(false);
    }
  };

  if (loading) return <div className="p-8 text-muted-foreground">{t('common:states.loading')}</div>;
  if (notFound || !agency) return <div className="p-8">{t('pages:agencies.profile.notFound')}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/agencies"><ArrowLeft className="w-5 h-5 rtl:rotate-180" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{agency.name}</h1>
          <p className="text-muted-foreground mt-1">{t('pages:agencies.profile.subtitle')}</p>
        </div>
        {canEdit('agencies') && (
          <Button variant="outline" asChild>
            <Link to={`/dashboard/agencies/${id}/edit`}>
              <Pencil className="w-4 h-4 me-2" />
              {t('pages:agencies.profile.editProfile')}
            </Link>
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link to={`/dashboard/agencies/${id}/users`}>
            <Users className="w-4 h-4 me-2" />
            {t('pages:agencies.profile.manageUsers')}
          </Link>
        </Button>
      </div>

      {/* Agency Info Card */}
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div className="flex items-center gap-3">
              <Building2 className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">{t('pages:agencies.profile.info.country')}</p>
                <p className="font-medium">{agency.country}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Mail className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">{t('pages:agencies.profile.info.email')}</p>
                <p className="font-medium">{agency.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Phone className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">{t('pages:agencies.profile.info.phone')}</p>
                <p className="font-medium">{agency.phone}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <MapPin className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">{t('pages:agencies.profile.info.contactPerson')}</p>
                <p className="font-medium">{agency.contactPerson}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <Users className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">
                  {employees.filter(e => e.status === 'ACTIVE').length}
                </p>
                <p className="text-sm text-muted-foreground">{t('pages:agencies.profile.stats.activeEmployees')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Users className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{employees.length}</p>
                <p className="text-sm text-muted-foreground">{t('pages:agencies.profile.stats.totalEmployees')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <Shield className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{agencyUsers.length}/{settings.maxUsers}</p>
                <p className="text-sm text-muted-foreground">{t('pages:agencies.profile.stats.agencyUsers')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <Building2 className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <Badge className={agency.status === 'ACTIVE' ? 'bg-[#22C55E]' : 'bg-gray-500'}>
                  {enumLabel('agencyStatus', agency.status)}
                </Badge>
                <p className="text-sm text-muted-foreground mt-1">{t('pages:agencies.profile.stats.status')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <Tabs defaultValue="employees" className="space-y-6">
        <TabsList>
          <TabsTrigger value="employees">{t('pages:agencies.profile.tabs.employees')}</TabsTrigger>
          <TabsTrigger value="users">{t('pages:agencies.profile.tabs.users')}</TabsTrigger>
          {canViewFinance && <TabsTrigger value="finance">{t('pages:agencies.profile.tabs.finance')}</TabsTrigger>}
          <TabsTrigger value="settings">{t('pages:agencies.profile.tabs.settings')}</TabsTrigger>
        </TabsList>

        <TabsContent value="employees">
          <Card>
            <CardHeader>
              <CardTitle>{t('pages:agencies.profile.employees.title', { count: employees.length })}</CardTitle>
            </CardHeader>
            <CardContent>
              {employees.length === 0 ? (
                <p className="text-muted-foreground">{t('pages:agencies.profile.employees.empty')}</p>
              ) : (
                <div className="space-y-3">
                  {employees.map((emp) => (
                    <div key={emp.id} className="flex items-center justify-between p-4 rounded-lg border hover:bg-[#F8FAFC] transition-colors">
                      <div>
                        <p className="font-medium">{emp.firstName} {emp.lastName}</p>
                        <p className="text-sm text-muted-foreground">{emp.email}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge className={
                          emp.status === 'ACTIVE' ? 'bg-[#22C55E]' :
                          emp.status === 'PENDING' ? 'bg-[#F59E0B]' :
                          'bg-gray-500'
                        }>
                          {enumLabel('employeeStatus', emp.status)}
                        </Badge>
                        <Button size="sm" asChild>
                          <Link to={`/dashboard/employees/${emp.id}`}>
                            {t('pages:agencies.profile.employees.viewProfile')}
                            <ChevronRight className="w-4 h-4 ms-1 rtl:rotate-180" />
                          </Link>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('pages:agencies.profile.users.title', { count: agencyUsers.length })}</CardTitle>
              <Button asChild>
                <Link to={`/dashboard/agencies/${id}/users`}>
                  <Users className="w-4 h-4 me-2" />
                  {t('pages:agencies.profile.manageAllUsers')}
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {agencyUsers.length === 0 ? (
                <p className="text-muted-foreground">{t('pages:agencies.profile.users.empty')}</p>
              ) : (
                <div className="space-y-3">
                  {agencyUsers.map((user: any) => (
                    <div key={user.id} className="flex items-center justify-between p-4 rounded-lg border">
                      <div>
                        <p className="font-medium">{user.firstName} {user.lastName}</p>
                        <p className="text-sm text-muted-foreground">{user.email}</p>
                      </div>
                      <Badge>{user.role?.name ?? enumLabel('userStatus', user.status)}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {canViewFinance && (
          <TabsContent value="finance">
            <FinancialRecordsTab
              entityType="AGENCY"
              entityId={id!}
              entityName={agency?.name}
              canWrite={canWriteFinance}
              canChangeStatus={canStatusFinance}
            />
          </TabsContent>
        )}

        <TabsContent value="settings">
          <Card>
            <CardHeader>
              <CardTitle>{t('pages:agencies.profile.settings.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <Label htmlFor="maxUsers">{t('pages:agencies.profile.settings.maxUsersLabel')}</Label>
                <p className="text-sm text-muted-foreground mt-1 mb-3">
                  {t('pages:agencies.profile.settings.maxUsersHelp')}
                </p>
                <Select value={settings.maxUsers} onValueChange={val => setSettings(prev => ({ ...prev, maxUsers: val }))}>
                  <SelectTrigger id="maxUsers">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">{t('pages:agencies.profile.settings.maxUsersOption', { count: 5 })}</SelectItem>
                    <SelectItem value="10">{t('pages:agencies.profile.settings.maxUsersOption', { count: 10 })}</SelectItem>
                    <SelectItem value="15">{t('pages:agencies.profile.settings.maxUsersOption', { count: 15 })}</SelectItem>
                    <SelectItem value="20">{t('pages:agencies.profile.settings.maxUsersOption', { count: 20 })}</SelectItem>
                    <SelectItem value="50">{t('pages:agencies.profile.settings.maxUsersOption', { count: 50 })}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex justify-end pt-4">
                <Button onClick={handleSaveSettings} disabled={savingSettings}>
                  <Settings className="w-4 h-4 me-2" />
                  {savingSettings ? t('common:states.saving') : t('pages:agencies.profile.settings.save')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
