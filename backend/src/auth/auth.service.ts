import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAdminAccessService } from '../saas/platform-admin/platform-admin-access.service';
import { AuditLogService } from '../logs/audit-log.service';
import { EmailService } from '../email/email.service';

// ---------------------------------------------------------------------------
// Date helpers (plain JS — no date-fns dependency required)
// ---------------------------------------------------------------------------
function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private auditLog: AuditLogService,
    private emailService: EmailService,
    // Phase 3.9 — authority now resolved from PlatformAdmin only.
    // @tenant-reviewed: phase390-platform-admin-only-authority
    private platformAdminAccess: PlatformAdminAccessService,
  ) {}

  // ---------------------------------------------------------------------------
  // Validate user (used by local strategy if needed)
  // ---------------------------------------------------------------------------
  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { email: email.trim().toLowerCase(), deletedAt: null },
      include: { role: true },
    });
    if (!user) return null;
    if (user.status !== 'ACTIVE') return null;
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) return null;
    return user;
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------
  async login(
    loginDto: { agencyId?: string; email: string; password: string; tenantId?: string; membershipId?: string },
    ipAddress?: string,
  ) {
    const normalizedEmail = loginDto.email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, deletedAt: null },
      include: { role: true, agency: { select: { id: true, name: true } } },
    });

    if (!user) {
      await this.auditLog.log({
        userEmail: normalizedEmail,
        action: 'LOGIN_FAILED',
        entity: 'User',
        entityId: 'unknown',
        changes: { reason: 'User not found' },
        ipAddress,
      });
      throw new UnauthorizedException({ code: 'AUTH.INVALID_CREDENTIALS', message: 'Invalid credentials' });
    }

    // Agency scope check — return generic error to prevent enumeration
    if (loginDto.agencyId && user.agencyId !== loginDto.agencyId) {
      await this.auditLog.log({
        userId: user.id,
        userEmail: user.email,
        action: 'LOGIN_FAILED',
        entity: 'User',
        entityId: user.id,
        changes: { reason: 'Agency mismatch' },
        ipAddress,
      });
      throw new UnauthorizedException({ code: 'AUTH.INVALID_CREDENTIALS', message: 'Invalid credentials' });
    }

    // Check lockout
    if (user.lockedAt) {
      const lockoutDurationMs = 30 * 60 * 1000; // 30 minutes
      const unlockTime = new Date(user.lockedAt.getTime() + lockoutDurationMs);
      if (new Date() < unlockTime) {
        throw new UnauthorizedException({
          code: 'AUTH.ACCOUNT_LOCKED',
          message: 'Account is temporarily locked. Please try again later.',
        });
      }
      // Lockout period has passed — clear the lock
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lockedAt: null, failedLoginAttempts: 0 },
      });
    }

    // Validate password
    const isPasswordValid = await bcrypt.compare(loginDto.password, user.passwordHash);

    if (!isPasswordValid) {
      const maxAttempts = await this.getSystemSettingNumber('MAX_LOGIN_ATTEMPTS', 3);
      const newFailedCount = (user.failedLoginAttempts ?? 0) + 1;

      const updateData: any = { failedLoginAttempts: newFailedCount };

      if (newFailedCount >= maxAttempts) {
        updateData.lockedAt = new Date();
        // Fire-and-forget email — never block login flow
        this.emailService
          .sendAccountLockedEmail(user.email, `${user.firstName} ${user.lastName}`, user.preferredLanguage as any)
          .catch(() => undefined);
        await this.auditLog.log({
          userId: user.id,
          userEmail: user.email,
          action: 'ACCOUNT_LOCKED',
          entity: 'User',
          entityId: user.id,
          changes: { failedLoginAttempts: newFailedCount },
          ipAddress,
        });
      }

      await this.prisma.user.update({ where: { id: user.id }, data: updateData });

      await this.auditLog.log({
        userId: user.id,
        userEmail: user.email,
        action: 'LOGIN_FAILED',
        entity: 'User',
        entityId: user.id,
        changes: { reason: 'Invalid password', attempt: newFailedCount },
        ipAddress,
      });

      throw new UnauthorizedException({ code: 'AUTH.INVALID_CREDENTIALS', message: 'Invalid credentials' });
    }

    // Password correct — reset failure counters
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedAt: null },
    });

    // Status checks (after password validation to avoid status enumeration via timing)
    switch (user.status) {
      case 'PENDING':
        throw new UnauthorizedException({
          code: 'AUTH.ACCOUNT_PENDING',
          message: 'Account not yet activated. Please check your email.',
        });
      case 'INACTIVE':
        throw new UnauthorizedException({
          code: 'AUTH.ACCOUNT_INACTIVE',
          message: 'Account is inactive. Please contact your administrator.',
        });
      case 'SUSPENDED':
        throw new UnauthorizedException({
          code: 'AUTH.ACCOUNT_SUSPENDED',
          message: 'Account is suspended. Please contact your administrator.',
        });
      case 'TERMINATED':
        throw new UnauthorizedException({
          code: 'AUTH.ACCOUNT_TERMINATED',
          message: 'Account has been terminated.',
        });
    }

    // Password expiry check
    let passwordExpired = false;
    if (user.passwordExpiresAt && user.passwordExpiresAt < new Date()) {
      passwordExpired = true;
    }

    // If the user has 2FA enabled, do NOT issue tokens yet — create a
    // short-lived challenge, email the OTP, and return a challenge id.
    if ((user as any).twoFactorEnabled) {
      const { challenge, expiresAt } = await this.createTwoFactorChallenge(user.id, ipAddress);
      this.emailService
        .sendTwoFactorCode(
          user.email,
          `${user.firstName} ${user.lastName}`,
          challenge.code,
          10,
          { ipAddress },
          user.preferredLanguage as any,
        )
        .catch(() => undefined);

      await this.auditLog.log({
        userId: user.id,
        userEmail: user.email,
        action: 'TWO_FACTOR_CHALLENGE_SENT',
        entity: 'User',
        entityId: user.id,
        ipAddress,
      });

      return {
        twoFactorRequired: true,
        challengeId: challenge.id,
        expiresAt,
        // Hint for the UI — the full email is not exposed
        emailHint: this.maskEmail(user.email),
      } as any;
    }

    return this.finalizeLogin(user, passwordExpired, ipAddress, {
      tenantId:     loginDto.tenantId,
      membershipId: loginDto.membershipId,
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 3.13 — Tenant-aware login (POST /auth/login-v2)
  //
  // Resolves a tenant from `company` (slug → customDomain), verifies the
  // user belongs to that tenant via `User.agencyId → Agency.tenantId`, and
  // delegates the actual credential check to the existing login() method.
  //
  // Every failure mode (tenant not found, user not found, wrong password,
  // user outside tenant, inactive/deleted, ambiguous match) returns the
  // SAME generic 401 — operators may correlate via the audit log.
  //
  // @tenant-reviewed: phase313-tenant-aware-login
  // ---------------------------------------------------------------------------
  async loginV2(
    dto: { company: string; email: string; password: string },
    ipAddress?: string,
  ) {
    const generic = new UnauthorizedException({
      code: 'AUTH.INVALID_CREDENTIALS',
      message: 'Invalid company, email, or password',
    });
    const company = (dto.company ?? '').trim().toLowerCase();
    const email   = (dto.email ?? '').trim().toLowerCase();
    if (!company || !email || !dto.password) throw generic;

    // Resolve tenant — slug, then customDomain. No fuzzy matching.
    const tenant = await this.prisma.tenant.findFirst({
      where: { OR: [{ slug: company }, { customDomain: company }] },
      select: { id: true },
    });
    if (!tenant) {
      await this.auditLog.log({
        userEmail: email, action: 'LOGIN_FAILED', entity: 'User', entityId: 'unknown',
        changes: { reason: 'login-v2: tenant not resolved', company }, ipAddress,
      }).catch(() => undefined);
      throw generic;
    }

    // Phase 3.17 — resolve user via TenantMembership (many-to-many) so
    // one User row can belong to multiple tenants. Falls back to the
    // legacy `agency.tenantId` join during the transition: if no
    // membership row exists yet but the user's primary agency already
    // belongs to the resolved tenant, create the membership row on
    // the fly so subsequent logins go through the membership path.
    // @tenant-reviewed: phase317-multi-tenant-login
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, agencyId: true, agency: { select: { tenantId: true } } },
    });
    if (!user) {
      await this.auditLog.log({
        userEmail: email, action: 'LOGIN_FAILED', entity: 'User', entityId: 'unknown',
        changes: { reason: 'login-v2: user not found' }, ipAddress,
      }).catch(() => undefined);
      throw generic;
    }

    let membership = await (this.prisma as any).tenantMembership.findUnique({
      where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
      select: { id: true, status: true },
    }).catch(() => null);

    if (!membership) {
      // Legacy backfill: the user's primary agency may already pin them
      // to this tenant. If so, create the membership row transparently.
      if (user.agency?.tenantId === tenant.id) {
        try {
          membership = await (this.prisma as any).tenantMembership.create({
            data: {
              userId: user.id, tenantId: tenant.id,
              status: 'ACTIVE', joinedAt: new Date(),
            },
            select: { id: true, status: true },
          });
        } catch {
          // Race: another request just created the row.
          membership = await (this.prisma as any).tenantMembership.findUnique({
            where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
            select: { id: true, status: true },
          }).catch(() => null);
        }
      }
    }

    if (!membership || membership.status !== 'ACTIVE') {
      await this.auditLog.log({
        userEmail: email, action: 'LOGIN_FAILED', entity: 'User', entityId: user.id,
        changes: { reason: 'login-v2: no active tenant membership', tenantId: tenant.id }, ipAddress,
      }).catch(() => undefined);
      throw generic;
    }

    // Delegate to existing login flow with agencyId pin so the agency-mismatch
    // path also enforces tenant membership defensively. Translate ANY 401 from
    // the legacy flow into the same generic message — no information leakage.
    // The tenant + membership context is stamped onto the issued JWT via
    // `generateTokens` below.
    try {
      const result = await this.login(
        { email, password: dto.password, agencyId: user.agencyId, tenantId: tenant.id, membershipId: membership.id },
        ipAddress,
      );
      return result;
    } catch (err: any) {
      if (err instanceof UnauthorizedException) throw generic;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // 2FA: create challenge, verify challenge
  // ---------------------------------------------------------------------------
  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return email;
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${domain}`;
  }

  private async createTwoFactorChallenge(userId: string, ipAddress?: string) {
    // Invalidate any outstanding challenges for this user
    await this.prisma.twoFactorChallenge.updateMany({
      where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = addMinutes(new Date(), 10);

    const record = await this.prisma.twoFactorChallenge.create({
      data: {
        userId,
        challenge: crypto.randomBytes(24).toString('hex'),
        codeHash,
        expiresAt,
        ipAddress,
      },
    });

    return { challenge: { id: record.challenge, code }, expiresAt };
  }

  async verifyTwoFactor(challengeId: string, code: string, ipAddress?: string) {
    const record = await this.prisma.twoFactorChallenge.findUnique({
      where: { challenge: challengeId },
      include: { user: { include: { role: true, agency: true } } },
    });
    if (!record || record.consumedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'AUTH.TWO_FACTOR_INVALID', message: 'Verification code is invalid or has expired' });
    }
    if (record.attempts >= 5) {
      await this.prisma.twoFactorChallenge.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });
      throw new UnauthorizedException({ code: 'AUTH.TWO_FACTOR_TOO_MANY_ATTEMPTS', message: 'Too many attempts. Please sign in again.' });
    }

    const valid = await bcrypt.compare(code.trim(), record.codeHash);
    if (!valid) {
      await this.prisma.twoFactorChallenge.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      await this.auditLog.log({
        userId: record.userId,
        userEmail: record.user.email,
        action: 'TWO_FACTOR_FAILED',
        entity: 'User',
        entityId: record.userId,
        ipAddress,
      });
      throw new UnauthorizedException({ code: 'AUTH.TWO_FACTOR_INVALID', message: 'Invalid verification code' });
    }

    await this.prisma.twoFactorChallenge.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    const user = record.user;
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException({ code: 'AUTH.ACCOUNT_INACTIVE', message: 'Account is not active' });
    }

    const passwordExpired = !!user.passwordExpiresAt && user.passwordExpiresAt < new Date();

    await this.auditLog.log({
      userId: user.id,
      userEmail: user.email,
      action: 'TWO_FACTOR_VERIFIED',
      entity: 'User',
      entityId: user.id,
      ipAddress,
    });

    return this.finalizeLogin(user as any, passwordExpired, ipAddress);
  }

  async resendTwoFactor(challengeId: string, ipAddress?: string) {
    const record = await this.prisma.twoFactorChallenge.findUnique({
      where: { challenge: challengeId },
      include: { user: true },
    });
    if (!record || record.consumedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'AUTH.TWO_FACTOR_EXPIRED', message: 'Verification session expired. Please sign in again.' });
    }
    const { challenge, expiresAt } = await this.createTwoFactorChallenge(record.userId, ipAddress);
    this.emailService
      .sendTwoFactorCode(
        record.user.email,
        `${record.user.firstName} ${record.user.lastName}`,
        challenge.code,
        10,
        { ipAddress },
        (record.user as any).preferredLanguage,
      )
      .catch(() => undefined);
    return { challengeId: challenge.id, expiresAt };
  }

  private async finalizeLogin(
    user: { id: string; email: string; firstName: string; lastName: string; agencyId: string; role: { name: string }; agency?: any },
    passwordExpired: boolean,
    ipAddress?: string,
    session?: { tenantId?: string; membershipId?: string },
  ) {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Stamp the audit row with the tenant the session was actually opened
    // against (the JWT's tenantId from loginV2, or the agency's tenant as
    // fallback) so LOGIN entries scope to the right tenant on read. Pre-fix
    // these rows were always created with tenantId=NULL, which made the
    // Logs page misattribute them to the user's primary tenant.
    const loginTenantId = session?.tenantId ?? (user as any).agency?.tenantId ?? null;
    await this.auditLog.log({
      userId: user.id,
      userEmail: user.email,
      action: 'LOGIN',
      entity: 'User',
      entityId: user.id,
      ipAddress,
      tenantId: loginTenantId,
    });

    const tokens = await this.generateTokens(
      user.id, user.email, user.role.name,
      session?.tenantId ?? (user as any).agency?.tenantId ?? undefined,
      session?.membershipId,
    );
    const refreshTokenHash = await bcrypt.hash(tokens.refreshToken, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: refreshTokenHash },
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      passwordExpired,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role.name,
        agencyId: user.agencyId,
        agency: user.agency ?? null,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 2FA: enable / disable for self
  // ---------------------------------------------------------------------------
  async setTwoFactorEnabled(userId: string, enabled: boolean, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException({ code: 'AUTH.USER_NOT_FOUND', message: 'User not found' });
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: enabled },
    });
    await this.auditLog.log({
      userId,
      userEmail: user.email,
      action: enabled ? 'TWO_FACTOR_ENABLED' : 'TWO_FACTOR_DISABLED',
      entity: 'User',
      entityId: userId,
      ipAddress,
    });
    return { twoFactorEnabled: enabled };
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------
  async logout(userId: string, ipAddress?: string, sessionTenantId?: string | null) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, agency: { select: { tenantId: true } } },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: null },
    });
    // Tenant for the audit row: the session's active tenant (from the JWT
    // that authorised this logout) wins; fall back to the user's primary
    // agency tenant for legacy callers that don't carry one.
    const logoutTenantId = sessionTenantId ?? (user as any)?.agency?.tenantId ?? null;
    await this.auditLog.log({
      userId,
      userEmail: user?.email,
      action: 'LOGOUT',
      entity: 'User',
      entityId: userId,
      ipAddress,
      tenantId: logoutTenantId,
    });
  }

  // ---------------------------------------------------------------------------
  // Refresh tokens
  // ---------------------------------------------------------------------------
  async refreshTokens(userId: string, refreshToken: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { role: true },
    });

    if (!user || !user.refreshToken) {
      throw new UnauthorizedException({ code: 'AUTH.ACCESS_DENIED', message: 'Access denied' });
    }

    const tokenMatches = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!tokenMatches) {
      throw new UnauthorizedException({ code: 'AUTH.ACCESS_DENIED', message: 'Access denied' });
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role.name);
    const refreshTokenHash = await bcrypt.hash(tokens.refreshToken, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: refreshTokenHash },
    });

    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Change password
  // ---------------------------------------------------------------------------
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ipAddress?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException({ code: 'AUTH.USER_NOT_FOUND', message: 'User not found' });

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) {
      await this.auditLog.log({
        userId,
        userEmail: user.email,
        action: 'CHANGE_PASSWORD_FAILED',
        entity: 'User',
        entityId: userId,
        changes: { reason: 'Current password incorrect' },
        ipAddress,
      });
      throw new BadRequestException({ code: 'AUTH.CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' });
    }

    this.validatePasswordStrength(newPassword);

    const newHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newHash,
        passwordChangedAt: new Date(),
        passwordExpiresAt: addDays(new Date(), 30),
      },
    });

    await this.auditLog.log({
      userId,
      userEmail: user.email,
      action: 'CHANGE_PASSWORD',
      entity: 'User',
      entityId: userId,
      ipAddress,
    });

    this.emailService
      .sendPasswordChangedConfirmation(
        user.email,
        `${user.firstName} ${user.lastName}`,
        { changedAt: new Date(), ipAddress, initiator: 'self' },
      )
      .catch(() => undefined);

    return { message: 'Password changed successfully' };
  }

  // ---------------------------------------------------------------------------
  // Get current user profile
  // ---------------------------------------------------------------------------
  async getMe(userId: string, opts?: { activeTenantId?: string }) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        agency: true,
      },
    });
    if (!user) throw new UnauthorizedException({ code: 'AUTH.USER_NOT_FOUND', message: 'User not found' });

    // Merge role defaults with any agency-wide permission overrides applied
    // by Tempworks admins. `allow=true` adds a permission; `allow=false`
    // strips one. Run only for users tied to an agency.
    const basePermissions = new Set<string>(user.role.permissions.map(rp => rp.permission.name));
    if (user.agencyId) {
      const overrides = await this.prisma.agencyPermissionOverride.findMany({
        where: { agencyId: user.agencyId },
      });
      for (const o of overrides) {
        if (o.allow) basePermissions.add(o.permission);
        else         basePermissions.delete(o.permission);
      }
    }
    const effectivePermissions = [...basePermissions];

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      photoUrl: (user as any).photoUrl ?? null,
      role: user.role.name,
      roleId: user.roleId,
      agencyId: user.agencyId,
      // Phase 3.9 — `agency.isSystem` column dropped. `agencyIsSystem` is
      // now derived from PlatformAdmin authority; the legacy nested
      // `agency.isSystem` field is kept in the payload for one release
      // mirroring the derived value for backwards-compatible clients.
      // @tenant-reviewed: phase390-platform-admin-only-authority
      agency: user.agency ? { id: user.agency.id, name: user.agency.name, isSystem: await this.platformAdminAccess.isPlatformAdmin(user.id) } : null,
      agencyIsSystem: await this.platformAdminAccess.isPlatformAdmin(user.id),
      // Phase 3.15 — expose PlatformAdmin level so the frontend can gate
      // the Platform Administration sidebar group and Tenants page.
      // @tenant-reviewed: phase315-tenant-management-module
      platformAdmin: await (async () => {
        const pa = await (this.prisma as any).platformAdmin.findUnique({
          where: { userId: user.id }, select: { level: true },
        }).catch(() => null);
        return { level: pa?.level ?? 'NONE' };
      })(),
      // Phase 3.17 — list every tenant this user can switch into.
      // Used by the topbar tenant picker. Empty for legacy users until
      // they log in once via /auth/login-v2 (the auto-backfill on
      // loginV2 creates the membership row on first login).
      // @tenant-reviewed: phase317-multi-tenant-login
      memberships: await (async () => {
        try {
          const rows = await (this.prisma as any).tenantMembership.findMany({
            where: { userId: user.id, status: 'ACTIVE' },
            select: {
              id: true, tenantId: true, joinedAt: true,
              tenant: { select: { id: true, slug: true, name: true, status: true } },
            },
          });
          return rows.map((r: any) => ({
            membershipId: r.id,
            tenantId:     r.tenantId,
            slug:         r.tenant?.slug,
            name:         r.tenant?.name,
            status:       r.tenant?.status,
            joinedAt:     r.joinedAt,
          }));
        } catch { return []; }
      })(),
      // Phase 3.17 — derived from the user's primary agency.tenantId so
      // the "My Tenant Members" page can route to the right tenant even
      // for accounts that pre-date the TenantMembership backfill.
      // @tenant-reviewed: phase317-multi-tenant-login
      primaryTenantId: (user as any).agency?.tenantId ?? null,
      // Phase 3.17 — the tenant the current JWT is bound to. Falls back
      // to primaryTenantId for legacy tokens issued before 3.17.
      // @tenant-reviewed: phase317-multi-tenant-login
      activeTenantId: opts?.activeTenantId ?? (user as any).agency?.tenantId ?? null,
      permissions: effectivePermissions,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      twoFactorEnabled: (user as any).twoFactorEnabled ?? false,
      // Session policy — read here so every authenticated client gets the
      // current value without needing admin permissions on /settings.
      sessionIdleTimeoutMinutes: await this.getSystemSettingNumber(
        'SESSION_IDLE_TIMEOUT_MINUTES',
        30,
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Activate account (from email link)
  // ---------------------------------------------------------------------------
  async activateAccount(
    token: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: any }> {
    const activationToken = await this.prisma.activationToken.findFirst({
      where: {
        token,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: { include: { role: true } },
      },
    });

    if (!activationToken) {
      throw new BadRequestException({ code: 'AUTH.ACTIVATION_INVALID', message: 'Activation link is invalid or has expired' });
    }

    this.validatePasswordStrength(password);

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();

    await this.prisma.user.update({
      where: { id: activationToken.userId },
      data: {
        status: 'ACTIVE',
        passwordHash,
        passwordChangedAt: now,
        passwordExpiresAt: addDays(now, 30),
      },
    });

    await this.prisma.activationToken.update({
      where: { id: activationToken.id },
      data: { usedAt: now },
    });

    await this.auditLog.log({
      userId: activationToken.userId,
      userEmail: activationToken.user.email,
      action: 'ACCOUNT_ACTIVATED',
      entity: 'User',
      entityId: activationToken.userId,
    });

    // Send welcome email (fire-and-forget)
    this.emailService
      .sendWelcomeEmail(
        activationToken.user.email,
        `${activationToken.user.firstName} ${activationToken.user.lastName}`,
      )
      .catch(() => undefined);

    const tokens = await this.generateTokens(
      activationToken.user.id,
      activationToken.user.email,
      activationToken.user.role.name,
    );
    const refreshTokenHash = await bcrypt.hash(tokens.refreshToken, 10);
    await this.prisma.user.update({
      where: { id: activationToken.userId },
      data: { refreshToken: refreshTokenHash, lastLoginAt: new Date() },
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: activationToken.user.id,
        email: activationToken.user.email,
        firstName: activationToken.user.firstName,
        lastName: activationToken.user.lastName,
        role: activationToken.user.role.name,
        agencyId: activationToken.user.agencyId,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Forgot password (user-initiated)
  // ---------------------------------------------------------------------------
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { email: email.trim().toLowerCase(), deletedAt: null },
    });

    if (user && user.status === 'ACTIVE') {
      const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');

      // Invalidate existing unused USER_INITIATED tokens
      await this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, type: 'USER_INITIATED', usedAt: null },
        data: { usedAt: new Date() },
      });

      const token = crypto.randomBytes(32).toString('hex');
      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          token,
          type: 'USER_INITIATED',
          expiresAt: addMinutes(new Date(), 60),
        },
      });

      this.emailService
        .sendPasswordResetEmail(
          user.email,
          `${user.firstName} ${user.lastName}`,
          token,
          frontendUrl,
          false,
        )
        .catch(() => undefined);

      await this.auditLog.log({
        userId: user.id,
        userEmail: user.email,
        action: 'PASSWORD_RESET_REQUESTED',
        entity: 'User',
        entityId: user.id,
      });
    }

    // Always return void — no enumeration
  }

  // ---------------------------------------------------------------------------
  // Admin-initiated password reset
  // ---------------------------------------------------------------------------
  async adminResetPassword(userId: string, actorId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');

    // Invalidate existing unused ADMIN_INITIATED tokens
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, type: 'ADMIN_INITIATED', usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        token,
        type: 'ADMIN_INITIATED',
        expiresAt: addMinutes(new Date(), 60),
      },
    });

    this.emailService
      .sendPasswordResetEmail(
        user.email,
        `${user.firstName} ${user.lastName}`,
        token,
        frontendUrl,
        true,
      )
      .catch(() => undefined);

    await this.auditLog.log({
      userId: actorId,
      userEmail: user.email,
      action: 'PASSWORD_RESET_TRIGGERED_BY_ADMIN',
      entity: 'User',
      entityId: userId,
      changes: { targetUserId: userId },
    });
  }

  // ---------------------------------------------------------------------------
  // Reset password (apply new password from token)
  // ---------------------------------------------------------------------------
  async resetPassword(token: string, newPassword: string, ipAddress?: string): Promise<void> {
    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        token,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!resetToken) {
      throw new BadRequestException({ code: 'AUTH.RESET_INVALID', message: 'Reset link is invalid or has expired' });
    }

    this.validatePasswordStrength(newPassword);

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const now = new Date();

    await this.prisma.user.update({
      where: { id: resetToken.userId },
      data: {
        passwordHash,
        passwordChangedAt: now,
        passwordExpiresAt: addDays(now, 30),
        refreshToken: null, // invalidate all active sessions
      },
    });

    // Mark used
    await this.prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: now },
    });

    // Invalidate any other unused tokens for this user
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: resetToken.userId, usedAt: null },
      data: { usedAt: now },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: resetToken.userId },
      select: { email: true, firstName: true, lastName: true },
    });

    await this.auditLog.log({
      userId: resetToken.userId,
      userEmail: user?.email,
      action: 'PASSWORD_RESET',
      entity: 'User',
      entityId: resetToken.userId,
      ipAddress,
    });

    if (user?.email) {
      this.emailService
        .sendPasswordChangedConfirmation(
          user.email,
          `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email,
          {
            changedAt: now,
            ipAddress,
            initiator: resetToken.type === 'ADMIN_INITIATED' ? 'admin' : 'reset',
          },
        )
        .catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Resend activation email
  // ---------------------------------------------------------------------------
  async resendActivation(userId: string, actorId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    if (user.status !== 'PENDING' && user.status !== 'INACTIVE') {
      throw new BadRequestException({
        code: 'AUTH.ACCOUNT_STATUS',
        message: 'Activation email can only be resent for PENDING or INACTIVE accounts',
        params: { status: user.status },
      });
    }

    // Invalidate existing unused activation tokens
    await this.prisma.activationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = await this.generateUserActivationToken(userId);
    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');

    this.emailService
      .sendActivationEmail(
        user.email,
        `${user.firstName} ${user.lastName}`,
        token,
        frontendUrl,
      )
      .catch(() => undefined);

    await this.auditLog.log({
      userId: actorId,
      userEmail: user.email,
      action: 'ACTIVATION_EMAIL_RESENT',
      entity: 'User',
      entityId: userId,
      changes: { targetUserId: userId },
    });
  }

  // ---------------------------------------------------------------------------
  // Helper: generate activation token and persist it
  // ---------------------------------------------------------------------------
  async generateUserActivationToken(userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    await this.prisma.activationToken.create({
      data: {
        userId,
        token,
        expiresAt: addMinutes(new Date(), 60),
      },
    });
    return token;
  }

  // ---------------------------------------------------------------------------
  // Password strength validation
  // ---------------------------------------------------------------------------
  private validatePasswordStrength(password: string): void {
    if (password.length < 8) {
      throw new BadRequestException({ code: 'AUTH.PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters long', params: { min: 8 } });
    }
    // Unicode-aware checks so passwords written in Arabic, Slovak,
    // German, Cyrillic, CJK, etc. are accepted. `\p{Lo}` covers
    // caseless scripts (Arabic, Hebrew, CJK) and counts toward both
    // the uppercase and lowercase requirements.
    if (!/[\p{Lu}\p{Lo}]/u.test(password)) {
      throw new BadRequestException({ code: 'AUTH.PASSWORD_NEEDS_UPPERCASE', message: 'Password must contain at least one uppercase letter' });
    }
    if (!/[\p{Ll}\p{Lo}]/u.test(password)) {
      throw new BadRequestException({ code: 'AUTH.PASSWORD_NEEDS_LOWERCASE', message: 'Password must contain at least one lowercase letter' });
    }
    if (!/\p{N}/u.test(password)) {
      throw new BadRequestException({ code: 'AUTH.PASSWORD_NEEDS_DIGIT', message: 'Password must contain at least one digit' });
    }
    // Anything that isn't a letter or digit counts as a special
    // character — covers ASCII punctuation as well as Unicode symbols.
    if (!/[^\p{L}\p{N}]/u.test(password)) {
      throw new BadRequestException({
        code: 'AUTH.PASSWORD_NEEDS_SPECIAL',
        message: 'Password must contain at least one special character',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: read numeric system setting with default
  // ---------------------------------------------------------------------------
  private async getSystemSettingNumber(key: string, defaultValue: number): Promise<number> {
    try {
      const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
      if (setting) {
        const parsed = parseInt(setting.value, 10);
        return isNaN(parsed) ? defaultValue : parsed;
      }
    } catch {
      // fall through to default
    }
    return defaultValue;
  }

  // ---------------------------------------------------------------------------
  // Phase 3.17 — switch the active tenant for an already-authenticated user.
  // Returns a fresh JWT bound to the target tenant + membership. Rejects
  // when the user has no active membership in the requested tenant.
  // @tenant-reviewed: phase317-multi-tenant-login
  // ---------------------------------------------------------------------------
  async switchTenant(userId: string, tenantId: string, ipAddress?: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null, status: 'ACTIVE' },
      include: { role: true },
    });
    if (!user) throw new UnauthorizedException({ code: 'AUTH.USER_NOT_FOUND' });

    const membership = await (this.prisma as any).tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { id: true, status: true },
    }).catch(() => null);
    if (!membership || membership.status !== 'ACTIVE') {
      throw new UnauthorizedException({ code: 'AUTH.TENANT_MEMBERSHIP_REQUIRED' });
    }

    const tokens = await this.generateTokens(
      user.id, user.email, user.role.name, tenantId, membership.id,
    );
    const refreshTokenHash = await bcrypt.hash(tokens.refreshToken, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { refreshToken: refreshTokenHash } });

    await this.auditLog.log({
      userId, userEmail: user.email, action: 'TENANT_SWITCH', entity: 'User',
      entityId: user.id, changes: { tenantId }, ipAddress,
      // Attribute the switch event to the target tenant the user is
      // moving INTO, matching how LOGIN/LOGOUT stamp the resolved
      // session tenant. Otherwise the row falls back to the ALS frame
      // (the previous tenant), which surprised operators reading the
      // per-tenant filter on the Logs page.
      tenantId,
    }).catch(() => undefined);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tenantId,
      membershipId: membership.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Token generation
  // ---------------------------------------------------------------------------
  private async generateTokens(
    userId: string,
    email: string,
    role: string,
    tenantId?: string,
    membershipId?: string,
  ) {
    // Phase 3.17 — JWT now carries the active tenant + membership so
    // tenant-aware routes can authorise without a second DB hop.
    // @tenant-reviewed: phase317-multi-tenant-login
    const payload: Record<string, any> = { sub: userId, email, role };
    if (tenantId)     payload.tenantId     = tenantId;
    if (membershipId) payload.membershipId = membershipId;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_SECRET || 'default-secret-change-in-prod',
        expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET || 'default-refresh-secret-change-in-prod',
        expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
      }),
    ]);

    return { accessToken, refreshToken };
  }
}
