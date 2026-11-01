/**
 * `/api/v1/bootstrap` response contract.
 *
 * Stable shape expected by the frontend `TenantProvider` (Phase 4).
 * Phase 0: types only; no controller. Phase 4 implements.
 *
 * Adding fields is additive; renames/removals are breaking. Consumers
 * are expected to ignore unknown fields gracefully.
 */

export interface BootstrapTenant {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  region: string;
  branding: BootstrapBranding | null;
  locale: BootstrapLocale;
  /** Whitelisted feature flags surfaced to the client. */
  featureFlags: Readonly<Record<string, boolean>>;
}

export interface BootstrapBranding {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  supportEmail?: string;
  emailFromName?: string;
}

export interface BootstrapLocale {
  default: string;
  supported: ReadonlyArray<string>;
  rtl: boolean;
}

export interface BootstrapMembership {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  /** Public host this tenant is reachable on (`<slug>.app.tempworks.com`). */
  host: string;
  /** Membership status; UI hides anything not ACTIVE. */
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
}

export interface BootstrapActiveMembership {
  id: string;
  roles: ReadonlyArray<string>;          // role keys, e.g. 'tenant.admin'
  permissions: ReadonlyArray<string>;    // 'candidates:read'
  agencies: ReadonlyArray<{ id: string; name: string; scope: 'FULL' | 'READ_ONLY' | 'RECRUITER_ONLY' }>;
}

export interface BootstrapUser {
  id: string;
  email: string;
  fullName: string;
  mfaEnabled: boolean;
}

export interface BootstrapResponse {
  tenant:      BootstrapTenant;
  user:        BootstrapUser;
  membership:  BootstrapActiveMembership;
  /** All tenants the user can switch into. */
  memberships: ReadonlyArray<BootstrapMembership>;
  /** Server time at issuance — frontend compares against `Date.now()` for clock drift. */
  serverTime:  number;
}

/** Whitelisted flag keys safe to surface to the browser. */
export const PUBLIC_FLAG_KEYS: ReadonlyArray<string> = [
  'TENANT_SWITCHING_ENABLED',
  'SIGNED_URLS_ENABLED',
];
