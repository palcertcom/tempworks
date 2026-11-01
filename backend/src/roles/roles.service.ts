import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logs/audit-log.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { CreateRoleDto } from './dto/create-role.dto';

/**
 * Phase 2.6 — first TenantPrisma pilot module.
 *
 * Role / Permission / RolePermission are classified GLOBAL in
 * `tenant-scoped-models.ts`. The pilot proves the access pattern works
 * end-to-end: when `TENANT_PRISMA_PILOT_ENABLED=true` and the env is
 * SAFE_CLONE / SAFE_STAGING, Prisma calls go through
 * `TenantPrismaService.client`, which is a pass-through for global
 * tables. With the flag OFF (production default), behaviour is byte-
 * for-byte identical to before — we keep using `PrismaService`.
 *
 * `legacyPrisma` is kept around so callers / tests can still reach the
 * raw client when needed; the rehearsal harness uses it to compare
 * legacy vs pilot output.
 */
@Injectable()
export class RolesService {
  constructor(
    private legacyPrisma: PrismaService,
    private auditLog: AuditLogService,
    private pilot: PilotPrismaAccessor,
  ) {}

  /** Prisma surface chosen by the pilot accessor. Use everywhere below. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  async findAll(callerRole?: string) {
    const isAdmin = callerRole === 'System Admin';
    const roleFilter = callerRole === 'Agency Manager'
      ? { name: 'Agency User' }
      : isAdmin ? {} : { NOT: { name: 'System Admin' } };
    const where = { ...roleFilter, deletedAt: null };

    return this.prisma.role.findMany({ // @tenant-reviewed: phase26-pilot-accessor (Role is GLOBAL)
      where,
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const role = await this.prisma.role.findFirst({ // @tenant-reviewed: phase26-pilot-accessor
      where: { id, deletedAt: null },
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: true } },
      },
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async create(dto: CreateRoleDto, actorId?: string) {
    const existing = await this.prisma.role.findUnique({ where: { name: dto.name } }); // @tenant-reviewed: phase26-pilot-accessor
    if (existing) throw new ConflictException('Role with this name already exists');

    const role = await this.prisma.role.create({ // @tenant-reviewed: phase26-pilot-accessor
      data: {
        name: dto.name,
        description: dto.description,
        permissions: dto.permissionIds
          ? { create: dto.permissionIds.map((id) => ({ permissionId: id })) }
          : undefined,
      },
      include: { permissions: { include: { permission: true } } },
    });

    await this.auditLog.log({
      userId: actorId,
      action: 'CREATE',
      entity: 'Role',
      entityId: role.id,
      changes: { name: role.name, permissionCount: dto.permissionIds?.length ?? 0 },
    });

    return role;
  }

  async update(id: string, dto: Partial<CreateRoleDto>, actorId?: string) {
    const role = await this.findOne(id);
    if (role.isSystem && dto.name && dto.name !== role.name) throw new BadRequestException('Cannot rename system roles');

    if (dto.permissionIds !== undefined) {
      await this.prisma.rolePermission.deleteMany({ where: { roleId: id } }); // @tenant-reviewed: phase26-pilot-accessor
      if (dto.permissionIds.length > 0) {
        await this.prisma.rolePermission.createMany({ // @tenant-reviewed: phase26-pilot-accessor
          data: dto.permissionIds.map((pid) => ({ roleId: id, permissionId: pid })),
        });
      }
    }

    const updated = await this.prisma.role.update({ // @tenant-reviewed: phase26-pilot-accessor
      where: { id },
      data: { name: dto.name, description: dto.description },
      include: { permissions: { include: { permission: true } } },
    });

    await this.auditLog.log({
      userId: actorId,
      action: 'UPDATE',
      entity: 'Role',
      entityId: id,
      changes: { name: dto.name, permissionsUpdated: dto.permissionIds !== undefined },
    });

    return updated;
  }

  async remove(id: string, actorId?: string) {
    const role = await this.findOne(id);
    if (role.isSystem) throw new BadRequestException('Cannot delete system roles');
    await this.prisma.role.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId ?? null } }); // @tenant-reviewed: phase26-pilot-accessor

    await this.auditLog.log({
      userId: actorId,
      action: 'DELETE',
      entity: 'Role',
      entityId: id,
      changes: { name: role.name },
    });

    return { message: 'Role deleted successfully' };
  }

  async getPermissions() {
    return this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { action: 'asc' }] }); // @tenant-reviewed: phase26-pilot-accessor
  }

  async getPermissionsMatrix() {
    const [roles, permissions] = await Promise.all([
      this.prisma.role.findMany({ include: { permissions: true } }),       // @tenant-reviewed: phase26-pilot-accessor
      this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { action: 'asc' }] }), // @tenant-reviewed: phase26-pilot-accessor
    ]);

    const matrix = roles.map((role) => ({
      role: { id: role.id, name: role.name },
      permissions: permissions.map((perm) => ({
        id: perm.id,
        name: perm.name,
        module: perm.module,
        action: perm.action,
        granted: role.permissions.some((rp) => rp.permissionId === perm.id),
      })),
    }));

    return { roles: roles.map((r) => ({ id: r.id, name: r.name })), permissions, matrix };
  }
}
