import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantContextMiddleware } from '../context/tenant-context.middleware';
import { TenantContextAuthBridgeInterceptor } from './auth-bridge.interceptor';
import { SaasDiagnosticsController } from './diagnostics.controller';

/**
 * Phase 2.2 — SaaS Tenancy Module.
 *
 * Imported by `AppModule`. The middleware is registered for every
 * route, but its body is a no-op pass-through when
 * `MULTI_TENANT_ENABLED=false` (production default), so the production
 * runtime is byte-identical.
 *
 * The interceptor + diagnostics controller are likewise inert when the
 * flag is off:
 *   - the interceptor returns immediately;
 *   - the diagnostics controller responds 404 unless the env is
 *     classified SAFE_CLONE or SAFE_STAGING and the flag is on.
 */
@Module({
  imports:   [FeatureFlagsModule, PrismaModule],
  providers: [
    TenantResolverService,
    TenantContextMiddleware,
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantContextAuthBridgeInterceptor,
    },
  ],
  controllers: [SaasDiagnosticsController],
  exports:   [TenantResolverService, TenantContextMiddleware],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // The middleware self-gates on the flag. We register it for every
    // route so a single flag flip is enough to activate it across the
    // app. Static-asset routes are not Nest routes; this configure()
    // call only attaches to controllers / nested middleware chain.
    consumer
      .apply(TenantContextMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
