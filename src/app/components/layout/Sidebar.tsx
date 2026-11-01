import { Link, useLocation } from 'react-router';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Users,
  FolderOpen,
  Layers,
  Building2,
  BarChart3,
  Bell,
  UserCog,
  Settings,
  Shield,
  FileSearch,
  Activity,
  Briefcase,
  UserCheck,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  DollarSign,
  Megaphone,
  Trash2,
  ClipboardList,
  Truck,
  Wrench,
  Factory,
  Globe,
} from 'lucide-react';
import { cn } from '../ui/utils';
import { useAuthContext } from '../../contexts/AuthContext';
import { resolveAssetUrl, getCurrentUser, authApi, type AuthUser } from '../../services/api';
import { useBranding } from '../../hooks/useBranding';

interface NavChild {
  icon: React.ElementType;
  labelKey: string;
  path: string;
}

interface NavItem {
  icon: React.ElementType;
  labelKey: string;
  path: string;
  permission: string | null;
  roles?: string[];
  /** Hide this item for users whose role is in this list, regardless of permissions. */
  hideForRoles?: string[];
  children?: NavChild[];
  /**
   * Phase 3.15 — restrict to PlatformAdmin viewers of at least this level.
   * Bypasses the role/permission filter entirely. Non-PlatformAdmin users
   * never see the item.
   */
  platformAdminLevel?: 'SUPPORT' | 'OPERATOR' | 'SUPER';
}

// External agency roles — must not see the Leads nav.
const AGENCY_ROLES = ['Agency User', 'Agency Manager'];

// Each nav item declares which permission (module:read) is required to see it.
// null means always visible to any authenticated user.
// labelKey is resolved against the `nav` namespace at render time.
const allNavigationItems: NavItem[] = [
  { icon: LayoutDashboard, labelKey: 'dashboard',           path: '/dashboard',                  permission: 'dashboard:read' },
  { icon: UserCheck,       labelKey: 'applicants',          path: '/dashboard/applicants',       permission: 'applicants:read' },
  { icon: UserCheck,       labelKey: 'candidates',          path: '/dashboard/candidates',       permission: 'applicants:read' },
  { icon: Users,           labelKey: 'employees',           path: '/dashboard/employees',        permission: 'employees:read' },
  { icon: ClipboardList,   labelKey: 'attendanceSheets',    path: '/dashboard/attendance',       permission: 'attendance:read' },
  {
    icon: Truck, labelKey: 'vehicles', path: '/dashboard/vehicles', permission: 'vehicles:read',
    children: [
      { icon: Truck,   labelKey: 'fleet',               path: '/dashboard/vehicles' },
      { icon: Factory, labelKey: 'workshops',           path: '/dashboard/vehicles/workshops' },
      { icon: Wrench,  labelKey: 'maintenanceRecords',  path: '/dashboard/vehicles/maintenance-records' },
    ],
  },
  { icon: FolderOpen,      labelKey: 'documentsCompliance', path: '/dashboard/documents-compliance', permission: 'documents:read' },
  { icon: FileSearch,      labelKey: 'documentExplorer',    path: '/dashboard/document-explorer',permission: 'documents:read' },
  { icon: Layers,          labelKey: 'workflows',           path: '/dashboard/workflows',        permission: 'workflow:read' },
  { icon: Building2,       labelKey: 'agencies',            path: '/dashboard/agencies',         permission: 'agencies:read' },
  { icon: BarChart3,       labelKey: 'reports',             path: '/dashboard/reports',          permission: 'reports:read' },
  { icon: DollarSign,      labelKey: 'finance',             path: '/dashboard/finance',          permission: 'finance:read', roles: ['System Admin', 'HR Manager', 'Finance', 'Recruiter'], hideForRoles: AGENCY_ROLES },
  { icon: Megaphone,       labelKey: 'jobAds',              path: '/dashboard/job-ads',          permission: 'job-ads:read', roles: ['System Admin', 'HR Manager', 'Recruiter'] },
  { icon: Bell,            labelKey: 'notifications',       path: '/dashboard/notifications',    permission: 'notifications:read' },
  { icon: UserCog,         labelKey: 'users',               path: '/dashboard/users',            permission: 'users:read' },
  { icon: Shield,          labelKey: 'rolesPermissions',    path: '/dashboard/roles',            permission: 'roles:read' },
  { icon: Activity,        labelKey: 'systemLogs',          path: '/dashboard/logs',             permission: 'logs:read' },
  { icon: Trash2,          labelKey: 'deletedRecords',      path: '/dashboard/recycle-bin',      permission: 'recycle-bin:read', roles: ['System Admin', 'HR Manager', 'Compliance Officer'], hideForRoles: AGENCY_ROLES },
  { icon: Settings,        labelKey: 'settings',            path: '/dashboard/settings',         permission: 'settings:read' },
  // Phase 3.15 — Platform Administration > Tenants. Visible only to
  // PlatformAdmin viewers (SUPPORT+). SUPPORT is read-only; OPERATOR
  // can update/archive; SUPER can create/delete/restore. Hidden for
  // every non-PlatformAdmin user regardless of tenant role.
  { icon: Globe,           labelKey: 'tenants',             path: '/dashboard/tenants',          permission: null, platformAdminLevel: 'SUPPORT' },
  // Phase 3.17 — "Tenant Members" for in-tenant System Admins. PlatformAdmin
  // viewers already have the full Tenants admin above; this entry only
  // surfaces for System Admins who are not PlatformAdmin.
  { icon: UserCog,         labelKey: 'tenantMembers',       path: '/dashboard/tenant-members',   permission: null, roles: ['System Admin'], hideForRoles: AGENCY_ROLES },
];

