import { SetMetadata } from '@nestjs/common';

/**
 * Attach one or more permission keys (e.g. `applicants:update`) to a
 * controller method. The RolesGuard allows the request when the user
 * holds ANY of the listed permissions — independent of role name.
 *
 * Use alongside or instead of `@Roles(...)`. A request is allowed when
 * either constraint is satisfied, so granular permission grants via the
 * Roles UI take effect immediately without editing controller decorators.
 */
export const PERMISSIONS_KEY = 'permissions';
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
