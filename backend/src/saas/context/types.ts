/**
 * Snapshots stored inside the request-scoped AsyncLocalStorage frame.
 *
 * These are immutable VIEWS, not live entities — the request must NOT cache
 * decisions across requests by holding references to them.
 */

export interface TenantSnapshot {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  readonly region: string;
}

export interface UserSnapshot {
  readonly id: string;
  readonly email: string;
  readonly membershipId?: string;
  readonly permissions: ReadonlyArray<string>;
  readonly agencyIds: ReadonlyArray<string>;
  /** True only for platform-admin sessions with fresh step-up MFA. */
  readonly platformAdmin: boolean;
}

export interface RequestContext {
  readonly requestId: string;
  tenant?: TenantSnapshot;
  user?: UserSnapshot;
}