const PA_RANK: Record<string, number> = { NONE: 0, SUPPORT: 1, OPERATOR: 2, SUPER: 3 };

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
  const location = useLocation();
  const { user: ctxUser } = useAuthContext();
  const branding = useBranding();
  const { t } = useTranslation('nav');

  // Fallback to localStorage + live /auth/me when AuthContext hasn't populated
  // yet. Keeps the sidebar's nav filter and user block in sync with the Topbar,
  // which uses its own local state fetched via authApi.me().
  const [localUser, setLocalUser] = useState<AuthUser | null>(() => getCurrentUser());
  useEffect(() => {
    authApi.me()
      .then((fresh) => { if (fresh) setLocalUser(fresh); })
      .catch(() => {});
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'current_user') setLocalUser(getCurrentUser());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const user = ctxUser ?? localUser;
  const userRole = user?.role ?? '';
  const permissions = user?.permissions ?? [];
  const isAdmin = userRole === 'System Admin';

  const viewerPaLevel = (user as any)?.platformAdmin?.level ?? 'NONE';

  const navigationItems = allNavigationItems.filter((item) => {
    // Phase 3.15 — PlatformAdmin-gated items bypass the tenant role/
    // permission filter entirely; they are visible only to a viewer
    // whose PlatformAdmin level meets the threshold.
    if (item.platformAdminLevel) {
      return PA_RANK[viewerPaLevel] >= PA_RANK[item.platformAdminLevel];
    }
    // Role-based blocklist takes precedence — agency users must never see
    // internal-only items (e.g. Leads) even if their permission set allows it.
    if (item.hideForRoles && item.hideForRoles.includes(userRole)) return false;
    if (!item.permission) {
      // No permission gate — respect the role allow-list when present so
      // entries like "Tenant Members" can be limited to System Admin.
      if (item.roles) return item.roles.includes(userRole);
      return true;
    }
    if (isAdmin) return true;
    if (item.roles && item.roles.includes(userRole)) return true;
    return permissions.includes(item.permission);
  });

  // Track which parent items have their sub-nav expanded.
  // Auto-expand if any child path is currently active.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const item of allNavigationItems) {
      if (item.children?.some((c) => location.pathname.startsWith(c.path) && c.path !== item.path)) {
        init[item.path] = true;
      }
    }
    return init;
  });

  const toggleExpand = (path: string) => setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));

  return (
    <aside
      className={cn(
        "bg-sidebar border-e border-sidebar-border flex flex-col transition-all duration-300 ease-in-out relative",
        isCollapsed ? "w-20" : "w-64"
      )}
    >
      {/* Logo Section */}
      <div className="p-6 border-b border-sidebar-border">
        <div className={cn(
          "flex items-center gap-3 mb-2",
          isCollapsed && "justify-center"
        )}>
          <div className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden",
            branding.logoUrl ? "bg-transparent" : "bg-primary"
          )}>
            {branding.logoUrl ? (
              <img
                src={resolveAssetUrl(branding.logoUrl)}
                alt="Logo"
                className="w-full h-full object-contain"
              />
            ) : (
              <Briefcase className="w-6 h-6 text-primary-foreground" />
            )}
          </div>
          {!isCollapsed && (
            <div>
              <h1 className="text-lg font-bold text-sidebar-foreground">
                {branding.companyName}
              </h1>
              <p className="text-xs text-muted-foreground">{branding.tagline || t('sidebar.platformLabel')}</p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-4">
        <ul className="space-y-1">
          {navigationItems.map((item) => {
            const hasChildren = !!item.children?.length;
            const isParentActive = location.pathname === item.path ||
              (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
            const isOpen = expanded[item.path] ?? false;

            return (
              <li key={item.path}>
                {/* Parent row */}
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggleExpand(item.path)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors relative group",
                      isParentActive
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      isCollapsed && "justify-center",
                    )}
                    title={isCollapsed ? t(item.labelKey) : undefined}
                  >
                    <item.icon className="w-5 h-5 flex-shrink-0" />
                    {!isCollapsed && (
                      <>
                        <span className="text-sm flex-1 text-start">{t(item.labelKey)}</span>
                        <ChevronDown className={cn("w-4 h-4 transition-transform", isOpen && "rotate-180")} />
                      </>
                    )}
                    {isCollapsed && (
                      <div className="absolute start-full ms-2 px-3 py-2 bg-popover text-popover-foreground border border-border text-sm rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 whitespace-nowrap z-50">
                        {t(item.labelKey)}
                        <div className="absolute start-0 top-1/2 -translate-y-1/2 -translate-x-1 rtl:translate-x-1 w-2 h-2 bg-popover rotate-45 border-s border-b border-border" />
                      </div>
                    )}
                  </button>
                ) : (
                  <Link
                    to={item.path}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors relative group",
                      isParentActive
                        ? "bg-primary text-primary-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      isCollapsed && "justify-center",
                    )}
                    title={isCollapsed ? t(item.labelKey) : undefined}
                  >
                    <item.icon className="w-5 h-5 flex-shrink-0" />
                    {!isCollapsed && <span className="text-sm">{t(item.labelKey)}</span>}
                    {isCollapsed && (
                      <div className="absolute start-full ms-2 px-3 py-2 bg-popover text-popover-foreground border border-border text-sm rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 whitespace-nowrap z-50">
                        {t(item.labelKey)}
                        <div className="absolute start-0 top-1/2 -translate-y-1/2 -translate-x-1 rtl:translate-x-1 w-2 h-2 bg-popover rotate-45 border-s border-b border-border" />
                      </div>
                    )}
                  </Link>
                )}

                {/* Sub-nav children */}
                {hasChildren && (isOpen || isCollapsed) && (
                  <ul className={cn("mt-1 space-y-0.5", !isCollapsed && "ps-4")}>
                    {item.children!.map((child) => {
                      const childActive = child.path === item.path
                        ? location.pathname === child.path
                        : location.pathname.startsWith(child.path);
                      return (
                        <li key={child.path}>
                          <Link
                            to={child.path}
                            className={cn(
                              "flex items-center gap-3 px-3 py-1.5 rounded-lg transition-colors relative group text-sm",
                              childActive
                                ? "bg-primary text-primary-foreground"
                                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                              isCollapsed && "justify-center px-2",
                            )}
                            title={isCollapsed ? t(child.labelKey) : undefined}
                          >
                            <child.icon className="w-4 h-4 flex-shrink-0" />
                            {!isCollapsed && <span>{t(child.labelKey)}</span>}
                            {isCollapsed && (
                              <div className="absolute start-full ms-2 px-3 py-2 bg-popover text-popover-foreground border border-border text-sm rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 whitespace-nowrap z-50">
                                {t(child.labelKey)}
                                <div className="absolute start-0 top-1/2 -translate-y-1/2 -translate-x-1 rtl:translate-x-1 w-2 h-2 bg-popover rotate-45 border-s border-b border-border" />
                              </div>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User Section */}
      <div className="p-4 border-t border-sidebar-border">
        <div className={cn(
          "flex items-center gap-3 p-3 rounded-lg bg-sidebar-accent",
          isCollapsed && "justify-center"
        )}>
          {user?.photoUrl ? (
            <img
              src={resolveAssetUrl(user.photoUrl)}
              alt="User"
              className="w-8 h-8 rounded-full flex-shrink-0 object-cover"
            />
          ) : (
            <div
              className="w-8 h-8 rounded-full flex-shrink-0 bg-[#EFF6FF] flex items-center justify-center text-[#2563EB] text-xs font-bold"
              aria-label={user ? `${user.firstName} ${user.lastName}` : 'User'}
            >
              {`${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() || '?'}
            </div>
          )}
          {!isCollapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">
                {user ? `${user.firstName} ${user.lastName}` : 'User'}
              </p>
              <p className="text-xs text-muted-foreground truncate">{userRole || 'Guest'}</p>
            </div>
          )}
        </div>
      </div>

      {/* Toggle Button */}
      <button
        onClick={onToggle}
        className="absolute -end-3 top-20 w-6 h-6 rounded-full bg-sidebar border border-sidebar-border flex items-center justify-center text-muted-foreground hover:text-primary hover:border-primary transition-colors shadow-sm z-10"
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {isCollapsed ? (
          <ChevronRight className="w-4 h-4 rtl:rotate-180" />
        ) : (
          <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
        )}
      </button>
    </aside>
  );
}