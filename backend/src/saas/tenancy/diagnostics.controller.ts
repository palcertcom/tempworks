/**
 * Phase 2.2 — SaaS diagnostics (staging only).
 *
 * Three GET endpoints under `/api/v1/saas/diagnostics/`:
 *
 *   GET /context              redacted snapshot of tenant + user from ALS
 *   GET /flags                public flag snapshot (defaults visible)
 *   GET /tenant-resolution    which strategy resolved the active tenant
 *
 * Guards (all required):
 *   - `MULTI_TENANT_ENABLED=true`
 *   - environment classified SAFE_CLONE or SAFE_STAGING
 *
 * Production hosts get a `404 Not Found` response — the route doesn't
 * "exist" outside staging. We never echo full JWT, secrets, or
 * `process.env`.
 */
import {
  All,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { TenantContext, UserContext, currentRequestContext } from '../context/als';
import { classifyRuntimeEnv, isStagingClassification } from './env-safety';

@Controller('api/v1/saas/diagnostics')
export class SaasDiagnosticsController {
  private readonly logger = new Logger('SaasDiagnostics');

  constructor(private readonly flags: FeatureFlagsService) {}

  @All('*')
  catchProduction() {
    // This handler is matched only when none of the specific GET
    // handlers below match. It exists so an unexpected method doesn't
    // accidentally leak a stack trace.
    return { ok: false, error: 'method_not_allowed' };
  }

  @Get('context')
  context() {
    this.assertSafeStaging();
    const ctx = currentRequestContext();
    const t = TenantContext.optional();
    const u = UserContext.optional();
    return {
      requestId: ctx?.requestId ?? null,
      tenant: t
        ? { id: t.id, slug: t.slug, name: t.name, status: t.status, region: t.region }
        : null,
      user: u
        ? {
            id: redactId(u.id),
            email: redactEmail(u.email),
            agencyIds: u.agencyIds,
            permissions: u.permissions,
            platformAdmin: u.platformAdmin,
          }
        : null,
    };
  }

  @Get('flags')
  flags_() {
    this.assertSafeStaging();
    return { flags: this.flags.publicSnapshot() };
  }

  @Get('tenant-resolution')
  resolution(@Req() req: Request) {
    this.assertSafeStaging();
    const r = (req as any).__saasTenantResolution ?? null;
    return r ?? { method: 'none', tenantId: null, detail: 'middleware did not run for this request' };
  }

  private assertSafeStaging(): void {
    if (!this.flags.multiTenantEnabled()) {
      // Behave like the route does not exist.
      throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    }
    const env = classifyRuntimeEnv();
    if (!isStagingClassification(env.classification)) {
      this.logger.warn(`diagnostics blocked: env=${env.classification}, reason=${env.reason}`);
      throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    }
  }
}

function redactId(id: string): string {
  if (!id) return '';
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : '***';
}
function redactEmail(email: string): string {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  return `${local[0] ?? '*'}***@${domain}`;
}
