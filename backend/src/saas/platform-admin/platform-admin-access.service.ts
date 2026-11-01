import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Phase 3.9 — PlatformAdmin authoritative resolver.
 *
 * After Phase 3.9 the legacy `Agency.isSystem` column is GONE. Platform
 * authority is sourced exclusively from `PlatformAdmin` rows. The
 * Phase 3.6/3.7/3.8 fallback flags
 * (`PLATFORM_ADMIN_DUAL_READ_ENABLED`,
 *  `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK`) are now **inert** — there
 * is no column to read. Setting them has no effect; they are left
 * tolerated for one release as a no-op so older configuration files
 * remain valid.
 *
 * Read-only. No data mutation. No PlatformAuditLog writes (table
 * absent; deferred). Inactive/deleted users always resolve to false.
 *
 * @tenant-reviewed: phase390-platform-admin-only-authority
 */
@Injectable()
export class PlatformAdminAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns true iff the user has an active PlatformAdmin row. */
  async isPlatformAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;

    const user = await this.prisma.user.findFirst({ // @tenant-reviewed: phase390-platform-admin-only-authority
      where: { id: userId, deletedAt: null, status: 'ACTIVE' as any },
      select: { id: true },
    });
    if (!user) return false;

    const pa = await (this.prisma as any).platformAdmin.findUnique({ // @tenant-reviewed: phase390-platform-admin-only-authority
      where: { userId: user.id },
      select: { level: true },
    });
    return !!(pa && ['SUPPORT', 'OPERATOR', 'SUPER'].includes(pa.level));
  }

  /** Optional ergonomic helper. */
  async assertPlatformAdmin(userId: string | null | undefined): Promise<void> {
    if (!(await this.isPlatformAdmin(userId))) {
      throw new Error('PLATFORM_ADMIN_REQUIRED');
    }
  }
}
