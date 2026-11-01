import { Module, Global } from '@nestjs/common';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { TenantPrismaService } from './prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from './prisma/pilot-prisma.accessor';
import { PlatformPrismaService } from './prisma/platform-prisma.service';
import { SignedUrlService } from './signed-urls/signed-url.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * SaaS umbrella module — Phase 0 foundations.
 *
 * INTENTIONALLY NOT REGISTERED in `AppModule`. Wiring is a Phase 1
 * deliverable (TKT-01 through TKT-09). Until then, importing this
 * module is a deliberate opt-in for tests and pilot integration.
 */
@Global()
@Module({
  imports:   [FeatureFlagsModule, PrismaModule],
  providers: [TenantPrismaService, PilotPrismaAccessor, PlatformPrismaService, SignedUrlService],
  exports:   [
    FeatureFlagsModule,
    TenantPrismaService,
    PilotPrismaAccessor,
    PlatformPrismaService,
    SignedUrlService,
  ],
})
export class SaasModule {}
