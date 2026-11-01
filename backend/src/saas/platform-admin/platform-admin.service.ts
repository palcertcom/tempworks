import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type PlatformAdminLevel = 'SUPPORT' | 'OPERATOR' | 'SUPER';
const VALID_LEVELS: PlatformAdminLevel[] = ['SUPPORT', 'OPERATOR', 'SUPER'];

export interface GrantInput {
  actorUserId: string;
  targetUserId: string;
  level: PlatformAdminLevel;
  reason: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RevokeInput {
  actorUserId: string;
  targetUserId: string;
  reason: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Phase 3.11 — PlatformAdmin grant/revoke service.
 *
 * Authority model:
 *   - ONLY existing PlatformAdmin SUPER may grant or revoke.
 *   - SUPPORT / OPERATOR cannot grant or revoke (assertion).
 *   - Non-PlatformAdmin cannot grant or revoke.
 *   - Actor cannot self-revoke (explicit guard).
 *   - Actor may self-grant only when no PlatformAdmin row yet exists
 *     for them — but the SUPER check forbids that anyway (no SUPER
 *     row means assertion fails). Effectively self-grant is impossible
 *     from a cold start; bootstrap uses the Phase 3.5 backfill script.
 *
 * Duplicate grant policy:
 *   - `grant` upserts on `(userId)`. If a row already exists and the
 *     level differs, action = `PLATFORM_ADMIN_LEVEL_CHANGED` (target
 *     contains previousLevel + newLevel). If the level is the same,
 *     action = `PLATFORM_ADMIN_GRANT_IDEMPOTENT` and no DB write
 *     happens beyond the audit row.
 *
 * Every grant / revoke / level change emits exactly one row to
 * `platform_audit_logs` with action, reason, target JSON containing
 * the targetUserId and previous/new level where applicable.
 *
 * @tenant-reviewed: phase311-platform-admin-grant-revoke
 */
@Injectable()
export class PlatformAdminService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertSuperPlatformAdmin(actorUserId: string): Promise<void> {
    if (!actorUserId) throw new ForbiddenException({ code: 'PLATFORM_ADMIN.MISSING_ACTOR' });
    const actor = await this.prisma.user.findFirst({
      where: { id: actorUserId, deletedAt: null, status: 'ACTIVE' as any },
      select: { id: true },
    });
    if (!actor) throw new ForbiddenException({ code: 'PLATFORM_ADMIN.ACTOR_INACTIVE' });
    const pa = await (this.prisma as any).platformAdmin.findUnique({ // @tenant-reviewed: phase311-platform-admin-super-only
      where: { userId: actorUserId },
      select: { level: true },
    });
    if (!pa) throw new ForbiddenException({ code: 'PLATFORM_ADMIN.ACTOR_NOT_PLATFORM_ADMIN' });
    if (pa.level !== 'SUPER') throw new ForbiddenException({ code: 'PLATFORM_ADMIN.ACTOR_NOT_SUPER' });
  }

  private async emitAudit(args: {
    actorId: string; action: string; reason: string;
    target: Record<string, unknown>;
    ip?: string | null; userAgent?: string | null;
  }): Promise<void> {
    // @tenant-reviewed: phase311-platform-audit-log-emission
    await (this.prisma as any).platformAuditLog.create({
      data: {
        actorId: args.actorId,
        action: args.action,
        reason: args.reason,
        target: args.target as any,
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
      },
    });
  }

  /**
   * Guard: a PlatformAdmin level (SUPPORT / OPERATOR / SUPER) may only
   * be granted to a user who holds the tenant-level `System Admin`
   * role. Any platform-admin grant flips `agencyIsSystem=true` in the
   * JWT and bypasses tenant isolation, so handing it to a tenant
   * admin / agency manager / recruiter / finance / HR user would be a
   * cross-tenant privilege escalation. Revoking (level NONE) is not
   * gated — you can always strip platform authority from anyone.
   */
  private async assertTargetIsSystemAdmin(targetUserId: string): Promise<void> {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, deletedAt: null },
      select: { role: { select: { name: true } } },
    });
    if (target?.role?.name !== 'System Admin') {
      throw new ForbiddenException({
        code: 'PLATFORM_ADMIN.TARGET_NOT_SYSTEM_ADMIN',
        message: 'Platform admin access can only be granted to System Admin users',
      });
    }
  }

  /** Grant or update a PlatformAdmin level. SUPER actor only. */
  async grant(input: GrantInput) {
    if (!VALID_LEVELS.includes(input.level)) {
      throw new BadRequestException({ code: 'PLATFORM_ADMIN.INVALID_LEVEL', detail: input.level });
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw new BadRequestException({ code: 'PLATFORM_ADMIN.REASON_REQUIRED' });
    }
    await this.assertSuperPlatformAdmin(input.actorUserId);

    const target = await this.prisma.user.findFirst({
      where: { id: input.targetUserId, deletedAt: null, status: 'ACTIVE' as any },
      select: { id: true },
    });
    if (!target) throw new NotFoundException({ code: 'PLATFORM_ADMIN.TARGET_NOT_ACTIVE' });

    // Core rule: only System Admins may receive platform-admin
    // authority. grant() never carries NONE (that goes through
    // revoke()), so this always applies here.
    await this.assertTargetIsSystemAdmin(input.targetUserId);

    const existing = await (this.prisma as any).platformAdmin.findUnique({
      where: { userId: input.targetUserId },
      select: { id: true, level: true },
    });

    let action: string;
    let auditTarget: Record<string, unknown>;
    if (!existing) {
      await (this.prisma as any).platformAdmin.create({
        data: {
          userId: input.targetUserId,
          level: input.level as any,
          grantedBy: input.actorUserId,
        },
      });
      action = 'PLATFORM_ADMIN_GRANTED';
      auditTarget = { targetUserId: input.targetUserId, level: input.level };
    } else if (existing.level !== input.level) {
      await (this.prisma as any).platformAdmin.update({
        where: { userId: input.targetUserId },
        data: { level: input.level as any, grantedBy: input.actorUserId, grantedAt: new Date() },
      });
      action = 'PLATFORM_ADMIN_LEVEL_CHANGED';
      auditTarget = { targetUserId: input.targetUserId, previousLevel: existing.level, newLevel: input.level };
    } else {
      action = 'PLATFORM_ADMIN_GRANT_IDEMPOTENT';
      auditTarget = { targetUserId: input.targetUserId, level: input.level };
    }

    await this.emitAudit({
      actorId: input.actorUserId,
      action,
      reason: input.reason,
      target: auditTarget,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return { action, targetUserId: input.targetUserId, level: input.level };
  }

  /** Revoke a PlatformAdmin row. SUPER actor only. No self-revoke. */
  async revoke(input: RevokeInput) {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new BadRequestException({ code: 'PLATFORM_ADMIN.REASON_REQUIRED' });
    }
    if (input.actorUserId === input.targetUserId) {
      throw new ForbiddenException({ code: 'PLATFORM_ADMIN.SELF_REVOKE_FORBIDDEN' });
    }
    await this.assertSuperPlatformAdmin(input.actorUserId);

    const existing = await (this.prisma as any).platformAdmin.findUnique({
      where: { userId: input.targetUserId },
      select: { level: true },
    });
    if (!existing) throw new NotFoundException({ code: 'PLATFORM_ADMIN.NOT_FOUND' });

    // PlatformAdmin has no soft-delete fields — hard delete is the
    // documented semantics. Audit row preserves the trail.
    await (this.prisma as any).platformAdmin.delete({ where: { userId: input.targetUserId } });

    await this.emitAudit({
      actorId: input.actorUserId,
      action: 'PLATFORM_ADMIN_REVOKED',
      reason: input.reason,
      target: { targetUserId: input.targetUserId, previousLevel: existing.level },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return { action: 'PLATFORM_ADMIN_REVOKED', targetUserId: input.targetUserId };
  }

  /** List all PlatformAdmin rows. SUPER actor only. */
  async list(actorUserId: string) {
    await this.assertSuperPlatformAdmin(actorUserId);
    const rows = await (this.prisma as any).platformAdmin.findMany({
      orderBy: { grantedAt: 'desc' },
      select: {
        id: true, userId: true, level: true, grantedBy: true, grantedAt: true,
      },
    });
    return rows;
  }
}
