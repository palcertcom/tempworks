import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus, Edit, Trash2, Shield, Users, Lock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from 'sonner';
import { rolesApi } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';

export function RolesList() {
  const { t } = useTranslation('pages');
  const { canCreate, canEdit, canDelete } = usePermissions();
  const [roles, setRoles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    rolesApi.list()
      .then((data) => setRoles(Array.isArray(data) ? data : []))
      .catch(() => { setRoles([]); toast.error(t('roles.list.loadFailed')); })
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await rolesApi.delete(deleteTarget.id);
      setRoles(prev => prev.filter(r => r.id !== deleteTarget.id));
      toast.success(t('roles.list.deleteSuccess', { name: deleteTarget.name }));
    } catch (err: any) {
      toast.error(err?.message || t('roles.list.deleteFailed'));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const getPermissionCounts = (role: any) => {
    const perms: any[] = role.permissions ?? [];
    return {
      view: perms.filter((rp: any) => rp.permission?.action === 'read').length,
      create: perms.filter((rp: any) => rp.permission?.action === 'create').length,
      edit: perms.filter((rp: any) => rp.permission?.action === 'edit' || rp.permission?.action === 'update').length,
      delete: perms.filter((rp: any) => rp.permission?.action === 'delete').length,
    };
  };

  const totalUsers = roles.reduce((sum, r) => sum + (r._count?.users ?? 0), 0);

  if (loading) return <div className="p-8 text-muted-foreground">{t('roles.list.loading')}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('roles.list.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('roles.list.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" asChild>
            <Link to="/dashboard/roles/permissions-matrix">
              <Lock className="w-4 h-4 me-2" />
              {t('roles.list.permissionsMatrix')}
            </Link>
          </Button>
          {canCreate('roles') && (
            <Button asChild>
              <Link to="/dashboard/roles/create">
                <Plus className="w-4 h-4 me-2" />
                {t('roles.list.addButton')}
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Shield className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{roles.length}</p>
                <p className="text-sm text-muted-foreground">{t('roles.list.totalRoles')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center">
                <Users className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{totalUsers}</p>
                <p className="text-sm text-muted-foreground">{t('roles.list.totalUsers')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#FEF3C7] flex items-center justify-center">
                <Lock className="w-6 h-6 text-[#F59E0B]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{roles.filter(r => r.isSystem).length}</p>
                <p className="text-sm text-muted-foreground">{t('roles.list.systemRoles')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Shield className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{roles.filter(r => !r.isSystem).length}</p>
                <p className="text-sm text-muted-foreground">{t('roles.list.customRoles')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Roles List */}
      <Card>
        <CardHeader>
          <CardTitle>{t('roles.list.allRoles')}</CardTitle>
        </CardHeader>
        <CardContent>
          {roles.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">{t('roles.list.noRolesFound')}</p>
          ) : (
            <div className="space-y-3">
              {roles.map((role) => {
                const counts = getPermissionCounts(role);
                return (
                  <div
                    key={role.id}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-[#F8FAFC] transition-colors"
                  >
                    <div className="flex items-start gap-4 flex-1">
                      <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center flex-shrink-0">
                        <Shield className="w-6 h-6 text-[#2563EB]" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-[#0F172A]">{role.name}</h3>
                          {role.isSystem && (
                            <Badge variant="outline" className="bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]">
                              {t('roles.list.systemRoleBadge')}
                            </Badge>
                          )}
                          <Badge variant="outline">
                            <Users className="w-3 h-3 me-1" />
                            {t('roles.list.usersCount', { count: role._count?.users ?? 0 })}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mb-3">{role.description || '—'}</p>

                        <div className="grid grid-cols-4 gap-4 text-sm">
                          <div>
                            <p className="text-xs text-muted-foreground">{t('roles.list.permView')}</p>
                            <p className="font-medium">{t('roles.list.modulesCount', { count: counts.view })}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t('roles.list.permCreate')}</p>
                            <p className="font-medium">{t('roles.list.modulesCount', { count: counts.create })}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t('roles.list.permEdit')}</p>
                            <p className="font-medium">{t('roles.list.modulesCount', { count: counts.edit })}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t('roles.list.permDelete')}</p>
                            <p className="font-medium">{t('roles.list.modulesCount', { count: counts.delete })}</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ms-4">
                      {canEdit('roles') && (
                        <Button size="sm" variant="outline" asChild>
                          <Link to={`/dashboard/roles/${role.id}/edit`}>
                            <Edit className="w-4 h-4 me-1" />
                            {t('roles.list.edit')}
                          </Link>
                        </Button>
                      )}
                      {canDelete('roles') && !role.isSystem && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget({ id: role.id, name: role.name })}
                        >
                          <Trash2 className="w-4 h-4 text-[#EF4444]" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('roles.list.deleteRoleTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              <span dangerouslySetInnerHTML={{ __html: t('roles.list.deleteRoleBody', { name: deleteTarget?.name ?? '' }) }} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('roles.list.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-[#EF4444] hover:bg-[#DC2626]"
            >
              {deleting ? t('roles.list.deleting') : t('roles.list.deleteRole')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
