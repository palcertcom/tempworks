import { useAuthContext } from '../contexts/AuthContext';
import { getCurrentUser } from '../services/api';

/**
 * Provides permission helpers based on the current user's permissions array.
 * Permissions are stored as "module:action" strings (e.g. "employees:create").
 * System Admins bypass all permission checks.
 * Reads from reactive AuthContext so changes reflect immediately on re-render,
 * with a localStorage fallback so admin-gated UI doesn't briefly hide on a
 * hard reload while /auth/me is in-flight (mirrors the Sidebar's pattern).
 */
export function usePermissions() {
  const { user: ctxUser } = useAuthContext();
  const user = ctxUser ?? getCurrentUser();
  const permissions = user?.permissions ?? [];

  // `role` is expected to be the string 'System Admin' coming from
  // /auth/me, but in older stored sessions (and via a couple of other
  // endpoints that include the full role relation) it can land on the
  // client as `{ id, name }`. Normalise both shapes, trim whitespace
  // and compare case-insensitively so a System Admin never gets
  // Access Denied on an edit page just because their cached user
  // object came in a slightly different shape.
  const rawRole: any = (user as any)?.role;
  const roleName: string = typeof rawRole === 'string'
    ? rawRole
    : (rawRole?.name ?? '');
  const normalised = roleName.trim().toLowerCase();
  const isAdmin = normalised === 'system admin' || normalised === 'systemadmin';

  const can = (module: string, action: string): boolean => {
    if (!user) return false;
    if (isAdmin) return true;
    return permissions.includes(`${module}:${action}`);
  };

  return {
    canView: (module: string) => can(module, 'read'),
    canCreate: (module: string) => can(module, 'create'),
    canEdit: (module: string) => can(module, 'update'),
    canDelete: (module: string) => can(module, 'delete'),
    can,
  };
}
