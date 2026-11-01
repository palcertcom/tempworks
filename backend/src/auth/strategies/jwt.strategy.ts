import {
  Injectable, UnauthorizedException, ServiceUnavailableException, Logger,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformAdminAccessService } from '../../saas/platform-admin/platform-admin-access.service';

/**
 * True when an error is a database *connectivity* failure (server
 * unreachable / connection dropped / connect timeout) rather than a
 * query or data problem. Prisma surfaces these as P1xxx request errors
 * or a PrismaClientInitializationError; the underlying pg error can also
 * leak through. We match defensively on all three so a transient DB
 * outage degrades to a retryable 503 instead of an alarming 500 on every
 * authenticated request.
 */
function isDbUnreachable(err: any): boolean {
  const code = String(err?.code ?? '');
  if (/^P1\d{3}$/.test(code)) return true; // P1001/P1002/P1008/P1017…
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(code)) return true;
  const name = String(err?.name ?? '');
  if (name.includes('PrismaClientInitializationError')) return true;
  return /can't reach database server|connection terminated|connection timeout/i.test(String(err?.message ?? ''));
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private prisma: PrismaService,
    // Phase 3.7/3.9 — authority resolver for `agencyIsSystem`. As of
    // Phase 3.9 the legacy `Agency.isSystem` column is removed and the
    // service answers exclusively from `PlatformAdmin`.
    // Tag: phase390-platform-admin-only-authority
    private platformAdminAccess: PlatformAdminAccessService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'default-secret-change-in-prod',
    });
  }

  private readonly logger = new Logger(JwtStrategy.name);

  async validate(payload: any) {
    // Use an explicit select instead of SELECT * so a Prisma-generated
    // field that doesn't exist in the database yet (e.g. a column added
    // by a pending migration) can't take every authenticated request
    // down with a 500.
    let user;
    try {
      user = await this.prisma.user.findFirst({
        where: { id: payload.sub, deletedAt: null },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          roleId: true,
          agencyId: true,
          role: { select: { name: true } },
          // Phase 3.18 — pull the user's primary tenantId via their agency
          // so dashboard tenant-scope filters work for legacy tokens that
          // never went through /auth/login-v2.
          // @tenant-reviewed: phase318-tenant-public-jobs
          agency: { select: { tenantId: true } },
          // Phase 3.9 — Agency.isSystem column removed; no longer selected here.
        },
      });
    } catch (err: any) {
      // A transient DB outage must not log a 500 stack on every request,
      // and must NOT surface as 401 (which would log the user out / loop
      // refresh). Map it to a retryable 503 with a clear code.
      if (isDbUnreachable(err)) {
        this.logger.warn(`Auth temporarily unavailable — database unreachable: ${err?.message ?? err}`);
        throw new ServiceUnavailableException({
          code: 'AUTH.DB_UNAVAILABLE',
          message: 'Authentication service is temporarily unavailable. Please try again shortly.',
        });
      }
      throw err;
    }
    if (!user) {
      throw new UnauthorizedException({ code: 'AUTH.USER_NOT_FOUND', message: 'User not found' });
    }
    if (user.status !== 'ACTIVE') {
      // Any non-ACTIVE status (INACTIVE, SUSPENDED, PENDING, TERMINATED)
      // immediately terminates the session — no need to wait for next login.
      throw new UnauthorizedException({
        code: 'AUTH.ACCOUNT_STATUS',
        message: `Account is ${user.status.toLowerCase()}`,
        params: { status: user.status.toLowerCase() },
      });
    }
    // Phase 3.9 — `agencyIsSystem` means "platform admin per
    // PlatformAdmin row". The field name is preserved for downstream
    // compatibility; the column it once derived from has been dropped.
    // @tenant-reviewed: phase390-platform-admin-only-authority
    let agencyIsSystem: boolean;
    try {
      agencyIsSystem = await this.platformAdminAccess.isPlatformAdmin(user.id);
    } catch (err: any) {
      if (isDbUnreachable(err)) {
        this.logger.warn(`Auth temporarily unavailable — database unreachable: ${err?.message ?? err}`);
        throw new ServiceUnavailableException({
          code: 'AUTH.DB_UNAVAILABLE',
          message: 'Authentication service is temporarily unavailable. Please try again shortly.',
        });
      }
      throw err;
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role.name,
      roleId: user.roleId,
      agencyId: user.agencyId,
      agencyIsSystem,
      // Phase 3.17 — active tenant + membership stamped at login or
      // tenant-switch time. Undefined on legacy tokens issued before
      // 3.17 (single-tenant fallback still works).
      // @tenant-reviewed: phase317-multi-tenant-login
      tenantId:     payload?.tenantId ?? user.agency?.tenantId ?? undefined,
      membershipId: payload?.membershipId,
    };
  }
}
