import { Injectable, NotFoundException, ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { AuditLogService } from '../logs/audit-log.service';
import { EmailService } from '../email/email.service';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIF_EVENTS } from '../notifications/notification-events';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';

// Fields that only System Admin / HR Manager can change
const ADMIN_ONLY_FIELDS: (keyof UpdateUserDto)[] = [
  'email', 'roleId', 'agencyId', 'status', 'firstName', 'lastName',
  'startDate', 'department', 'jobTitle',
];

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private auditLog: AuditLogService,
    private emailService: EmailService,
    private authService: AuthService,
    private notifications: NotificationsService,
  ) {}

  private async getRoleName(roleId: string): Promise<string | null> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId }, select: { name: true } });
    return role?.name ?? null;
  }

  // ---------------------------------------------------------------------------
  // User number sequence
  // ---------------------------------------------------------------------------
  private async getNextUserNumber(): Promise<string> {
    // Use a raw upsert approach: find-or-create then increment atomically
    try {
      // Try to increment an existing sequence row
      const existing = await this.prisma.userNumberSequence.findFirst();
      if (existing) {
        const updated = await this.prisma.userNumberSequence.update({
          where: { id: existing.id },
          data: { current: { increment: 1 } },
        });
        const n = updated.current;
        return n > 9999 ? `U${n}` : `U${String(n).padStart(4, '0')}`;
      } else {
        // Seed the sequence: start at 1
        const created = await this.prisma.userNumberSequence.create({
          data: { current: 1 },
        });
        const n = created.current;
        return n > 9999 ? `U${n}` : `U${String(n).padStart(4, '0')}`;
      }
    } catch {
      // Fallback: use active user count + 1
      const count = await this.prisma.user.count({ where: { deletedAt: null } });
      const n = count + 1;
      return n > 9999 ? `U${n}` : `U${String(n).padStart(4, '0')}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Full user select (no sensitive fields)
  // ---------------------------------------------------------------------------
  private get fullUserSelect() {
    return {
      id: true,
      userNumber: true,
      email: true,
      firstName: true,
      middleName: true,
      lastName: true,
      phone: true,
      dateOfBirth: true,
      gender: true,
      citizenship: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      country: true,
      postalCode: true,
      jobTitle: true,
      department: true,
      startDate: true,
      photoUrl: true,
      status: true,
      roleId: true,
      agencyId: true,
      preferredLanguage: true,
      timeZone: true,
      notificationPrefs: true,
      failedLoginAttempts: true,
      lockedAt: true,
      twoFactorEnabled: true,
      lastLoginAt: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      // Agency-user approval state + per-user manager overrides. The
      // frontend needs these to decide whether Agency Manager sees
      // Edit / Delete buttons and whether Tempworks admin sees the
      // Approve / Allow-manager-edit / Allow-manager-delete controls.
      approvalStatus: true,
      approvedAt: true,
      approvedById: true,
      allowManagerView: true,
      allowManagerEdit: true,
      allowManagerDelete: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Find all
  // ---------------------------------------------------------------------------
  async findAll(
    query: PaginationDto & { roleId?: string; agencyId?: string; status?: string; tenantId?: string },
    callerRole?: string,
    callerAgencyId?: string,
    callerAgencyIsSystem?: boolean,
    callerId?: string,
  ) {
    const { page = 1, limit = 20, search, sortBy = 'createdAt', sortOrder = 'desc', roleId, status } = query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { deletedAt: null };

    // External tenants (any user attached to an agency that isn't the
    // Tempworks root) can only see users inside their own agency —
    // regardless of role name. Tempworks-internal users retain the
    // historical "hide System Admin from non-admins" rule.
    const isExternalTenant = !!callerAgencyId && callerAgencyIsSystem !== true;
    if (isExternalTenant) {
      where.agencyId = callerAgencyId;
      // Hide approved users whose allowManagerView override was
      // turned off by a Tempworks admin. Pending users and those
      // with allowManagerView=true (the default) stay visible.
      where.OR = [
        { approvalStatus: { not: 'APPROVED' } as any },
        { allowManagerView: true },
      ];
    } else {
      if (callerRole !== 'System Admin') {
        where.AND = [{ role: { name: { not: 'System Admin' } } }];
      }
      if (query.agencyId) where.agencyId = query.agencyId;
      // Phase 3.22 — tenant filter. Internal callers (System Admin /
      // PlatformAdmin) get the global view by default but can narrow
      // by tenant via the User Management screen's Tenant dropdown.
      // Match users whose agency.tenantId resolves to the chosen
      // tenant (primary attribution for tenant-scoped users) OR who
      // hold an active TenantMembership for it (covers SUPER /
      // multi-tenant members whose primary agency lives elsewhere).
      // TenantMembership has no `user` back-relation in the schema,
      // so we resolve the matching userIds in a separate query and
      // OR them into the where clause. Wrapped in AND so a
      // concurrent OR (search) composes cleanly.
      if (query.tenantId) {
        const memberRows = await this.prisma.tenantMembership.findMany({
          where: { tenantId: query.tenantId, status: 'ACTIVE' as any },
          select: { userId: true },
        });
        const memberUserIds = memberRows.map(r => r.userId);
        const tenantOr = {
          OR: [
            { agency: { tenantId: query.tenantId } },
            // Sentinel '__none__' keeps the IN clause non-empty when
            // there are zero memberships — Prisma's `in: []` short-
            // circuits to no match, which is the behaviour we want.
            { id: { in: memberUserIds.length > 0 ? memberUserIds : ['__none__'] } },
          ],
        };
        where.AND = [...(where.AND ?? []), tenantOr];
      }
    }

    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { userNumber: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (roleId) where.roleId = roleId;
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { [sortBy]: sortOrder },
        select: {
          ...this.fullUserSelect,
          role: { select: { id: true, name: true } },
          agency: { select: { id: true, name: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    // Phase 3.14/3.15 — attach PlatformAdmin level for the badge in the
    // UI list. Visible only to SUPER PlatformAdmin viewers; for every
    // other caller the field is omitted entirely so the SUPER badge
    // does not leak through the list response.
    try {
      const callerPa = callerId
        ? await (this.prisma as any).platformAdmin.findUnique({
            where: { userId: callerId }, select: { level: true },
          })
        : null;
      if (callerPa?.level === 'SUPER') {
        const ids = data.map((u: any) => u.id);
        if (ids.length) {
          const pas = await (this.prisma as any).platformAdmin.findMany({
            where: { userId: { in: ids } },
            select: { userId: true, level: true },
          });
          const byId = new Map<string, string>(pas.map((p: any) => [p.userId, p.level]));
          for (const u of data as any[]) {
            u.platformAdmin = { level: byId.get(u.id) ?? 'NONE' };
          }
        }
      }
    } catch { /* table may not exist yet in some envs */ }

    return PaginatedResponse.create(data, total, page, limit);
  }

  // ---------------------------------------------------------------------------
  // Find one
  // ---------------------------------------------------------------------------
  async findOne(id: string, callerRole?: string, callerAgencyId?: string, callerAgencyIsSystem?: boolean, callerId?: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        agency: { select: { id: true, name: true, country: true } },
      },
    });
    if (!user) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    // Agency Managers can only view users inside their own agency
    if (callerRole === 'Agency Manager' && user.agencyId !== callerAgencyId) {
      throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });
    }

    if (callerRole !== 'System Admin' && (user as any).role?.name === 'System Admin') {
      throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });
    }

    // External-tenant caller viewing an APPROVED agency user needs the
    // allowManagerView override on (or the row to still be pending).
    // Tempworks-root users (agency.isSystem) bypass. Default of the
    // column is true so existing data keeps current visibility.
    const isExternalTenantCaller =
      callerRole !== 'System Admin' && callerAgencyIsSystem !== true;
    if (isExternalTenantCaller && user.agencyId) {
      const approval = (user as any).approvalStatus;
      const allowView = (user as any).allowManagerView;
      if (approval === 'APPROVED' && allowView === false) {
        throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });
      }
    }

    const { passwordHash, refreshToken, ...result } = user as any;

    // Phase 3.14/3.15 — enrich with PlatformAdmin level for the User
    // edit page's "Platform Admin Access" card. Only visible when the
    // caller is the target themself (so /users/me always works) OR
    // when the caller is a SUPER PlatformAdmin. For every other viewer
    // the field is omitted entirely.
    // @tenant-reviewed: phase311-platform-admin-grant-revoke
    try {
      const selfLookup = !!callerId && callerId === id;
      let allowed = selfLookup;
      if (!allowed && callerId) {
        const callerPa = await (this.prisma as any).platformAdmin.findUnique({
          where: { userId: callerId }, select: { level: true },
        });
        allowed = callerPa?.level === 'SUPER';
      }
      if (allowed) {
        const pa = await (this.prisma as any).platformAdmin.findUnique({
          where: { userId: id },
          select: { level: true, grantedAt: true, grantedBy: true },
        });
        (result as any).platformAdmin = pa ? pa : { level: 'NONE' };
      }
    } catch { /* table may not exist yet */ }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Create user — sets PENDING status, empty password, sends activation email
  // ---------------------------------------------------------------------------
  async create(dto: CreateUserDto, callerRole?: string, callerAgencyId?: string, actorId?: string, callerTenantId?: string | null) {
    if (callerRole !== 'System Admin' && dto.roleId) {
      const roleName = await this.getRoleName(dto.roleId);
      if (roleName === 'System Admin') {
        throw new ForbiddenException({ code: 'USER.SYSTEM_ADMIN_ONLY_CREATE', message: 'Only System Admins can create System Admin users' });
      }
    }

    if (callerRole === 'Agency Manager') {
      if (!callerAgencyId) throw new ForbiddenException({ code: 'USER.AGENCY_NOT_ASSIGNED', message: 'Agency Manager has no agency assigned' });
      // Force the new user into the caller's agency — payload-supplied
      // agencyId is ignored so a manager can't seed another tenant.
      dto.agencyId = callerAgencyId;

      // Force the role to the seeded "Agency User" role regardless of
      // what the client sent. Covers the case where the UI would have
      // posted a different roleId either deliberately or due to a stale
      // state.
      const agencyUserRole = await this.prisma.role.findFirst({ where: { name: 'Agency User' } });
      if (!agencyUserRole) {
        throw new ForbiddenException({ code: 'USER.AGENCY_ROLE_MISSING', message: '"Agency User" role is not configured. Contact a System Administrator.' });
      }
      dto.roleId = agencyUserRole.id;

      // Enforce max users per agency limit using per-agency setting
      const agency = await this.prisma.agency.findUnique({ where: { id: callerAgencyId }, select: { maxUsersPerAgency: true } });
      const maxUsers = (agency as any)?.maxUsersPerAgency ?? 10;
      const currentCount = await this.prisma.user.count({ where: { agencyId: callerAgencyId, deletedAt: null } });
      if (currentCount >= maxUsers) {
        throw new ForbiddenException({
          code: 'USER.AGENCY_MAX_USERS',
          message: `Agency has reached the maximum user limit of ${maxUsers}. Contact a System Administrator to increase the limit.`,
          params: { maxUsers },
        });
      }
    }

    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findFirst({ where: { email: normalizedEmail } });
    if (existing) throw new ConflictException({ code: 'USER.EMAIL_EXISTS', message: 'User with this email already exists' });

    // Generate user number
    const userNumber = await this.getNextUserNumber();

    // Hash password if provided, otherwise empty hash (activated via email)
    let passwordHash = '';
    let initialStatus: string = dto.status || 'PENDING';
    if (dto.password) {
      passwordHash = await bcrypt.hash(dto.password, 12);
      if (!dto.status) initialStatus = 'ACTIVE';
    }

    // Create user with all fields
    // Agency Manager submissions land in PENDING_APPROVAL until a Tempworks
    // admin approves. Admin/HR-created users are approved immediately.
    const approvalStatus: 'PENDING_APPROVAL' | 'APPROVED' =
      callerRole === 'Agency Manager' ? 'PENDING_APPROVAL' : 'APPROVED';
    const approvedAt = approvalStatus === 'APPROVED' ? new Date() : null;
    const approvedById = approvalStatus === 'APPROVED' ? actorId ?? null : null;

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        firstName: dto.firstName,
        middleName: dto.middleName,
        lastName: dto.lastName,
        phone: dto.phone,
        roleId: dto.roleId,
        agencyId: dto.agencyId,
        status: initialStatus as any,
        userNumber,
        createdById: actorId,
        approvalStatus: approvalStatus as any,
        approvedAt: approvedAt as any,
        approvedById: approvedById as any,
        // Profile fields
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        gender: dto.gender as any,
        citizenship: dto.citizenship,
        addressLine1: dto.addressLine1,
        addressLine2: dto.addressLine2,
        city: dto.city,
        country: dto.country,
        postalCode: dto.postalCode,
        jobTitle: dto.jobTitle,
        department: dto.department,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        // Preferences
        preferredLanguage: dto.preferredLanguage,
        timeZone: dto.timeZone,
      },
      include: { role: { select: { id: true, name: true } }, agency: { select: { id: true, name: true, tenantId: true } } },
    });

    // Phase 1B (#23 #24) — stamp tenant membership so the new user can
    // log in via /auth/login-v2 and so all tenant-scoped queries find
    // them. Resolve the target tenant in this order:
    //   1. the new user's agency.tenantId (the agency they were just
    //      pinned to is authoritative);
    //   2. the caller's active tenant (covers SUPER creating a user
    //      under their currently selected tenant).
    // Membership creation is a "best effort that warns loudly" — if it
    // fails, the user row still exists and the audit script will catch
    // them; we don't want to silently roll back a successful user write.
    try {
      const targetTenantId =
        (user as any).agency?.tenantId
        ?? callerTenantId
        ?? null;
      if (targetTenantId) {
        await (this.prisma as any).tenantMembership.upsert({
          where: { userId_tenantId: { userId: user.id, tenantId: targetTenantId } },
          create: { userId: user.id, tenantId: targetTenantId, status: 'ACTIVE', joinedAt: new Date() },
          update: { status: 'ACTIVE' },
        });
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.warn(`users.create: failed to create TenantMembership for ${user.id}: ${err?.message ?? err}`);
    }

    await this.auditLog.log({
      userId: actorId,
      action: 'CREATE',
      entity: 'User',
      entityId: user.id,
      changes: {
        email: user.email,
        role: (user as any).role?.name,
        userNumber,
        firstName: user.firstName,
        lastName: user.lastName,
        status: user.status,
      },
    });

    // Generate activation token and send email (fire-and-forget) only when no password was provided
    if (!dto.password) {
      try {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const token = await this.authService.generateUserActivationToken(user.id);
        this.emailService
          .sendActivationEmail(
            user.email,
            `${user.firstName} ${user.lastName}`,
            token,
            frontendUrl,
          )
          .catch(() => undefined);
      } catch {
        // Activation email failure must not fail user creation
      }
    }

    const { passwordHash: ph, refreshToken, ...result } = user as any;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------
  async update(
    id: string,
    dto: UpdateUserDto,
    callerRole?: string,
    actorId?: string,
    callerAgencyIsSystem?: boolean,
  ) {
    const existing = await this.findOne(id, callerRole);

    if (callerRole !== 'System Admin' && existing.role?.name === 'System Admin') {
      throw new ForbiddenException({ code: 'USER.SYSTEM_ADMIN_ONLY_EDIT', message: 'Only System Admins can edit System Admin users' });
    }

    if (callerRole !== 'System Admin' && dto.roleId) {
      const roleName = await this.getRoleName(dto.roleId);
      if (roleName === 'System Admin') {
        throw new ForbiddenException({ code: 'USER.SYSTEM_ADMIN_ONLY_ASSIGN', message: 'Only System Admins can assign the System Admin role' });
      }
    }

    // Closing the strand-a-SUPER vector: a user who currently holds
    // any PlatformAdmin grant must keep the System Admin role. If the
    // update would move them off System Admin while a platform-admin
    // row exists, block it — otherwise we'd leave platform authority
    // (agencyIsSystem=true, cross-tenant bypass) attached to a
    // tenant-scoped role. The platform-admin grant must be revoked
    // first (Edit User → Platform Admin Access → NONE).
    if (dto.roleId && existing.role?.name === 'System Admin') {
      const newRoleName = await this.getRoleName(dto.roleId);
      if (newRoleName !== 'System Admin') {
        const pa = await (this.prisma as any).platformAdmin.findUnique({
          where: { userId: id }, select: { level: true },
        });
        if (pa) {
          throw new ForbiddenException({
            code: 'PLATFORM_ADMIN.ROLE_CHANGE_BLOCKED',
            message: 'Revoke this user\'s platform admin access before changing their role away from System Admin',
          });
        }
      }
    }

    // Any caller sitting in a non-system tenant agency is subject to
    // the approval gate: once a user has been approved by Tempworks,
    // the tenant can only edit them again if a Tempworks admin has
    // explicitly flipped allowManagerEdit on. System Admin + HR
    // Manager (and anyone else) inside the Tempworks root agency
    // bypass this check.
    const isExternalTenantCaller =
      callerRole !== 'System Admin' && callerAgencyIsSystem !== true;
    if (isExternalTenantCaller) {
      const approval = (existing as any).approvalStatus;
      const allow    = (existing as any).allowManagerEdit;
      if (approval === 'APPROVED' && !allow) {
        throw new ForbiddenException({ code: 'USER.PROFILE_LOCKED_EDIT', message: 'This user has been approved by Tempworks. Ask a System Administrator to enable edits for this user.' });
      }
    }

    // Strip admin-only fields if caller is not System Admin or HR Manager
    const isAdminOrHR = callerRole === 'System Admin' || callerRole === 'HR Manager';
    const updateData: any = { ...dto };
    if (!isAdminOrHR) {
      for (const field of ADMIN_ONLY_FIELDS) {
        delete updateData[field];
      }
    }

    // Convert date strings to Date objects
    if (updateData.dateOfBirth) updateData.dateOfBirth = new Date(updateData.dateOfBirth);
    if (updateData.startDate) updateData.startDate = new Date(updateData.startDate);

    // If admin is moving the user out of ACTIVE, terminate every live session:
    // null the refresh token so it can never be exchanged again. The JWT
    // strategy already re-checks user.status on every request, so any
    // outstanding access tokens are rejected on the next API call.
    const statusChangedToNonActive =
      updateData.status !== undefined
      && updateData.status !== 'ACTIVE'
      && existing.status !== updateData.status;
    if (statusChangedToNonActive) {
      updateData.refreshToken = null;
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: updateData,
      include: { role: { select: { id: true, name: true } }, agency: { select: { id: true, name: true } } },
    });

    await this.auditLog.log({
      userId: actorId,
      action: 'UPDATE',
      entity: 'User',
      entityId: id,
      changes: updateData,
    });

    if (statusChangedToNonActive) {
      await this.auditLog.log({
        userId: actorId,
        action: 'SESSIONS_TERMINATED',
        entity: 'User',
        entityId: id,
        changes: { reason: `Status changed to ${updateData.status}`, previousStatus: existing.status },
      });
    }

    const { passwordHash, refreshToken, ...result } = user as any;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Update profile (self-edit — restricted fields only)
  // ---------------------------------------------------------------------------
  async updateProfile(userId: string, dto: UpdateProfileDto, actorId?: string) {
    // Only allow the explicitly safe self-edit fields
    const safeData: any = {};
    if (dto.phone !== undefined) safeData.phone = dto.phone;
    if (dto.dateOfBirth !== undefined) safeData.dateOfBirth = new Date(dto.dateOfBirth);
    if (dto.gender !== undefined) safeData.gender = dto.gender;
    if (dto.citizenship !== undefined) safeData.citizenship = dto.citizenship;
    if (dto.addressLine1 !== undefined) safeData.addressLine1 = dto.addressLine1;
    if (dto.addressLine2 !== undefined) safeData.addressLine2 = dto.addressLine2;
    if (dto.city !== undefined) safeData.city = dto.city;
    if (dto.country !== undefined) safeData.country = dto.country;
    if (dto.postalCode !== undefined) safeData.postalCode = dto.postalCode;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: safeData,
      include: { role: { select: { id: true, name: true } } },
    });

    await this.auditLog.log({
      userId: actorId || userId,
      action: 'UPDATE_PROFILE',
      entity: 'User',
      entityId: userId,
      changes: safeData,
    });

    const { passwordHash, refreshToken, ...result } = user as any;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Update preferences
  // ---------------------------------------------------------------------------
  async updatePreferences(userId: string, dto: UpdatePreferencesDto, actorId?: string) {
    const updateData: any = {};
    if (dto.preferredLanguage !== undefined) updateData.preferredLanguage = dto.preferredLanguage;
    if (dto.timeZone !== undefined) updateData.timeZone = dto.timeZone;
    if (dto.notificationPrefs !== undefined) updateData.notificationPrefs = dto.notificationPrefs;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
      include: { role: { select: { id: true, name: true } } },
    });

    await this.auditLog.log({
      userId: actorId || userId,
      action: 'UPDATE_PREFERENCES',
      entity: 'User',
      entityId: userId,
      changes: updateData,
    });

    const { passwordHash, refreshToken, ...result } = user as any;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Upload photo
  // ---------------------------------------------------------------------------
  async uploadPhoto(userId: string, file: Express.Multer.File, actorId?: string) {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { photoUrl: true },
    });
    if (!existing) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `users/${userId}/avatars`,
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: true,
    });

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { photoUrl: upload.url },
      include: { role: { select: { id: true, name: true } } },
    });

    if (existing.photoUrl && existing.photoUrl !== upload.url) {
      await this.storage.deleteFileByUrlOrKey(existing.photoUrl);
    }

    await this.auditLog.log({
      userId: actorId,
      action: 'UPLOAD_PHOTO',
      entity: 'User',
      entityId: userId,
      changes: { photoUrl: upload.url },
    });

    const { passwordHash, refreshToken, ...result } = user as any;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Phase 3.14 admin bootstrap — set or clear a user's PlatformAdmin level.
  // Used by the User edit page. Writes a PlatformAuditLog row (best-effort).
  // @tenant-reviewed: phase311-platform-admin-grant-revoke
  async setPlatformAdminLevel(
    targetUserId: string,
    level: 'NONE' | 'SUPPORT' | 'OPERATOR' | 'SUPER',
    reason: string,
    actorUserId?: string,
  ) {
    if (!['NONE', 'SUPPORT', 'OPERATOR', 'SUPER'].includes(level)) {
      throw new BadRequestException({ code: 'PLATFORM_ADMIN.INVALID_LEVEL' });
    }
    if (!actorUserId) {
      throw new ForbiddenException({ code: 'PLATFORM_ADMIN.MISSING_ACTOR' });
    }
    const actorPa = await (this.prisma as any).platformAdmin.findUnique({
      where: { userId: actorUserId }, select: { level: true },
    });
    if (!actorPa || actorPa.level !== 'SUPER') {
      throw new ForbiddenException({ code: 'PLATFORM_ADMIN.ACTOR_NOT_SUPER' });
    }
    if (actorUserId === targetUserId && level === 'NONE') {
      throw new ForbiddenException({ code: 'PLATFORM_ADMIN.SELF_REVOKE_FORBIDDEN' });
    }
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, deletedAt: null },
      select: { id: true, role: { select: { name: true } } },
    });
    if (!target) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    // Core rule: platform-admin authority (any non-NONE level) may
    // only be granted to a user holding the tenant-level System Admin
    // role. Every level sets agencyIsSystem=true and bypasses tenant
    // isolation, so granting it to a tenant/agency-scoped user would
    // be a cross-tenant escalation. Revoking (NONE) is always allowed.
    if (level !== 'NONE' && target.role?.name !== 'System Admin') {
      throw new ForbiddenException({
        code: 'PLATFORM_ADMIN.TARGET_NOT_SYSTEM_ADMIN',
        message: 'Platform admin access can only be granted to System Admin users',
      });
    }

    const existing = await (this.prisma as any).platformAdmin.findUnique({
      where: { userId: targetUserId }, select: { level: true },
    });

    let action = 'PLATFORM_ADMIN_GRANT_IDEMPOTENT';
    if (level === 'NONE') {
      if (!existing) action = 'PLATFORM_ADMIN_REVOKE_IDEMPOTENT';
      else {
        await (this.prisma as any).platformAdmin.delete({ where: { userId: targetUserId } });
        action = 'PLATFORM_ADMIN_REVOKED';
      }
    } else if (!existing) {
      await (this.prisma as any).platformAdmin.create({
        data: { userId: targetUserId, level: level as any, grantedBy: actorUserId ?? null },
      });
      action = 'PLATFORM_ADMIN_GRANTED';
    } else if (existing.level !== level) {
      await (this.prisma as any).platformAdmin.update({
        where: { userId: targetUserId },
        data: { level: level as any, grantedBy: actorUserId ?? null, grantedAt: new Date() },
      });
      action = 'PLATFORM_ADMIN_LEVEL_CHANGED';
    }

    try {
      await (this.prisma as any).platformAuditLog.create({
        data: {
          actorId: actorUserId ?? 'system',
          action, reason: reason || 'admin-ui',
          target: { targetUserId, previousLevel: existing?.level ?? null, newLevel: level === 'NONE' ? null : level },
        },
      });
    } catch { /* table may not exist yet in some envs */ }

    return { action, targetUserId, level };
  }

  // ---------------------------------------------------------------------------
  // Unlock user
  // ---------------------------------------------------------------------------
  async unlockUser(userId: string, actorId?: string) {
    const existing = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!existing) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedAt: null },
      include: { role: { select: { id: true, name: true } } },
    });

    await this.auditLog.log({
      userId: actorId,
      action: 'USER_UNLOCKED',
      entity: 'User',
      entityId: userId,
      changes: { failedLoginAttempts: 0, lockedAt: null },
    });

    const { passwordHash, refreshToken, ...result } = user as any;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Grant/revoke permission override
  // ---------------------------------------------------------------------------
  async setPermissionOverride(userId: string, permission: string, granted: boolean, actorId?: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    const override = await this.prisma.agencyUserPermission.upsert({
      where: { userId_permission: { userId, permission } },
      create: { userId, permission, granted, grantedById: actorId },
      update: { granted, grantedById: actorId },
    });

    await this.auditLog.log({
      userId: actorId,
      action: granted ? 'PERMISSION_GRANTED' : 'PERMISSION_REVOKED',
      entity: 'User',
      entityId: userId,
      changes: { permission, granted },
    });

    return override;
  }

  async removePermissionOverride(userId: string, permission: string, actorId?: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    try {
      await this.prisma.agencyUserPermission.delete({
        where: { userId_permission: { userId, permission } },
      });
    } catch {
      throw new NotFoundException({ code: 'USER.PERMISSION_OVERRIDE_NOT_FOUND', message: 'Permission override not found' });
    }

    await this.auditLog.log({
      userId: actorId,
      action: 'PERMISSION_OVERRIDE_REMOVED',
      entity: 'User',
      entityId: userId,
      changes: { permission },
    });

    return { message: 'Permission override removed' };
  }

  async getUserPermissions(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        permissionOverrides: true,
      },
    });
    if (!user) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    const rolePermissions = (user as any).role?.permissions?.map((rp: any) => ({
      permission: rp.permission?.name,
      source: 'role',
      granted: true,
    })) ?? [];

    const overrides = (user as any).permissionOverrides?.map((po: any) => ({
      permission: po.permission,
      source: 'override',
      granted: po.granted,
    })) ?? [];

    return { rolePermissions, overrides };
  }

  // ---------------------------------------------------------------------------
  // Remove (soft delete)
  // ---------------------------------------------------------------------------
  async remove(id: string, callerRole?: string, actorId?: string, callerAgencyIsSystem?: boolean) {
    const existing = await this.findOne(id, callerRole);

    if (callerRole !== 'System Admin' && existing.role?.name === 'System Admin') {
      throw new ForbiddenException({ code: 'USER.SYSTEM_ADMIN_ONLY_DELETE', message: 'Only System Admins can delete System Admin users' });
    }

    // Any caller sitting in a non-system tenant agency is subject to
    // the delete approval gate — Agency Manager, tenant HR Manager,
    // tenant Recruiter, etc. all need an explicit allowManagerDelete
    // override on an approved user.
    const isExternalTenantCaller =
      callerRole !== 'System Admin' && callerAgencyIsSystem !== true;
    if (isExternalTenantCaller) {
      const approval = (existing as any).approvalStatus;
      const allow    = (existing as any).allowManagerDelete;
      if (approval === 'APPROVED' && !allow) {
        throw new ForbiddenException({ code: 'USER.PROFILE_LOCKED_DELETE', message: 'This user has been approved by Tempworks. Ask a System Administrator to enable deletion for this user.' });
      }
    }

    await this.prisma.user.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId ?? null } });

    await this.auditLog.log({
      userId: actorId,
      action: 'DELETE',
      entity: 'User',
      entityId: id,
      changes: { email: existing.email },
    });

    return { message: 'User deleted successfully' };
  }

  // ---------------------------------------------------------------------------
  // Bulk import (CSV)
  // ---------------------------------------------------------------------------
  async bulkImport(records: any[], actorId?: string): Promise<{ success: number; failed: number; errors: string[] }> {
    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const rowLabel = `Row ${i + 1}`;

      // Validate required fields
      if (!record.email || !record.firstName || !record.lastName || !record.roleId) {
        failed++;
        errors.push(`${rowLabel}: Missing required fields (email, firstName, lastName, roleId)`);
        continue;
      }

      // Check for duplicate email
      const bulkEmail = record.email.trim().toLowerCase();
      const existing = await this.prisma.user.findFirst({ where: { email: bulkEmail } });
      if (existing) {
        failed++;
        errors.push(`${rowLabel}: User with email ${record.email} already exists`);
        continue;
      }

      try {
        const userNumber = await this.getNextUserNumber();
        await this.prisma.user.create({
          data: {
            email: bulkEmail,
            passwordHash: '',
            firstName: record.firstName,
            middleName: record.middleName,
            lastName: record.lastName,
            phone: record.phone,
            roleId: record.roleId,
            agencyId: record.agencyId,
            status: 'PENDING',
            userNumber,
            createdById: actorId,
            dateOfBirth: record.dateOfBirth ? new Date(record.dateOfBirth) : undefined,
            gender: record.gender,
            citizenship: record.citizenship,
            jobTitle: record.jobTitle,
            department: record.department,
          },
        });
        success++;
      } catch (err: any) {
        failed++;
        errors.push(`${rowLabel}: ${err.message}`);
      }
    }

    if (success > 0) {
      await this.auditLog.log({
        userId: actorId,
        action: 'BULK_IMPORT',
        entity: 'User',
        entityId: 'bulk',
        changes: { success, failed, total: records.length },
      });
    }

    // Spec §4.11 — SYSTEM_BULK_JOB_RESULT auto-emit. The admin endpoint
    // (Stage 7) stays the manual lever; this fires automatically at
    // the tail of the real bulk-import flow so admins see the outcome
    // without polling. Success: NORMAL priority. Failure (any
    // skipped row): HIGH so the inbox surfaces it above routine
    // traffic.
    const ok = failed === 0;
    this.notifications.notifyAllUsers(
      undefined, // user bulk-imports are platform-wide; no tenant narrowing.
      NOTIF_EVENTS.SYSTEM_BULK_JOB_RESULT,
      ok ? 'Bulk user import completed' : 'Bulk user import finished with errors',
      ok
        ? `${success} user(s) imported successfully.`
        : `${success} imported, ${failed} failed. See system logs for row-level details.`,
      'SYSTEM',
      'bulk-users',
      {
        titleKey: 'events.systemBulkJobResult.title',
        messageKey: 'events.systemBulkJobResult.body',
        params: { jobId: 'bulk-users', success: ok, imported: success, failed, total: records.length },
      },
      ok ? 'NORMAL' : 'HIGH',
    ).catch(() => undefined);

    return { success, failed, errors };
  }

  // ---------------------------------------------------------------------------
  // Bulk export
  // ---------------------------------------------------------------------------
  async bulkExport(query: any, callerRole?: string, callerAgencyId?: string): Promise<any[]> {
    const where: any = { deletedAt: null };

    if (callerRole === 'Agency Manager') {
      if (!callerAgencyId) throw new ForbiddenException({ code: 'USER.AGENCY_NOT_ASSIGNED', message: 'Agency Manager has no agency assigned' });
      where.agencyId = callerAgencyId;
    } else if (callerRole !== 'System Admin') {
      where.AND = [{ role: { name: { not: 'System Admin' } } }];
      if (query.agencyId) where.agencyId = query.agencyId;
    } else {
      if (query.agencyId) where.agencyId = query.agencyId;
    }

    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.roleId) where.roleId = query.roleId;
    if (query.status) where.status = query.status;

    const users = await this.prisma.user.findMany({
      where,
      select: {
        ...this.fullUserSelect,
        role: { select: { id: true, name: true } },
        agency: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Ensure no sensitive fields leaked (already excluded via select)
    return users;
  }

  // ---------------------------------------------------------------------------
  // Agency user approval + manager override flags (Tempworks admin only)
  // ---------------------------------------------------------------------------
  async approveAgencyUser(id: string, actorId?: string) {
    const existing = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        approvalStatus: 'APPROVED' as any,
        approvedById: actorId ?? null,
        approvedAt: new Date(),
      },
      include: { role: { select: { id: true, name: true } }, agency: { select: { id: true, name: true } } },
    });
    await this.auditLog.log({
      userId: actorId, action: 'APPROVE_AGENCY_USER', entity: 'User', entityId: id,
      changes: { previous: (existing as any).approvalStatus, next: 'APPROVED' },
    });
    const { passwordHash, refreshToken, ...result } = user as any;
    return result;
  }

  async setManagerOverride(
    id: string,
    flags: { allowManagerView?: boolean; allowManagerEdit?: boolean; allowManagerDelete?: boolean },
    actorId?: string,
  ) {
    const existing = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });
    const data: any = {};
    if (typeof flags.allowManagerView === 'boolean')   data.allowManagerView   = flags.allowManagerView;
    if (typeof flags.allowManagerEdit === 'boolean')   data.allowManagerEdit   = flags.allowManagerEdit;
    if (typeof flags.allowManagerDelete === 'boolean') data.allowManagerDelete = flags.allowManagerDelete;
    const user = await this.prisma.user.update({
      where: { id }, data,
      include: { role: { select: { id: true, name: true } }, agency: { select: { id: true, name: true } } },
    });
    await this.auditLog.log({
      userId: actorId, action: 'SET_MANAGER_OVERRIDE', entity: 'User', entityId: id,
      changes: data,
    });
    const { passwordHash, refreshToken, ...result } = user as any;
    return result;
  }

  async getActivationLink(userId: string): Promise<{ url: string }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });

    if (user.status !== 'PENDING' && user.status !== 'INACTIVE') {
      throw new BadRequestException({ code: 'AUTH.ACCOUNT_STATUS', message: 'Activation link is only available for PENDING or INACTIVE accounts' });
    }

    // Invalidate old unused tokens and generate a fresh one
    await this.prisma.activationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = await this.authService.generateUserActivationToken(userId);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return { url: `${frontendUrl}/activate?token=${token}` };
  }
}
