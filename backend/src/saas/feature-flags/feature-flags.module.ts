import { Module, Global } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * Global, side-effect-free flag service.
 *
 * INTENTIONALLY NOT YET IMPORTED INTO `AppModule` — Phase 0 keeps the
 * application byte-identical. Phase 1 (TKT-01) wires this in.
 */
@Global()
@Module({
  providers: [FeatureFlagsService],
  exports:   [FeatureFlagsService],
})
export class FeatureFlagsModule {}
