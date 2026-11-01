/**
 * Phase 2.2 — Tenant Resolver.
 *
 * Resolves an active tenant for a request via, in order:
 *   1. Explicit `X-Tenant-Id` header (staging only — refused outside).
 *   2. Custom domain match against `tenant_domains.host`.
 *   3. Subdomain match against `tenants.slug` (host = `<slug>.<base>`).
 *   4. Legacy fallback: lookup `agencies.tenantId` from the
 *      authenticated user's `agencyId` (set by the existing auth guard).
 *
 * Returns `null` if nothing matched. The middleware decides whether to
 * fail loud or continue based on flags.
 *
 * All Prisma access goes through the existing `PrismaService` (the
 * tables are NEW — they don't conflict with the legacy code path).
 * `// @tenant-reviewed: tenant-resolver-bootstrap` annotates the
 * direct prisma calls.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { TenantSnapshot } from '../context/types';
import { classifyRuntimeEnv, isStagingClassification } from './env-safety';

export interface TenantResolutionRequest {
  /** Hostname from the request. */
  host?: string;
  /** Raw `X-Tenant-Id` header value. */
  headerTenantId?: string;
  /** From the existing auth guard (`req.user.agencyId`). */
  legacyAgencyId?: string;
}

export interface TenantResolution {
  tenant: TenantSnapshot | null;
  /** Which strategy yielded the snapshot ('header', 'custom-domain', 'subdomain', 'legacy-agency', 'none'). */
  method: 'header' | 'custom-domain' | 'subdomain' | 'legacy-agency' | 'none';
  /** Diagnostic note suitable for the /context endpoint. */
  detail?: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger('TenantResolverService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
  ) {}

  async resolve(req: TenantResolutionRequest): Promise<TenantResolution> {
    if (!this.flags.multiTenantEnabled()) {
      return { tenant: null, method: 'none', detail: 'MULTI_TENANT_ENABLED=false' };
    }

    // 1. Header (staging only) ----------------------------------------
    if (req.headerTenantId) {
      const env = classifyRuntimeEnv();
      if (!isStagingClassification(env.classification)) {
        // Production / unknown: silently ignore the header. Production
        // resolution must come from host or auth, never from a client-
        // supplied id.
        this.logger.warn(
          `X-Tenant-Id header ignored — env=${env.classification}: ${env.reason}`,
        );
      } else if (UUID_RE.test(req.headerTenantId)) {
        const t = await this.findById(req.headerTenantId);
        if (t) return { tenant: t, method: 'header', detail: 'X-Tenant-Id (staging)' };
      }
    }

    // 2. Custom domain ------------------------------------------------
    if (req.host) {
      const lower = req.host.toLowerCase();
      // @tenant-reviewed: tenant-resolver-bootstrap (reads global tenant_domains)
      const domain = await this.prisma.tenantDomain
        .findFirst({ where: { host: lower } })
        .catch(() => null);
      if (domain) {
        const t = await this.findById(domain.tenantId);
        if (t) return { tenant: t, method: 'custom-domain', detail: lower };
      }

      // 3. Subdomain --------------------------------------------------
      const sub = lower.split('.')[0];
      if (sub && SLUG_RE.test(sub) && sub !== 'www' && sub !== 'api') {
        // @tenant-reviewed: tenant-resolver-bootstrap (reads global tenants)
        const tenant = await this.prisma.tenant
          .findFirst({ where: { slug: sub } })
          .catch(() => null);
        if (tenant) {
          const snap = this.toSnapshot(tenant);
          if (snap) return { tenant: snap, method: 'subdomain', detail: sub };
        }
      }
    }

    // 4. Legacy agency fallback --------------------------------------
    if (req.legacyAgencyId) {
      // @tenant-reviewed: tenant-resolver-bootstrap (reads global agencies)
      const agency = await this.prisma.agency
        .findFirst({
          where: { id: req.legacyAgencyId },
          select: { id: true, tenantId: true },
        })
        .catch(() => null);
      if (agency?.tenantId) {
        const t = await this.findById(agency.tenantId);
        if (t) return { tenant: t, method: 'legacy-agency', detail: agency.tenantId };
      }
    }

    return { tenant: null, method: 'none', detail: 'no resolution strategy matched' };
  }

  /** Public read for diagnostics + tests. */
  async findById(tenantId: string): Promise<TenantSnapshot | null> {
    if (!UUID_RE.test(tenantId)) return null;
    // @tenant-reviewed: tenant-resolver-bootstrap (reads global tenants)
    const t = await this.prisma.tenant.findFirst({ where: { id: tenantId } }).catch(() => null);
    return this.toSnapshot(t);
  }

  private toSnapshot(t: any): TenantSnapshot | null {
    if (!t) return null;
    if (t.status !== 'ACTIVE') return null;
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status as TenantSnapshot['status'],
      region: t.region ?? 'eu',
    };
  }
}
