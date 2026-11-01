import { Module, forwardRef } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentIdService } from './document-id.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';
import { ContractsModule } from '../contracts/contracts.module';

/**
 * Phase 2.20 — Documents reads-first TenantPrisma pilot.
 *
 * Wires the pilot dependencies. Read paths in `DocumentsService` use
 * `getPilotScope(this.pilot, 'documents')` which respects the
 * `TENANT_PRISMA_PILOT_MODULES` allow-list. Mutation, upload,
 * download, and storage paths remain on `legacyPrisma` and are
 * byte-identical to pre-2.20.
 */
// Multer config now lives per-route (memoryStorage) — see
// common/storage/multer.config.ts.
@Module({
  imports: [NotificationsModule, FeatureFlagsModule, TenantAuditLogModule, forwardRef(() => ContractsModule)],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentIdService, TenantPrismaService, PilotPrismaAccessor],
  exports: [DocumentsService, DocumentIdService],
})
export class DocumentsModule {}
