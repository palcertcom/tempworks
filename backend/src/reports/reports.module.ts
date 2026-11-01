import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';

/**
 * The FeatureFlagsModule import is the Phase 2.1 integration point.
 *
 * When `TENANT_SAFE_REPORTS_ENABLED=false` (production default), the
 * service merely receives the flags object and ignores it; behaviour
 * is byte-identical to today.
 *
 * When the flag is true (staging only), the legacy service delegates
 * `run()` to the tenant-safe runtime under `src/saas/reports/runtime/`.
 */
@Module({
  imports: [FeatureFlagsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
