import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save, Shield, ShieldOff } from 'lucide-react';
import { usePermissions } from '../../hooks/usePermissions';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Checkbox } from '../../components/ui/checkbox';
import { toast } from 'sonner';
import { rolesApi } from '../../services/api';

const ACTIONS = ['read', 'create', 'update', 'delete'] as const;
type Action = typeof ACTIONS[number];

const ACTION_LABEL_KEYS: Record<Action, string> = {
  read: 'roles.create.actionView',
  create: 'roles.create.actionCreate',
  update: 'roles.create.actionEdit',
  delete: 'roles.create.actionDelete',
};

export function CreateRole() {
  const { t } = useTranslation('pages');
  const { id } = useParams();
  const isEditMode = !!id;
  const navigate = useNavigate();
  const { canCreate, canEdit } = usePermissions();

  const [roleName, setRoleName] = useState('');
  const [description, setDescription] = useState('');
  const [allPermissions, setAllPermissions] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSystem, setIsSystem] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const fetches = isEditMode
      ? Promise.all([rolesApi.getPermissions(), rolesApi.get(id!)])
      : Promise.all([rolesApi.getPermissions(), Promise.resolve(null)]);

    fetches
      .then(([perms, role]) => {
        setAllPermissions(Array.isArray(perms) ? perms : []);
        if (role) {
          setRoleName(role.name ?? '');
          setDescription(role.description ?? '');
          setIsSystem(role.isSystem ?? false);
          const ids = (role.permissions ?? []).map((rp: any) => rp.permissionId as string);
          setSelectedIds(new Set(ids));
        }
      })
      .catch(() => {
        if (isEditMode) setNotFound(true);
        else toast.error(t('roles.create.loadPermissionsFailed'));
      })
      .finally(() => setLoading(false));
  }, [id]);

  // Build module → action → permissionId lookup
  const permMap: Record<string, Partial<Record<Action, string>>> = {};
  allPermissions.forEach((p: any) => {
    if (!permMap[p.module]) permMap[p.module] = {};
    permMap[p.module][p.action as Action] = p.id;
  });

  const modules = Object.keys(permMap).sort();

  const togglePermission = (permId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(permId) ? next.delete(permId) : next.add(permId);
      return next;
    });
  };

  const handleSelectAllAction = (action: Action) => {
    const actionIds = allPermissions.filter(p => p.action === action).map(p => p.id as string);
    const allChecked = actionIds.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      actionIds.forEach(pid => allChecked ? next.delete(pid) : next.add(pid));
      return next;
    });
  };

  const handleSelectAllModule = (module: string) => {
    const moduleIds = Object.values(permMap[module] ?? {}).filter(Boolean) as string[];
    const allChecked = moduleIds.every(pid => selectedIds.has(pid));
    setSelectedIds(prev => {
      const next = new Set(prev);
      moduleIds.forEach(pid => allChecked ? next.delete(pid) : next.add(pid));
      return next;
    });
  };

  const isActionAllChecked = (action: Action) =>
    allPermissions.filter(p => p.action === action).every(p => selectedIds.has(p.id));

  const isModuleAllChecked = (module: string) => {
    const ids = Object.values(permMap[module] ?? {}).filter(Boolean) as string[];
    return ids.length > 0 && ids.every(pid => selectedIds.has(pid));
  };

  const handleSave = async () => {
    if (!roleName.trim()) {
      toast.error(t('roles.create.roleNameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const payload: { name?: string; description?: string; permissionIds: string[] } = {
        permissionIds: Array.from(selectedIds),
      };
      if (!isSystem) {
        payload.name = roleName.trim();
        payload.description = description.trim();
      }
      if (isEditMode) {
        await rolesApi.update(id!, payload);
        toast.success(t('roles.create.updateSuccess'));
      } else {
        await rolesApi.create(payload);
        toast.success(t('roles.create.createSuccess'));
      }
      navigate('/dashboard/roles');
    } catch (err: any) {
      toast.error(err?.message || (isEditMode ? t('roles.create.updateFailed') : t('roles.create.createFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8 text-muted-foreground">{t('roles.create.loading')}</div>;
  if (notFound) return <div className="p-8">{t('roles.create.notFound')}</div>;

  if (isEditMode ? !canEdit('roles') : !canCreate('roles')) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
        <ShieldOff className="w-12 h-12 opacity-30" />
        <p className="text-lg font-semibold text-[#0F172A]">{t('roles.create.accessDenied')}</p>
        <p className="text-sm">{t('roles.create.accessDeniedBody')}</p>
      </div>
    );
  }

  // Group modules by category using their first segment (fallback to module name)
  const groupedModules = modules.reduce((acc, mod) => {
    // Capitalize first letter as category label
    const category = mod.charAt(0).toUpperCase() + mod.slice(1);
    if (!acc[category]) acc[category] = [];
    acc[category].push(mod);
    return acc;
  }, {} as Record<string, string[]>);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/roles">
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">
            {isEditMode ? t('roles.create.editTitle') : t('roles.create.createNewTitle')}
          </h1>
          <p className="text-muted-foreground mt-1">
            {isEditMode ? t('roles.create.editSubtitle') : t('roles.create.createSubtitle')}
          </p>
        </div>
        <Button onClick={handleSave} disabled={submitting}>
          <Save className="w-4 h-4 me-2" />
          {submitting ? t('roles.create.saving') : isEditMode ? t('roles.create.saveChanges') : t('roles.create.createRole')}
        </Button>
      </div>

      {/* Role Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle>{t('roles.create.roleInfo')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="roleName">{t('roles.create.roleName')}</Label>
            <Input
              id="roleName"
              placeholder={t('roles.create.rolePlaceholder')}
              value={roleName}
              onChange={(e) => setRoleName(e.target.value)}
              className="mt-1.5"
              readOnly={isSystem}
              disabled={isSystem}
            />
          </div>
          <div>
            <Label htmlFor="description">{t('roles.create.description')}</Label>
            <Input
              id="description"
              placeholder={t('roles.create.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              readOnly={isSystem}
              disabled={isSystem}
              className="mt-1.5"
            />
          </div>
        </CardContent>
      </Card>

      {/* Permissions Matrix */}
      <Card>
        <CardHeader>
          <CardTitle>{t('roles.create.permissions')}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {t('roles.create.permissionsHelper')}
          </p>
        </CardHeader>
        <CardContent>
          {modules.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('roles.create.noPermissions')}</p>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-[#F8FAFC] border-b">
                  <tr>
                    <th className="text-start p-4 font-semibold text-sm w-1/3">{t('roles.create.module')}</th>
                    {ACTIONS.map(action => (
                      <th key={action} className="text-center p-4 font-semibold text-sm w-1/6">
                        <div className="flex flex-col items-center gap-2">
                          <span>{t(ACTION_LABEL_KEYS[action])}</span>
                          <Checkbox
                            checked={isActionAllChecked(action)}
                            onCheckedChange={() => handleSelectAllAction(action)}
                            className="cursor-pointer"
                          />
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modules.map((mod) => (
                    <tr key={mod} className="border-b hover:bg-[#F8FAFC] transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={isModuleAllChecked(mod)}
                            onCheckedChange={() => handleSelectAllModule(mod)}
                            className="cursor-pointer"
                          />
                          <Shield className="w-4 h-4 text-muted-foreground" />
                          <span className="font-medium capitalize">{mod.replace(/_/g, ' ')}</span>
                        </div>
                      </td>
                      {ACTIONS.map(action => {
                        const permId = permMap[mod]?.[action];
                        return (
                          <td key={action} className="p-4 text-center">
                            {permId ? (
                              <Checkbox
                                checked={selectedIds.has(permId)}
                                onCheckedChange={() => togglePermission(permId)}
                              />
                            ) : (
                              <span className="text-[#E2E8F0]">—</span>
                            )}
                          </td>
                        );
                      })}
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
