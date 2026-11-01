/**
 * Phase 2.2 — Auth Bridge Interceptor.
 *
 * Runs AFTER the legacy `JwtAuthGuard` has populated `req.user` with
 * the existing JWT claims (`id`, `email`, `roleId`, `agencyId`,
 * `agencyIsSystem`, …). The interceptor maps that into the SaaS
 * `UserContext` shape inside the ALS frame opened by
 * `TenantContextMiddleware`.
 *
 * Contract:
 *   - `MULTI_TENANT_ENABLED=false` → no-op pass-through (the existing
 *     `req.user` is unchanged; UserContext stays unset).
 *   - `MULTI_TENANT_ENABLED=true` and we're in a SAFE_* env:
 *       * read req.user
 *       * map agencyId → UserContext.agencyIds[] (single-entry today)
 *       * map agencyIsSystem → UserContext.platformAdmin (staging only)
 *       * permissions stay an empty array — Phase 3 wires the role→
 *         permission projection
 *   - The legacy `req.user` is NOT modified. Existing controllers
 *     keep working untouched.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { TenantContext, UserContext } from '../context/als';
import type { TenantSnapshot, UserSnapshot } from '../context/types';

@Injectable()
export class TenantContextAuthBridgeInterceptor implements NestInterceptor {
  private readonly logger = new Logger('TenantContextAuthBridge');

  constructor(private readonly flags: FeatureFlagsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const u = req?.user;

    // Tenant attribution for the audit log runs UNCONDITIONALLY (no
    // MULTI_TENANT_ENABLED gate). Without this, every audit row written
    // via AuditLogService.log fell back to NULL because the ALS frame
    // had no tenant attached on HTTP requests, even though the JWT
    // clearly carries a tenantId. The richer UserContext mapping below
    // remains flag-gated.
    if (u && typeof u.tenantId === 'string' && u.tenantId) {
      const minimal: TenantSnapshot = {
        // Audit-log fallback only consumes `.id`. Other fields are
        // never read from this minimal attribution (the rich SaaS
        // path attaches a full snapshot via TenantContextMiddleware
        // when MULTI_TENANT_ENABLED=true).
        id: u.tenantId,
        slug: '',
        name: '',
        status: 'ACTIVE',
        region: 'eu',
      };
      try {
        TenantContext.attach(minimal);
      } catch {
        // ALS frame missing — request bypassed TenantContextMiddleware
        // (e.g. a public route). Fail soft so the request continues.
      }
    }

    if (!this.flags.multiTenantEnabled()) return next.handle();

    if (u && typeof u.id === 'string') {
      const platformAdmin = !!u.agencyIsSystem;
      const snap: UserSnapshot = {
        id: u.id,
        email: u.email ?? '',
        membershipId: undefined,            // Phase 3
        permissions: [],                    // Phase 3
        agencyIds: u.agencyId ? [u.agencyId] : [],
        platformAdmin,
      };
      try {
        UserContext.attach(snap);
      } catch {
        // ALS frame missing — request bypassed the middleware (e.g.
        // public route). Fail soft: legacy req.user is unchanged.
      }
    }
    return next.handle();
  }
}
