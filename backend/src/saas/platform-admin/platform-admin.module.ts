import { Module } from '@nestjs/common';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * Platform-admin module skeleton (ADR-005).
 *
 * NOT registered in `AppModule` in Phase 0. Wired in Phase 3 alongside
 * `/_platform/*` routes.
 */
@Module({
  providers: [PlatformPrismaService, PlatformAdminGuard],
  exports:   [PlatformPrismaService, PlatformAdminGuard],
})
export class PlatformAdminModule {}
