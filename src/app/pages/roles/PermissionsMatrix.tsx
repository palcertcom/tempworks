/**
 * Live Permissions Matrix.
 * Reads the actual permission catalog + roles from the backend so it
 * always mirrors the seeded permissions (no more hard-coded mock that
 * drifts from reality). Rows are grouped by module, columns are roles,
 * and each cell renders one tick per action the role actually holds.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Shield, Check, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { rolesApi } from '../../services/api';

type Permission = { id: string; name: string; module: string; action: string };
type Role       = { id: string; name: string; description?: string; permissions?: { name: string }[] };

const MODULE_CATEGORIES: Record<string, string> = {
  dashboard: 'Overview',
  employees: 'People',
  applicants: 'People',
  applications: 'People',
  'job-ads': 'People',
  documents: 'Documents',
  compliance: 'Compliance',
  workflow: 'Workflow',
  agencies: 'Agencies',
  finance: 'Finance',
  attendance: 'Operations',
  vehicles: 'Operations',
  reports: 'Reports',
  notifications: 'System',
  users: 'System',
  roles: 'System',
  settings: 'System',
  logs: 'System',
  'recycle-bin': 'System',
};

const ACTION_ORDER = ['read', 'create', 'update', 'delete', 'export', 'approve', 'verify', 'resolve', 'convert', 'bulk-action', 'override', 'status', 'restore', 'publish', 'manage-permissions', 'manage-agency-access'];
const sortActions = (a: string, b: string) => {
  const ai = ACTION_ORDER.indexOf(a); const bi = ACTION_ORDER.indexOf(b);
  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
};

const ROLE_COLOR: Record<string, string> = {
  'System Admin':        '#2563EB',
  'HR Manager':          '#22C55E',
  'Compliance Officer':  '#F59E0B',
  'Recruiter':           '#8B5CF6',
  'Agency Manager':      '#EC4899',
  'Agency User':         '#06B6D4',
  'Finance':             '#0EA5E9',
  'Read Only':           '#64748B',
};

const humanizeAction = (action: string) => action.replace(/-/g, ' ');
const humanizeModule = (mod: string) =>
  mod.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function PermissionsMatrix() {
  const { t } = useTranslation('pages');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [roles, setRoles]             = useState<Role[]>([]);
  const [loading, setLoading]         = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Roles come back with .permissions[] already. Fetch full permission
        // catalog separately so we include rows no role currently holds.
        const [rolesResp, permsResp] = await Promise.all([
          rolesApi.list(),
          rolesApi.getPermissions(),
        ]);
        setRoles(Array.isArray(rolesResp) ? rolesResp : []);
        setPermissions(Array.isArray(permsResp) ? permsResp : []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Group permissions by module → action set.
  const byModule = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of permissions) {
      const arr = map.get(p.module) ?? [];
      if (!arr.includes(p.action)) arr.push(p.action);
      map.set(p.module, arr);
    }
    for (const [, arr] of map) arr.sort(sortActions);
    return map;
  }, [permissions]);

  // Group modules by UI category so the table has section rows.
  const groupedModules = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const mod of byModule.keys()) {
      const cat = MODULE_CATEGORIES[mod] ?? 'Other';
      (out[cat] ??= []).push(mod);
    }
    for (const cat of Object.keys(out)) out[cat].sort();
    return out;
  }, [byModule]);

  const rolePermNames = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of roles) {
      m.set(r.id, new Set((r.permissions ?? []).map(p => p.name)));
    }
    return m;
  }, [roles]);

  const orderedRoles = useMemo(() => {
    const order = ['System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Agency Manager', 'Agency User', 'Finance', 'Read Only'];
    return [...roles].sort((a, b) => {
      const ai = order.indexOf(a.name); const bi = order.indexOf(b.name);
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [roles]);

  if (loading) {
    return <div className="p-8 text-muted-foreground">{t('roles.matrix.loading')}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/roles"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('roles.matrix.header')}</h1>
          <p className="text-muted-foreground mt-1">
            {t('roles.matrix.subtitle')}
          </p>
        </div>
      </div>

      {/* Role legend */}
      <Card>
        <CardHeader><CardTitle>{t('roles.matrix.rolesCardTitle')}</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {orderedRoles.map(role => (
              <Badge
                key={role.id}
                variant="outline"
                className="px-3 py-1.5"
                style={{ borderColor: ROLE_COLOR[role.name] ?? '#64748B', color: ROLE_COLOR[role.name] ?? '#64748B' }}
              >
                {role.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Matrix */}
      <Card>
        <CardHeader>
          <CardTitle>{t('roles.matrix.matrixCardTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            <Check className="w-4 h-4 inline text-[#22C55E]" /> {t('roles.matrix.legendGranted')} &nbsp;•&nbsp;
            <Minus className="w-4 h-4 inline text-[#CBD5E1]" /> {t('roles.matrix.legendDenied')}
          </p>
        </CardHeader>
        <CardContent>
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full min-w-[1200px] text-sm">
              <thead className="bg-[#F8FAFC] border-b sticky top-0 z-10">
                <tr>
                  <th className="text-start p-4 font-semibold sticky start-0 bg-[#F8FAFC] z-20 min-w-[220px]">{t('roles.matrix.moduleAction')}</th>
                  {orderedRoles.map(role => (
                    <th key={role.id} className="p-2 text-center font-semibold">
                      <Badge variant="outline" style={{ borderColor: ROLE_COLOR[role.name] ?? '#64748B', color: ROLE_COLOR[role.name] ?? '#64748B' }}>
                        {role.name}
                      </Badge>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(groupedModules).map(([category, mods]) => (
                  <>
                    <tr key={`cat-${category}`} className="bg-[#F1F5F9]">
                      <td colSpan={orderedRoles.length + 1} className="p-2 font-semibold text-xs text-[#475569] uppercase tracking-wide">
                        {category}
                      </td>
                    </tr>
                    {mods.map(mod => (
                      <>
                        <tr key={`mod-${mod}`} className="bg-white">
                          <td className="p-3 sticky start-0 bg-white border-t">
                            <div className="flex items-center gap-2">
                              <Shield className="w-4 h-4 text-muted-foreground" />
                              <span className="font-semibold">{humanizeModule(mod)}</span>
                              <span className="text-xs text-muted-foreground font-mono">{mod}</span>
                            </div>
                          </td>
                          {orderedRoles.map(role => <td key={role.id} className="border-t" />)}
                        </tr>
                        {(byModule.get(mod) ?? []).map(action => {
                          const permName = `${mod}:${action}`;
                          return (
                            <tr key={permName} className="border-t hover:bg-[#F8FAFC]">
                              <td className="p-2 ps-10 sticky start-0 bg-white">
                                <span className="text-xs capitalize text-[#334155]">{humanizeAction(action)}</span>
                                <span className="ms-2 text-[10px] text-muted-foreground font-mono">{permName}</span>
                              </td>
                              {orderedRoles.map(role => {
                                const has = rolePermNames.get(role.id)?.has(permName);
                                return (
                                  <td key={role.id} className="text-center p-2">
                                    {has
                                      ? <Check className="w-4 h-4 text-[#22C55E] inline" />
                                      : <Minus className="w-4 h-4 text-[#CBD5E1] inline" />}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
