import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { getCurrentUser } from '../services/api';

/**
 * Phase 2B (#5) — Tenant-switch refetch coordinator.
 *
 * The topbar tenant switcher updates the JWT and the cached user.
 * Components that fetch tenant-scoped data subscribe to
 * `useTenantSyncVersion()` and include it in their fetch effect's
 * dependency list — when the topbar bumps the version, every subscriber's
 * `useCallback`/`useEffect` is re-evaluated and the data is refetched
 * against the new tenant. No React Query yet (that's a separate phase);
 * this is the smallest mechanism that gets the right behaviour.
 *
 * `activeTenantId` mirrors the JWT and is provided so components that
 * need the value (not just a refetch trigger) can read it without
 * touching localStorage on every render.
 */
interface TenantSyncValue {
  activeTenantId: string | null;
  /** Monotonic counter — bumped on every tenant switch. */
  version: number;
  /** Called by the topbar after a successful /auth/switch-tenant. */
  bump: (nextTenantId: string | null) => void;
}

const Ctx = createContext<TenantSyncValue | null>(null);

function readActiveTenantId(): string | null {
  return (getCurrentUser() as any)?.activeTenantId ?? (getCurrentUser() as any)?.primaryTenantId ?? null;
}

export function TenantSyncProvider({ children }: { children: ReactNode }) {
  const [activeTenantId, setActiveTenantId] = useState<string | null>(readActiveTenantId());
  const [version, setVersion] = useState(0);
  const bump = useCallback((next: string | null) => {
    setActiveTenantId(next);
    setVersion((v) => v + 1);
  }, []);
  return <Ctx.Provider value={{ activeTenantId, version, bump }}>{children}</Ctx.Provider>;
}

/** Counter that bumps on every tenant switch. Include in fetch deps to refetch. */
export function useTenantSyncVersion(): number {
  return useContext(Ctx)?.version ?? 0;
}

/** Current active tenantId (mirror of the JWT). */
export function useActiveTenantId(): string | null {
  return useContext(Ctx)?.activeTenantId ?? null;
}

/** Internal — only the topbar should call this. */
export function useTenantSyncBump(): (id: string | null) => void {
  return useContext(Ctx)?.bump ?? (() => undefined);
}
