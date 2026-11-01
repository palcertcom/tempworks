import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { tenantALS, newRequestId } from './als';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { classifyRuntimeEnv, isStagingClassification } from '../tenancy/env-safety';

/**
 * Phase 2.2 — Tenant context middleware.
 *
 * Behaviour by flag state:
 *
 *   MULTI_TENANT_ENABLED=false  (production default)
 *     Wrap every request in an EMPTY ALS frame. No DB hit. No tenant
 *     attached. Legacy controllers see `req.user` exactly as today.
 *
 *   MULTI_TENANT_ENABLED=true
 *     Refuse to start unless `classifyRuntimeEnv()` returns
 *     SAFE_CLONE / SAFE_STAGING. Production hosts produce a 500 with a
 *     clear log line.
 *     Otherwise: delegate to `TenantResolverService`. If it returns
 *     a tenant, attach to ALS. If it does not, we still proceed with
 *     an empty frame so the legacy code path keeps working — the
 *     decision to FAIL when context is missing is per-feature
 *     (e.g. tenant-safe reports owns its own check).
 *
 * The middleware never touches `req.user`. The auth-bridge interceptor
 * (TenantContextAuthBridgeInterceptor) populates UserContext after the
 * legacy guard has run.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger('TenantContextMiddleware');
  private readonly envCheckedAt = Date.now();
  private readonly envClassification: 'SAFE_STAGING_OR_CLONE' | 'NOT_SAFE' | 'NOT_RELEVANT';

  constructor(
    private readonly flags: FeatureFlagsService,
    private readonly resolver: TenantResolverService,
  ) {
    if (this.flags.multiTenantEnabled()) {
      const env = classifyRuntimeEnv();
      this.envClassification = isStagingClassification(env.classification)
        ? 'SAFE_STAGING_OR_CLONE'
        : 'NOT_SAFE';
      if (this.envClassification === 'NOT_SAFE') {
        this.logger.error(
          `[FAIL-FAST] MULTI_TENANT_ENABLED=true outside staging — env=${env.classification}, reason=${env.reason}. ` +
            `Middleware will refuse every request. Set TENANT_CONTEXT_STAGING_ONLY explicitly off, ` +
            `or restart the process with the flag back to false.`,
        );
      } else {
        this.logger.log(
          `[ACTIVE] MULTI_TENANT_ENABLED=true, env=${env.classification}, reason=${env.reason}.`,
        );
      }
    } else {
      this.envClassification = 'NOT_RELEVANT';
    }
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const requestId = (req.headers['x-request-id'] as string) || newRequestId();

    // Flag OFF (production default) — empty ALS frame.
    if (!this.flags.multiTenantEnabled()) {
      tenantALS.run({ requestId }, () => next());
      return;
    }

    // Flag ON outside staging — refuse loudly.
    if (this.envClassification !== 'SAFE_STAGING_OR_CLONE') {
      const err = new Error(
        'MULTI_TENANT_ENABLED=true is refused outside staging. Set the flag to false ' +
          'OR move the database to a staging-classified host.',
      );
      next(err);
      return;
    }

    // Health / login / refresh — never require tenant resolution.
    const path = req.path ?? req.url ?? '';
    if (PUBLIC_NO_TENANT_PATHS.some((p) => (typeof p === 'string' ? path === p : p.test(path)))) {
      tenantALS.run({ requestId }, () => next());
      return;
    }

    try {
      const headerTenantId = (req.headers['x-tenant-id'] as string) || undefined;
      const reqUser = (req as any).user;
      const resolution = await this.resolver.resolve({
        host: req.hostname || (req.headers.host as string) || '',
        headerTenantId,
        legacyAgencyId: reqUser?.agencyId,
      });

      // Stash resolution metadata for diagnostics; harmless when unused.
      (req as any).__saasTenantResolution = {
        method: resolution.method,
        tenantId: resolution.tenant?.id ?? null,
        detail: resolution.detail,
      };

      tenantALS.run(
        { requestId, tenant: resolution.tenant ?? undefined },
        () => next(),
      );
    } catch (e) {
      this.logger.error(`tenant-resolution-failed: ${(e as Error).message}`);
      // Continue without tenant — the per-feature guard fails loud if
      // it requires one. We do NOT short-circuit the whole request,
      // because the legacy code path remains available.
      tenantALS.run({ requestId }, () => next());
    }
  }
}

/**
 * Routes that must NEVER require tenant resolution. Health/ready/login.
 *
 * Used by the Phase 1 middleware. Listed here so it can be unit-tested
 * already in Phase 0.
 */
export const PUBLIC_NO_TENANT_PATHS: ReadonlyArray<string | RegExp> = [
  '/healthz',
  '/readyz',
  '/auth/login',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  /^\/_platform\/auth\//,  // platform-admin login on its own surface
];
