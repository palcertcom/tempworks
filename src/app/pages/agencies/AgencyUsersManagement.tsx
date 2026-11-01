import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Trash2, Users, Shield, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { agenciesApi, usersApi, getCurrentUser } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { apiError } from '../../../i18n/apiError';
import { formatDate } from '../../../i18n/formatters';

const ADMIN_ROLES = ['System Admin', 'HR Manager'];

export function AgencyUsersManagement() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { id } = useParams();
  const { canCreate, canDelete, can } = usePermissions();
  const canManageUsers = canCreate('users') || can('agencies', 'update');
  const currentUser = getCurrentUser();
  const isAdmin = ADMIN_ROLES.includes(currentUser?.role ?? '');

  const [agency, setAgency] = useState<any>(null);
  const [agencyUsers, setAgencyUsers] = useState<any[]>([]);
  const [maxUsers, setMaxUsers] = useState<number>(5);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      agenciesApi.get(id!),
      agenciesApi.getUsers(id!),
    ]).then(([agencyData, usersResult]) => {
      setAgency(agencyData);
      setAgencyUsers((usersResult as any)?.data ?? usersResult ?? []);
      setMaxUsers((agencyData as any).maxUsersPerAgency ?? 10);
    }).catch(() => toast.error(t('agencies.users.loadFailed')))
      .finally(() => setLoading(false));
  }, [id, t]);

  const handleApprove = async (user: any) => {
    try {
      const updated = await usersApi.approveAgencyUser(user.id);
      setAgencyUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...updated } : u));
      toast.success(t('agencies.users.approveSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('agencies.users.approveFailed')));
    }
  };

  const handleManagerOverride = async (user: any, flags: { allowManagerEdit?: boolean; allowManagerDelete?: boolean }) => {
    try {
      const updated = await usersApi.setManagerOverride(user.id, flags);
      setAgencyUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...updated } : u));
      toast.success(t('agencies.users.overrideUpdated'));
    } catch (err: any) {
      toast.error(apiError(err, t('agencies.users.overrideFailed')));
    }
  };

  const handleDeleteUser = async (user: any) => {
    if (!(await confirm({
      title: t('agencies.users.removeTitle'),
      description: t('agencies.users.removeBody', { name: `${user.firstName} ${user.lastName}` }),
      confirmText: t('agencies.users.removeConfirm'),
      tone: 'destructive',
    }))) return;
    try {
      await usersApi.delete(user.id);
      setAgencyUsers(prev => prev.filter(u => u.id !== user.id));
      toast.success(t('agencies.users.removeSuccess'));
    } catch (err: any) {
      toast.error(apiError(err, t('agencies.users.removeFailed')));
    }
  };

  if (loading) return <div className="p-8 text-muted-foreground">{tc('states.loading')}</div>;
  if (!agency) return <div className="p-8">{t('agencies.profile.notFound')}</div>;

  const activeUsers = agencyUsers.filter(u => u.status === 'ACTIVE');
  const managers = agencyUsers.filter(u => u.role?.name === 'Agency Manager');
  const atLimit = activeUsers.length >= maxUsers;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/dashboard/agencies/${id}`}><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('agencies.users.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('agencies.users.manageSubtitle', { name: agency.name })}</p>
        </div>
        {canManageUsers && (
          <Button asChild disabled={atLimit}>
            <Link to="/dashboard/users/add">
              <Plus className="w-4 h-4 me-2" />
              {t('agencies.users.addButton')}
            </Link>
          </Button>
        )}
      </div>

      {atLimit && (
        <Card className="border-[#F59E0B] bg-[#FEF3C7]">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-[#F59E0B] mt-0.5" />
              <div>
                <p className="font-medium text-[#F59E0B]">{t('agencies.users.atLimitTitle')}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('agencies.users.atLimitBody', { count: maxUsers })}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Users className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{activeUsers.length}/{maxUsers}</p>
                <p className="text-sm text-muted-foreground">{t('agencies.users.activeUsers')}</p>
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
                <p className="text-2xl font-semibold">{managers.length}</p>
                <p className="text-sm text-muted-foreground">{t('agencies.users.managers')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#FEE2E2] flex items-center justify-center">
                <Users className="w-6 h-6 text-[#EF4444]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{agencyUsers.filter(u => u.status !== 'ACTIVE').length}</p>
                <p className="text-sm text-muted-foreground">{t('agencies.users.inactive')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('agencies.users.agencyUsersTitle', { count: agencyUsers.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          {agencyUsers.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">{t('agencies.users.noUsers')}</p>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-[#F8FAFC] border-b">
                  <tr>
                    <th className="text-start p-4 font-semibold text-sm">{t('agencies.users.tableHeaders.user')}</th>
                    <th className="text-start p-4 font-semibold text-sm">{t('agencies.users.tableHeaders.role')}</th>
                    <th className="text-start p-4 font-semibold text-sm">{t('agencies.users.tableHeaders.approval')}</th>
                    <th className="text-start p-4 font-semibold text-sm">{t('agencies.users.tableHeaders.status')}</th>
                    <th className="text-start p-4 font-semibold text-sm">{t('agencies.users.tableHeaders.lastLogin')}</th>
                    <th className="text-start p-4 font-semibold text-sm">{t('agencies.users.tableHeaders.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {agencyUsers.map((user) => (
                    <tr key={user.id} className="border-b hover:bg-[#F8FAFC] transition-colors">
                      <td className="p-4">
                        <div>
                          <p className="font-medium">{user.firstName} {user.lastName}</p>
                          <p className="text-sm text-muted-foreground">{user.email}</p>
                        </div>
                      </td>
                      <td className="p-4">
                        <Badge variant="outline" className={
                          user.role?.name === 'Agency Manager'
                            ? 'bg-[#EFF6FF] text-[#2563EB] border-[#2563EB]'
                            : 'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0]'
                        }>
                          {user.role?.name ?? '—'}
                        </Badge>
                      </td>
                      <td className="p-4">
                        {user.approvalStatus === 'PENDING_APPROVAL' ? (
                          <Badge className="bg-amber-100 text-amber-900 border border-amber-300">{t('agencies.users.approvalStatus.pending')}</Badge>
                        ) : user.approvalStatus === 'REJECTED' ? (
                          <Badge className="bg-red-100 text-red-900 border border-red-300">{t('agencies.users.approvalStatus.rejected')}</Badge>
                        ) : (
                          <Badge className="bg-emerald-100 text-emerald-900 border border-emerald-300">{t('agencies.users.approvalStatus.approved')}</Badge>
                        )}
                        {user.approvalStatus === 'APPROVED' && (user.allowManagerEdit || user.allowManagerDelete) && (
                          <div className="text-[10px] text-muted-foreground mt-1">
                            {t('agencies.users.managerOverridePrefix')}{' '}
                            {[user.allowManagerEdit && 'edit', user.allowManagerDelete && 'delete'].filter(Boolean).join(' + ')}
                          </div>
                        )}
                      </td>
                      <td className="p-4">
                        <Badge className={user.status === 'ACTIVE' ? 'bg-[#22C55E]' : 'bg-gray-500'}>
                          {user.status}
                        </Badge>
                      </td>
                      <td className="p-4 text-sm text-muted-foreground">
                        {user.lastLoginAt ? formatDate(user.lastLoginAt) : '—'}
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          {isAdmin && user.approvalStatus === 'PENDING_APPROVAL' && (
                            <Button size="sm" onClick={() => handleApprove(user)}>Approve</Button>
                          )}
                          {isAdmin && user.approvalStatus === 'APPROVED' && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => handleManagerOverride(user, { allowManagerEdit: !user.allowManagerEdit })}>
                                {user.allowManagerEdit ? 'Lock edits' : 'Allow edits'}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => handleManagerOverride(user, { allowManagerDelete: !user.allowManagerDelete })}>
                                {user.allowManagerDelete ? 'Lock delete' : 'Allow delete'}
                              </Button>
                            </>
                          )}
                          {(canDelete('users') || can('agencies', 'delete')) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleDeleteUser(user)}
                              className="text-[#EF4444] hover:text-[#EF4444] hover:bg-[#FEF2F2]"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
