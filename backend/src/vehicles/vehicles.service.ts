import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { decodeUploadFilename } from '../common/storage/multer.config';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { tServer, ServerLocale } from '../common/i18n/server-translate';
import { formatDisplayDateTime } from '../common/i18n/date-format';
import * as ExcelJS from 'exceljs';
const PDFDocument = require('pdfkit') as typeof import('pdfkit');
import {
  FilterVehiclesDto,
  CreateVehicleDto,
  UpdateVehicleDto,
  AssignDriverDto,
  CreateVehicleDocumentDto,
  UpdateVehicleDocumentDto,
  CreateMaintenanceTypeDto,
  UpdateMaintenanceTypeDto,
  CreateWorkshopDto,
  UpdateWorkshopDto,
  CreateMaintenanceRecordDto,
  UpdateMaintenanceRecordDto,
  FilterMaintenanceDto,
  ExportVehiclesDto,
} from './dto/vehicles.dto';

const VEHICLE_INCLUDE = {
  agency: { select: { id: true, name: true } },
  driverAssignments: {
    where: { isActive: true },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, licenseNumber: true, licenseCategory: true } },
    },
    take: 1,
  },
  maintenanceRecords: {
    where: { deletedAt: null, completedDate: { not: null } },
    select: {
      id: true,
      status: true,
      completedDate: true,
      description: true,
      cost: true,
      maintenanceTypeId: true,
      maintenanceType: { select: { id: true, name: true } },
      workshop: { select: { id: true, name: true } },
    },
    orderBy: { completedDate: 'desc' as const },
    take: 1,
  },
  _count: { select: { documents: true, maintenanceRecords: true } },
};

/**
 * Phase 2.23 — Vehicles reads-first pilot.
 *
 * READ paths route through `pilot.client()` and spread
 * `scope.tenantWhere()` when the pilot scope is active. Production
 * default (flag off) is byte-identical to pre-2.23.
 *
 * WRITE / mutation paths (create / update / delete / assign /
 * unassign / addDocument / addMaintenanceRecord etc.) and
 * storage-bound paths (`addMaintenanceAttachment`, document
 * upload/delete) explicitly use `legacyPrisma` and remain annotated
 * `phase223-excluded-mutation` / `phase223-excluded-storage` until
 * follow-up pilots audit them.
 *
 * `Workshop` and `MaintenanceType` are tenant-less catalogs; their
 * reads are `phase223-global`. Per-tenant catalog overrides are a
 * Phase 3 product question.
 *
 * `VehicleDriverAssignment` has no `tenantId` column today;
 * `getDriverHistory` is gated by the parent vehicle's tenant
 * pre-check.
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly legacyPrisma: PrismaService,
    private readonly storage: StorageService,
    private readonly pilot: PilotPrismaAccessor,
  ) {}

  /** Pilot-aware Prisma surface used by READ paths only. Mutation
   *  paths use `legacyPrisma` directly. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'vehicles');
  }

  /**
   * Phase 3.19 — caller-driven tenant filter for the Fleet pages.
   * PlatformAdmin bypasses; everyone else sees only their own tenant's
   * vehicles / workshops / maintenance records. Returns `{}` when no
   * tenant context (legacy single-tenant DBs).
   * @tenant-reviewed: phase319-fleet-tenant-scope
   */
  private callerTenantWhere(caller: any): Record<string, any> {
    if (!caller) return {};
    // Phase 2 (#5) — every caller (including SUPER admins) follows the
    // currently-selected tenant on reads. Records with tenantId=NULL
    // become invisible by design; backfill them via the audit scripts.
    const t = caller.tenantId;
    if (!t) return {};
    return { tenantId: t };
  }

  /** SUPER PlatformAdmin check — used to gate cross-tenant reassignment. */
  private async isCallerSuperPlatformAdmin(caller: any): Promise<boolean> {
    if (!caller?.id) return false;
    try {
      const row = await (this.prisma as any).platformAdmin.findUnique({
        where: { userId: caller.id }, select: { level: true },
      });
      return row?.level === 'SUPER';
    } catch { return false; }
  }

  // ── Vehicles ────────────────────────────────────────────────────────────────

  async listVehicles(dto: FilterVehiclesDto, caller?: any) {
    const { page = 1, limit = 20, search, type, status, agencyId, expiringInDays } = dto;
    const skip = (page - 1) * limit;

    // Phase F2 (SPIKE-010 Batch 2) — SUPER USER tenant override.
    await assertRequestedTenantExists(caller, (dto as any).tenantId, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, (dto as any).tenantId);

    const t = this.scope().tenantWhere();
    const where: any = { deletedAt: null, ...t, ...this.callerTenantWhere(caller) };
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];

    if (search) {
      where.OR = [
        { registrationNumber: { contains: search, mode: 'insensitive' } },
        { make: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
        { vin: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (type)     where.type     = type;
    if (status)   where.status   = status;
    if (agencyId) where.agencyId = agencyId;

    if (expiringInDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + expiringInDays);
      where.OR = [
        ...(where.OR ?? []),
        { motExpiryDate: { lte: cutoff } },
        { taxExpiryDate: { lte: cutoff } },
        { insuranceExpiryDate: { lte: cutoff } },
      ];
    }

    const [vehicles, total] = await Promise.all([
      this.prisma.vehicle.findMany({ where, skip, take: limit, include: VEHICLE_INCLUDE, orderBy: { createdAt: 'desc' } }), // @tenant-reviewed: phase223-pilot-scope
      this.prisma.vehicle.count({ where }), // @tenant-reviewed: phase223-pilot-scope
    ]);

    return { data: vehicles, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getVehicle(id: string, caller?: any) {
    const t = this.scope().tenantWhere();
    const vehicle = await this.prisma.vehicle.findFirst({ // @tenant-reviewed: phase319-fleet-tenant-scope
      where: { id, deletedAt: null, ...t, ...this.callerTenantWhere(caller) },
      include: {
        agency: { select: { id: true, name: true } },
        driverAssignments: {
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, licenseNumber: true, licenseCategory: true, photoUrl: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        documents: { where: { deletedAt: null } as any, orderBy: { createdAt: 'desc' } },
        maintenanceRecords: {
          where: { deletedAt: null } as any,
          select: {
            id: true,
            status: true,
            scheduledDate: true,
            completedDate: true,
            description: true,
            mileageAtService: true,
            cost: true,
            laborCost: true,
            partsCost: true,
            notes: true,
            maintenanceTypeId: true,
            maintenanceType: { select: { id: true, name: true } },
            workshopId: true,
            workshop: { select: { id: true, name: true, address: true, city: true, country: true, phone: true, email: true } },
            spareParts: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  // Centralised list of date-bearing string fields on the Vehicle DTO.
  // Each one is stored as a DATE column on the vehicles table, so empty
  // strings must be coerced to null and non-empty values parsed via Date.
  private readonly VEHICLE_DATE_FIELDS = [
    'motExpiryDate',
    'taxExpiryDate',
    'insuranceExpiryDate',
    'registrationExpiryDate',
    'purchaseDate',
    'insuranceStartDate',
    'tachographCalibrationExpiry',
    'lastPressureTestDate',
    'nextPressureTestDate',
    'atpCertificateExpiry',
  ] as const;

  /** Strip date strings out of the DTO and rewrite them as Date objects. */
  private normaliseVehicleDates(dto: any, isCreate: boolean): any {
    const data: any = { ...dto };
    for (const field of this.VEHICLE_DATE_FIELDS) {
      const v = data[field];
      if (isCreate) {
        // On create we only forward the column when the caller actually
        // supplied a value — undefined keeps the default null.
        if (v) data[field] = new Date(v);
        else delete data[field];
      } else if (v !== undefined) {
        data[field] = v ? new Date(v) : null;
      }
    }
    return data;
  }

  async createVehicle(dto: CreateVehicleDto, userId: string, caller?: any) {
    const data: any = this.normaliseVehicleDates(dto, true);
    data.createdById = userId;
    data.updatedById = userId;
    const tdata = this.scope().tenantData();
    // Phase 2C (#23) — every caller (incl. SUPER) defaults the new
    // vehicle's tenant to their active tenant. A SUPER may still
    // explicitly target a different tenant via dto.tenantId.
    // @tenant-reviewed: phase319-fleet-tenant-scope
    const isSuper = await this.isCallerSuperPlatformAdmin(caller);
    const explicit = isSuper && typeof (dto as any).tenantId === 'string' && (dto as any).tenantId.trim()
      ? (dto as any).tenantId.trim()
      : undefined;
    // Phase 3 (#1 R-4) — validate an explicit SUPER tenant pin against
    // the tenants table, matching the patterns in agencies.service.ts
    // (line ~177) and job-ads.service.ts. Without this, a SUPER could
    // silently create a vehicle attributed to a non-existent tenant.
    if (explicit) {
      const t = await this.prisma.tenant.findUnique({ where: { id: explicit }, select: { id: true } }).catch(() => null);
      if (!t) {
        throw new BadRequestException({
          code: 'TENANT.NOT_FOUND',
          message: 'Selected tenant does not exist.',
          params: { tenantId: explicit },
        });
      }
    }
    const callerTenantId = explicit ?? caller?.tenantId ?? undefined;
    if (callerTenantId) data.tenantId = callerTenantId;
    delete (data as any).tenantIdRequest;
    return this.legacyPrisma.vehicle.create({ data: { ...data, ...tdata }, include: VEHICLE_INCLUDE });
  }

  async updateVehicle(id: string, dto: UpdateVehicleDto, userId: string, caller?: any) {
    await this.findVehicleOrFail(id, caller);
    const data: any = this.normaliseVehicleDates(dto, false);
    data.updatedById = userId;
    // SUPER PlatformAdmin may move the vehicle to a different tenant.
    if ((dto as any).tenantId !== undefined) {
      const isSuper = await this.isCallerSuperPlatformAdmin(caller);
      if (isSuper) {
        const v = String((dto as any).tenantId ?? '').trim();
        if (v) {
          const t = await this.prisma.tenant.findUnique({ where: { id: v }, select: { id: true } }).catch(() => null);
          if (!t) throw new NotFoundException(`Tenant ${v} not found`);
          data.tenantId = v;
        }
      } else {
        delete data.tenantId;
      }
    }
    return this.legacyPrisma.vehicle.update({ where: { id }, data, include: VEHICLE_INCLUDE });
  }

  async deleteVehicle(id: string, userId: string, caller?: any) {
    await this.findVehicleOrFail(id, caller);
    await this.legacyPrisma.vehicle.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: userId },
    });
    return { message: 'Vehicle deleted successfully' };
  }

  private async findVehicleOrFail(id: string, caller?: any) {
    const t = this.scope().tenantWhere();
    const v = await this.prisma.vehicle.findFirst({
      where: { id, deletedAt: null, ...t, ...this.callerTenantWhere(caller) },
    });
    if (!v) throw new NotFoundException('Vehicle not found');
    return v;
  }

  // ── Driver Assignments ───────────────────────────────────────────────────────

  async assignDriver(vehicleId: string, dto: AssignDriverDto, userId: string) {
    await this.findVehicleOrFail(vehicleId);

    // Phase 2.24 — cross-tenant employee probe. In pilot mode the
    // lookup carries `tenantId = ALS.tenantId`; cross-tenant
    // employee ids raise NotFoundException before any assignment
    // mutation. In legacy mode the spread is `{}` and the lookup
    // matches by id alone (no worse than today, where the employee
    // was not validated at all).
    const t = this.scope().tenantWhere();
    const emp = await this.prisma.employee.findFirst({ where: { id: dto.employeeId, ...t }, select: { id: true } }); // @tenant-reviewed: phase224-pilot-scope (cross-tenant employee probe)
    if (!emp) throw new NotFoundException('Employee not found');

    // Deactivate any existing active assignment for this vehicle
    await this.legacyPrisma.vehicleDriverAssignment.updateMany({ // @tenant-reviewed: phase224-pilot-scope-precheck (parent vehicle tenant-checked above)
      where: { vehicleId, isActive: true },
      data: { isActive: false, endDate: new Date() },
    });

    return this.legacyPrisma.vehicleDriverAssignment.create({ // @tenant-reviewed: phase224-pilot-scope-precheck (parent vehicle + employee tenant-checked above)
      data: {
        vehicleId,
        employeeId: dto.employeeId,
        startDate:  new Date(dto.startDate),
        isActive:   true,
        notes:      dto.notes,
      },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, licenseNumber: true, licenseCategory: true } },
      },
    });
  }

  async unassignDriver(vehicleId: string, assignmentId: string) {
    // Phase 2.24 — explicit parent vehicle gate before the
    // by-id assignment lookup.
    await this.findVehicleOrFail(vehicleId);
    const assignment = await this.legacyPrisma.vehicleDriverAssignment.findFirst({ // @tenant-reviewed: phase224-pilot-scope-precheck (parent vehicle tenant-checked above; vehicleId predicate ties this lookup to the same parent)
      where: { id: assignmentId, vehicleId, isActive: true },
    });
    if (!assignment) throw new NotFoundException('Active driver assignment not found');

    return this.legacyPrisma.vehicleDriverAssignment.update({ // @tenant-reviewed: phase224-pilot-scope-precheck
      where: { id: assignmentId },
      data: { isActive: false, endDate: new Date() },
    });
  }

  async getDriverHistory(vehicleId: string) {
    await this.findVehicleOrFail(vehicleId);
    return this.prisma.vehicleDriverAssignment.findMany({ // @tenant-reviewed: phase223-pilot-scope (parent vehicle was tenant-checked by findVehicleOrFail above)
      where: { vehicleId },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, licenseNumber: true, licenseCategory: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Documents ────────────────────────────────────────────────────────────────

  async addDocument(vehicleId: string, dto: CreateVehicleDocumentDto, userId: string, file?: Express.Multer.File) {
    // Phase 2.25 — STORAGE GUARD. The tenant-scoped findVehicleOrFail
    // (Phase 2.23) raises 404 BEFORE storage.uploadFile when the
    // vehicle belongs to another tenant. Pilot mode also writes
    // tenantId on the new VehicleDocument via scope.tenantData().
    await this.findVehicleOrFail(vehicleId);
    const { expiryDate, issuedDate, ...rest } = dto;
    const data: any = { ...rest, vehicleId, uploadedById: userId };
    if (expiryDate)  data.expiryDate  = new Date(expiryDate);
    if (issuedDate)  data.issuedDate  = new Date(issuedDate);
    if (file) {
      const displayName = decodeUploadFilename(file.originalname);
      const upload = await this.storage.uploadFile(file.buffer, {
        keyPrefix: `vehicles/${vehicleId}/documents`,
        contentType: file.mimetype,
        originalName: displayName,
        inline: file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),
      });
      data.fileUrl  = upload.url;
      data.fileName = displayName;
      data.fileSize = file.size;
    }
    const tdata = this.scope().tenantData();
    return this.legacyPrisma.vehicleDocument.create({ data: { ...data, ...tdata } }); // @tenant-reviewed: phase225-pilot-scope (writes tenantId via scope.tenantData; parent vehicle tenant-checked above)
  }

  async updateDocument(vehicleId: string, docId: string, dto: UpdateVehicleDocumentDto) {
    // Phase 2.25 — explicit parent-vehicle gate before the by-id
    // document lookup. Pre-2.25 the lookup was by `{ id, vehicleId }`
    // alone, which allowed cross-tenant mutation when both ids were
    // foreign. The findVehicleOrFail call raises 404 in pilot mode
    // for cross-tenant vehicleIds.
    await this.findVehicleOrFail(vehicleId);
    const doc = await this.legacyPrisma.vehicleDocument.findFirst({ where: { id: docId, vehicleId } }); // @tenant-reviewed: phase225-pilot-scope-precheck (parent vehicle tenant-checked above; vehicleId predicate ties this lookup to the same parent)
    if (!doc) throw new NotFoundException('Document not found');

    const { expiryDate, issuedDate, ...rest } = dto;
    const data: any = { ...rest };
    if (expiryDate !== undefined) data.expiryDate = expiryDate ? new Date(expiryDate) : null;
    if (issuedDate !== undefined) data.issuedDate = issuedDate ? new Date(issuedDate) : null;

    return this.legacyPrisma.vehicleDocument.update({ where: { id: docId }, data }); // @tenant-reviewed: phase225-pilot-scope-precheck
  }

  async deleteDocument(vehicleId: string, docId: string, userId?: string) {
    // Phase 2.25 — same explicit parent-vehicle gate.
    await this.findVehicleOrFail(vehicleId);
    const doc = await this.legacyPrisma.vehicleDocument.findFirst({ where: { id: docId, vehicleId } as any }); // @tenant-reviewed: phase225-pilot-scope-precheck (parent vehicle tenant-checked above)
    if (!doc) throw new NotFoundException('Document not found');
    if ((doc as any).deletedAt) throw new NotFoundException('Document not found');
    await (this.legacyPrisma.vehicleDocument as any).update({ // @tenant-reviewed: phase225-pilot-scope-precheck
      where: { id: docId },
      data: { deletedAt: new Date(), deletedBy: userId ?? null },
    });
    return { message: 'Document deleted successfully' };
  }

  // ── Maintenance Types ────────────────────────────────────────────────────────

  async listMaintenanceTypes() {
    try {
      return await this.prisma.maintenanceType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }); // @tenant-reviewed: phase223-global
    } catch (error: any) {
      // If the table doesn't exist yet, return empty array gracefully
      if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
        return [];
      }
      throw error;
    }
  }

  async createMaintenanceType(dto: CreateMaintenanceTypeDto) {
    const data: any = { ...dto };
    if (data.intervalMode) {
      data.intervalMode = data.intervalMode.toUpperCase();
    }
    return this.legacyPrisma.maintenanceType.create({ data }); // @tenant-reviewed: phase223-excluded-mutation
  }

  async updateMaintenanceType(id: string, dto: UpdateMaintenanceTypeDto) {
    const mt = await this.prisma.maintenanceType.findUnique({ where: { id } }); // @tenant-reviewed: phase223-global
    if (!mt) throw new NotFoundException('Maintenance type not found');
    const data: any = { ...dto };
    if (data.intervalMode) {
      data.intervalMode = data.intervalMode.toUpperCase();
    }
    return this.legacyPrisma.maintenanceType.update({ where: { id }, data }); // @tenant-reviewed: phase223-excluded-mutation
  }

  async deleteMaintenanceType(id: string, userId?: string) {
    const mt = await this.prisma.maintenanceType.findUnique({ where: { id } }); // @tenant-reviewed: phase223-global
    if (!mt) throw new NotFoundException('Maintenance type not found');
    if ((mt as any).deletedAt) throw new NotFoundException('Maintenance type not found');
    await (this.legacyPrisma.maintenanceType as any).update({ // @tenant-reviewed: phase223-excluded-mutation
      where: { id },
      data: { deletedAt: new Date(), deletedBy: userId ?? null },
    });
    return { message: 'Maintenance type deleted' };
  }

  // ── Workshops ────────────────────────────────────────────────────────────────

  // Limited select to baseline columns that exist before the
  // enhance_workshop_fields migration is applied.
  private static readonly WORKSHOP_SELECT = {
    id: true,
    name: true,
    contactName: true,
    phone: true,
    email: true,
    address: true,
    city: true,
    country: true,
    notes: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  async listWorkshops(caller?: any, tenantIdQuery?: string) {
    // Phase 3.19 — tenant scoping. Tenantless rows (legacy global
    // workshops) are surfaced to every tenant via OR { tenantId: null }
    // so existing data keeps working until an operator reassigns them.
    // A cached Prisma client generated before tenantId existed will
    // reject the field with PrismaClientValidationError — fall back to
    // the unfiltered list so the page still renders. Run
    // `npx prisma generate` to refresh the client.
    // @tenant-reviewed: phase319-fleet-tenant-scope
    // Phase F2 (SPIKE-010 Batch 2) — SUPER USER tenant override.
    await assertRequestedTenantExists(caller, tenantIdQuery, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, tenantIdQuery);
    const filter = this.callerTenantWhere(caller);
    const where: any = { deletedAt: null };
    if (filter.tenantId) where.OR = [{ tenantId: filter.tenantId }, { tenantId: null }];
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];
    try {
      return await this.prisma.workshop.findMany({
        where: where as any,
        orderBy: { name: 'asc' },
        select: VehiclesService.WORKSHOP_SELECT,
      });
    } catch (err: any) {
      if (err?.name === 'PrismaClientValidationError') {
        return this.prisma.workshop.findMany({
          where: { deletedAt: null } as any,
          orderBy: { name: 'asc' },
          select: VehiclesService.WORKSHOP_SELECT,
        });
      }
      throw err;
    }
  }

  async getWorkshop(id: string, caller?: any) {
    const w = await this.prisma.workshop.findUnique({
      where: { id },
      select: VehiclesService.WORKSHOP_SELECT,
    });
    if (!w) throw new NotFoundException('Workshop not found');
    // Tenant-scope check: a non-PlatformAdmin caller can only read a
    // workshop that's either tenantless or in their own tenant.
    const t = caller?.tenantId;
    const wt = (w as any).tenantId ?? null;
    if (!caller?.agencyIsSystem && t && wt && wt !== t) {
      throw new NotFoundException('Workshop not found');
    }
    return w;
  }

  async createWorkshop(dto: CreateWorkshopDto, caller?: any) {
    const { name, contactName, phone, email, address, city, country, notes } = dto as any;
    const isSuper = await this.isCallerSuperPlatformAdmin(caller);
    const explicit = isSuper && typeof (dto as any).tenantId === 'string' && (dto as any).tenantId.trim()
      ? (dto as any).tenantId.trim()
      : undefined;
    // Phase 3 (#1.x R-4 / R-5) — validate the SUPER tenant pin against
    // the tenants table, matching createVehicle and updateWorkshop.
    // Without this a SUPER could create a workshop attributed to a
    // non-existent tenant.
    if (explicit) {
      const target = await this.prisma.tenant.findUnique({ where: { id: explicit }, select: { id: true } }).catch(() => null);
      if (!target) {
        throw new BadRequestException({
          code: 'TENANT.NOT_FOUND',
          message: 'Selected tenant does not exist.',
          params: { tenantId: explicit },
        });
      }
    }
    // Phase 2C (#23) — every caller (incl. SUPER) defaults to active tenant.
    const tenantId = explicit ?? caller?.tenantId ?? null;
    return this.legacyPrisma.workshop.create({
      data: ({ name, contactName, phone, email, address, city, country, notes, tenantId } as any),
      select: VehiclesService.WORKSHOP_SELECT,
    });
  }

  async updateWorkshop(id: string, dto: UpdateWorkshopDto, caller?: any) {
    const w = await this.prisma.workshop.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Workshop not found');
    const t = caller?.tenantId;
    const wt = (w as any).tenantId ?? null;
    if (!caller?.agencyIsSystem && t && wt && wt !== t) {
      throw new NotFoundException('Workshop not found');
    }
    const { name, contactName, phone, email, address, city, country, notes, isActive } = dto as any;
    const data: any = {};
    if (name !== undefined)        data.name = name;
    if (contactName !== undefined) data.contactName = contactName;
    if (phone !== undefined)       data.phone = phone;
    if (email !== undefined)       data.email = email;
    if (address !== undefined)     data.address = address;
    if (city !== undefined)        data.city = city;
    if (country !== undefined)     data.country = country;
    if (notes !== undefined)       data.notes = notes;
    if (isActive !== undefined)    data.isActive = isActive;
    // SUPER PlatformAdmin only — move the workshop to a different tenant.
    if ((dto as any).tenantId !== undefined) {
      const isSuper = await this.isCallerSuperPlatformAdmin(caller);
      if (isSuper) {
        const v = String((dto as any).tenantId ?? '').trim();
        if (v) {
          const target = await this.prisma.tenant.findUnique({ where: { id: v }, select: { id: true } }).catch(() => null);
          if (!target) throw new NotFoundException(`Tenant ${v} not found`);
          data.tenantId = v;
        } else {
          data.tenantId = null;
        }
      }
    }
    return this.legacyPrisma.workshop.update({
      where: { id },
      data,
      select: VehiclesService.WORKSHOP_SELECT,
    });
  }

  async deleteWorkshop(id: string, userId?: string, caller?: any) {
    const w = await this.prisma.workshop.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Workshop not found');
    if ((w as any).deletedAt) throw new NotFoundException('Workshop not found');
    const t = caller?.tenantId;
    const wt = (w as any).tenantId ?? null;
    if (!caller?.agencyIsSystem && t && wt && wt !== t) {
      throw new NotFoundException('Workshop not found');
    }
    await (this.legacyPrisma.workshop as any).update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: userId ?? null },
    });
    return { message: 'Workshop deleted successfully' };
  }

  // ── Maintenance Records ──────────────────────────────────────────────────────

  async listMaintenanceRecords(dto: FilterMaintenanceDto, caller?: any) {
    const { page = 1, limit = 20, vehicleId, workshopId, status, dateFrom, dateTo } = dto;
    const skip = (page - 1) * limit;
    // Phase F2 (SPIKE-010 Batch 2) — SUPER USER tenant override.
    await assertRequestedTenantExists(caller, (dto as any).tenantId, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, (dto as any).tenantId);
    const t = this.scope().tenantWhere();
    const where: any = { deletedAt: null, ...t, ...this.callerTenantWhere(caller) } as any;
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];

    if (vehicleId) where.vehicleId = vehicleId;
    if (workshopId) where.workshopId = workshopId;
    if (status)    where.status    = status;
    if (dateFrom || dateTo) {
      where.scheduledDate = {};
      if (dateFrom) where.scheduledDate.gte = new Date(dateFrom);
      if (dateTo)   where.scheduledDate.lte = new Date(dateTo);
    }

    const [records, total] = await Promise.all([
      this.prisma.maintenanceRecord.findMany({ // @tenant-reviewed: phase223-pilot-scope
        where,
        skip,
        take: limit,
        select: {
          id: true,
          vehicleId: true,
          maintenanceTypeId: true,
          workshopId: true,
          status: true,
          scheduledDate: true,
          completedDate: true,
          mileageAtService: true,
          nextServiceDate: true,
          nextServiceMileage: true,
          cost: true,
          laborCost: true,
          partsCost: true,
          description: true,
          technicianName: true,
          invoiceNumber: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
          vehicle: { select: { id: true, registrationNumber: true, make: true, model: true } },
          maintenanceType: { select: { id: true, name: true } },
          workshop: { select: { id: true, name: true, address: true, city: true, country: true, phone: true, email: true } },
          spareParts: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.maintenanceRecord.count({ where }), // @tenant-reviewed: phase223-pilot-scope
    ]);

    return { data: records, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getMaintenanceRecord(id: string) {
    const t = this.scope().tenantWhere();
    // findFirst (was findUnique) so the tenant predicate composes with id lookup
    const record = await this.prisma.maintenanceRecord.findFirst({ // @tenant-reviewed: phase223-pilot-scope
      where: { id, ...t },
      select: {
        id: true,
        vehicleId: true,
        maintenanceTypeId: true,
        workshopId: true,
        status: true,
        scheduledDate: true,
        completedDate: true,
        mileageAtService: true,
        nextServiceDate: true,
        nextServiceMileage: true,
        cost: true,
        laborCost: true,
        partsCost: true,
        description: true,
        technicianName: true,
        invoiceNumber: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        vehicle: { select: { id: true, registrationNumber: true, make: true, model: true } },
        maintenanceType: { select: { id: true, name: true } },
        workshop: { select: { id: true, name: true, address: true, city: true, country: true, phone: true, email: true } },
        spareParts: true,
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        updatedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!record) throw new NotFoundException('Maintenance record not found');
    return record;
  }

  async createMaintenanceRecord(dto: CreateMaintenanceRecordDto, userId: string, caller?: any) {
    // findVehicleOrFail enforces tenant scoping on the parent vehicle —
    // a cross-tenant vehicleId raises 404 before the record is written.
    await this.findVehicleOrFail(dto.vehicleId, caller);
    // Strip out new fields (driver, drop-off, pick-up, approval, workDescription)
    // - they require the enhance_maintenance_records migration to be applied first.
    const {
      spareParts, scheduledDate, completedDate, nextServiceDate,
      driverId: _driverId, driverNameOverride: _driverNameOverride,
      dropOffDriverId: _dropOffDriverId, dropOffDriverNameOverride: _dropOffDriverNameOverride, dropOffDateTime: _dropOffDateTime,
      pickUpDriverId: _pickUpDriverId, pickUpDriverNameOverride: _pickUpDriverNameOverride, pickUpDateTime: _pickUpDateTime,
      approvedById: _approvedById, approvedAt: _approvedAt, workDescription: _workDescription,
      ...rest
    } = dto;

    const data: any = { ...rest, createdById: userId, updatedById: userId };
    if (scheduledDate)   data.scheduledDate   = new Date(scheduledDate);
    if (completedDate)   data.completedDate   = new Date(completedDate);
    if (nextServiceDate) data.nextServiceDate = new Date(nextServiceDate);

    if (spareParts?.length) {
      data.spareParts = {
        create: spareParts.map((p) => ({
          partName:   p.partName,
          partNumber: p.partNumber,
          quantity:   p.quantity ?? 1,
          unitCost:   p.unitCost,
          totalCost:  p.unitCost != null ? (p.unitCost * (p.quantity ?? 1)) : undefined,
          supplier:   p.supplier,
        })),
      };
    }

    // If mileage provided, update vehicle's currentMileage
    if (dto.mileageAtService) {
      await this.legacyPrisma.vehicle.update({ // @tenant-reviewed: phase224-pilot-scope-precheck (parent vehicle tenant-checked by findVehicleOrFail above)
        where: { id: dto.vehicleId },
        data: { currentMileage: dto.mileageAtService },
      });
    }

    // Phase 2.24 — write tenantId on the new MaintenanceRecord. Spare
    // parts are nested-written under the parent so they inherit the
    // tenant-by-parent guarantee.
    const tdata = this.scope().tenantData();
    // Phase 2C (#23) — fall back to caller.tenantId when scope is empty.
    const tenantFallback = !(tdata as any).tenantId && caller?.tenantId ? { tenantId: caller.tenantId } : {};
    const record = await this.legacyPrisma.maintenanceRecord.create({ // @tenant-reviewed: phase224-pilot-scope (writes tenantId via scope.tenantData)
      data: { ...data, ...tdata, ...tenantFallback },
      select: {
        id: true,
        vehicleId: true,
        maintenanceTypeId: true,
        workshopId: true,
        status: true,
        scheduledDate: true,
        completedDate: true,
        mileageAtService: true,
        nextServiceDate: true,
        nextServiceMileage: true,
        cost: true,
        laborCost: true,
        partsCost: true,
        description: true,
        technicianName: true,
        invoiceNumber: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        maintenanceType: { select: { id: true, name: true } },
        workshop: { select: { id: true, name: true, address: true, city: true, country: true, phone: true, email: true } },
        spareParts: true,
      },
    });

    // Compute partsCost from spare parts if not provided
    if (!dto.partsCost && spareParts?.length) {
      const partsCost = record.spareParts.reduce((sum, p) => sum + (p.totalCost ?? 0), 0);
      await this.legacyPrisma.maintenanceRecord.update({ where: { id: record.id }, data: { partsCost } }); // @tenant-reviewed: phase224-pilot-scope-precheck (record just inserted under tenant-checked parent)
    }

    return record;
  }

  async updateMaintenanceRecord(id: string, dto: UpdateMaintenanceRecordDto, userId: string, caller?: any) {
    const t = this.scope().tenantWhere();
    const existing = await this.prisma.maintenanceRecord.findFirst({
      where: { id, ...t, ...this.callerTenantWhere(caller) },
    });
    if (!existing) throw new NotFoundException('Maintenance record not found');

    // Strip out new fields - they require the enhance_maintenance_records migration first.
    const {
      spareParts, scheduledDate, completedDate, nextServiceDate,
      driverId: _driverId, driverNameOverride: _driverNameOverride,
      dropOffDriverId: _dropOffDriverId, dropOffDriverNameOverride: _dropOffDriverNameOverride, dropOffDateTime: _dropOffDateTime,
      pickUpDriverId: _pickUpDriverId, pickUpDriverNameOverride: _pickUpDriverNameOverride, pickUpDateTime: _pickUpDateTime,
      approvedById: _approvedById, approvedAt: _approvedAt, workDescription: _workDescription,
      ...rest
    } = dto;
    const data: any = { ...rest, updatedById: userId };
    if (scheduledDate !== undefined)   data.scheduledDate   = scheduledDate ? new Date(scheduledDate) : null;
    if (completedDate !== undefined)   data.completedDate   = completedDate ? new Date(completedDate) : null;
    if (nextServiceDate !== undefined) data.nextServiceDate = nextServiceDate ? new Date(nextServiceDate) : null;

    if (spareParts !== undefined) {
      // Replace spare parts (parent maintenance record was tenant-checked above)
      await this.legacyPrisma.maintenanceRecordSparePart.deleteMany({ where: { maintenanceRecordId: id } }); // @tenant-reviewed: phase224-pilot-scope-precheck (parent record tenant-checked above)
      if (spareParts.length) {
        data.spareParts = {
          create: spareParts.map((p) => ({
            partName:   p.partName,
            partNumber: p.partNumber,
            quantity:   p.quantity ?? 1,
            unitCost:   p.unitCost,
            totalCost:  p.unitCost != null ? (p.unitCost * (p.quantity ?? 1)) : undefined,
            supplier:   p.supplier,
          })),
        };
      }
    }

    if (dto.mileageAtService) {
      await this.legacyPrisma.vehicle.update({ // @tenant-reviewed: phase224-pilot-scope-precheck (parent record tenant-checked; vehicleId derives from it)
        where: { id: existing.vehicleId },
        data: { currentMileage: dto.mileageAtService },
      });
    }

    return this.legacyPrisma.maintenanceRecord.update({ // @tenant-reviewed: phase224-pilot-scope-precheck (parent record tenant-checked above)
      where: { id },
      data,
      select: {
        id: true,
        vehicleId: true,
        maintenanceTypeId: true,
        workshopId: true,
        status: true,
        scheduledDate: true,
        completedDate: true,
        mileageAtService: true,
        nextServiceDate: true,
        nextServiceMileage: true,
        cost: true,
        laborCost: true,
        partsCost: true,
        description: true,
        technicianName: true,
        invoiceNumber: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        maintenanceType: { select: { id: true, name: true } },
        workshop: { select: { id: true, name: true, address: true, city: true, country: true, phone: true, email: true } },
        spareParts: true,
      },
    });
  }

  async deleteMaintenanceRecord(id: string, userId?: string, caller?: any) {
    const t = this.scope().tenantWhere();
    const existing = await this.prisma.maintenanceRecord.findFirst({
      where: { id, ...t, ...this.callerTenantWhere(caller) },
    });
    if (!existing) throw new NotFoundException('Maintenance record not found');
    if ((existing as any).deletedAt) throw new NotFoundException('Maintenance record not found');
    await (this.legacyPrisma.maintenanceRecord as any).update({ // @tenant-reviewed: phase224-pilot-scope-precheck
      where: { id },
      data: { deletedAt: new Date(), deletedBy: userId ?? null },
    });
    return { message: 'Maintenance record deleted successfully' };
  }

  // ── Maintenance Record Attachments ───────────────────────────────────────────
  // Note: attachments require running the enhance_maintenance_records migration first.

  async addMaintenanceAttachment(
    _recordId: string,
    _file: Express.Multer.File,
    _documentType?: string,
    _uploadedById?: string,
  ) {
    // Storage upload is intentionally not performed here — the
    // maintenance_attachments table is created by the optional
    // enhance-maintenance-records migration. Once that migration is
    // run, swap this stub for a real implementation that calls
    // storage.uploadFile({ keyPrefix: `vehicles/maintenance/${recordId}/attachments`, ... }).
    throw new BadRequestException('Maintenance record attachments require migration. Run: npm run db:migrate:enhance-maintenance-records');
  }

  async deleteMaintenanceAttachment(_attachmentId: string) {
    throw new BadRequestException('Maintenance record attachments require migration. Run: npm run db:migrate:enhance-maintenance-records');
  }

  async getMaintenanceAttachments(_recordId: string) {
    return [];
  }

  // ── Dashboard Stats ──────────────────────────────────────────────────────────

  async getDashboardStats() {
    const now = new Date();
    const in30Days = new Date(now);
    in30Days.setDate(in30Days.getDate() + 30);
    const t = this.scope().tenantWhere();

    const [
      totalVehicles,
      activeVehicles,
      inMaintenance,
      scrapped,
      upcomingMaintenance,
      expiringDocs,
    ] = await Promise.all([
      this.prisma.vehicle.count({ where: { deletedAt: null, ...t } }), // @tenant-reviewed: phase223-pilot-scope
      this.prisma.vehicle.count({ where: { deletedAt: null, status: 'ACTIVE', ...t } }), // @tenant-reviewed: phase223-pilot-scope
      this.prisma.vehicle.count({ where: { deletedAt: null, status: 'IN_MAINTENANCE', ...t } }), // @tenant-reviewed: phase223-pilot-scope
      this.prisma.vehicle.count({ where: { deletedAt: null, status: 'SCRAPPED', ...t } }), // @tenant-reviewed: phase223-pilot-scope
      this.prisma.maintenanceRecord.count({ // @tenant-reviewed: phase223-pilot-scope
        where: {
          status: 'SCHEDULED',
          scheduledDate: { lte: in30Days, gte: now },
          ...t,
        },
      }),
      this.prisma.vehicleDocument.count({ // @tenant-reviewed: phase223-pilot-scope
        where: {
          expiryDate: { lte: in30Days, gte: now },
          ...t,
        },
      }),
    ]);

    const byType = await this.prisma.vehicle.groupBy({ // @tenant-reviewed: phase223-pilot-scope
      by: ['type'],
      where: { deletedAt: null, ...t },
      _count: { id: true },
    });

    return {
      totalVehicles,
      activeVehicles,
      inMaintenance,
      scrapped,
      upcomingMaintenance,
      expiringDocs,
      byType: byType.map((r) => ({ type: r.type, count: r._count.id })),
    };
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  async exportVehicles(dto: ExportVehiclesDto, locale: ServerLocale = 'en'): Promise<Buffer> {
    const t = this.scope().tenantWhere();
    const where: any = { deletedAt: null, ...t };
    if (dto.type)   where.type   = dto.type;
    if (dto.status) where.status = dto.status;
    if (dto.vehicleIds?.length) where.id = { in: dto.vehicleIds };

    const vehicles = await this.prisma.vehicle.findMany({ // @tenant-reviewed: phase223-pilot-scope
      where,
      include: {
        agency: { select: { name: true } },
        driverAssignments: {
          where: { isActive: true },
          include: { employee: { select: { firstName: true, lastName: true } } },
          take: 1,
        },
      },
      orderBy: { registrationNumber: 'asc' },
    });

    const workbook  = new ExcelJS.Workbook();
    const col = (key: string) => tServer(`vehicles.columns.${key}`, {}, locale, 'exports');
    const sheet     = workbook.addWorksheet(
      tServer('vehicles.sheetName', {}, locale, 'exports'),
      { views: [{ state: 'frozen', ySplit: 1 }] },
    );

    const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    const headers = [
      col('registration'), col('type'), col('make'), col('model'), col('year'),
      col('status'), col('fuelType'), col('mileageKm'), col('currentDriver'),
      col('motExpiry'), col('taxExpiry'), col('insuranceExpiry'),
      col('agency'), col('vin'),
    ];

    sheet.columns = headers.map((h) => ({ header: h, width: 18 }));
    sheet.getRow(1).eachCell((cell) => {
      cell.fill  = headerFill;
      cell.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    sheet.getRow(1).height = 22;

    const statusColors: Record<string, string> = {
      ACTIVE: 'FFD1FAE5', INACTIVE: 'FFFEE2E2', IN_MAINTENANCE: 'FFFEF3C7', SCRAPPED: 'FFF3F4F6',
    };

    for (const v of vehicles) {
      const driver = v.driverAssignments[0]?.employee;
      const row = sheet.addRow([
        v.registrationNumber,
        v.type,
        v.make,
        v.model,
        v.year ?? '',
        v.status,
        v.fuelType ?? '',
        v.currentMileage ?? '',
        driver ? `${driver.firstName} ${driver.lastName}` : '',
        v.motExpiryDate ? v.motExpiryDate.toISOString().split('T')[0] : '',
        v.taxExpiryDate ? v.taxExpiryDate.toISOString().split('T')[0] : '',
        v.insuranceExpiryDate ? v.insuranceExpiryDate.toISOString().split('T')[0] : '',
        v.agency?.name ?? '',
        v.vin ?? '',
      ]);
      const statusFill: ExcelJS.Fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: statusColors[v.status] ?? 'FFFFFFFF' },
      };
      row.getCell(6).fill = statusFill;
    }

    sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + headers.length)}1` };

    return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
  }

  // ── Maintenance Records Export ────────────────────────────────────────────────

  /// Build the where clause used by both list and export operations.
  private buildMaintenanceWhere(dto: FilterMaintenanceDto): any {
    const where: any = { deletedAt: null };
    if (dto.vehicleId)  where.vehicleId  = dto.vehicleId;
    if (dto.workshopId) where.workshopId = dto.workshopId;
    if (dto.status)     where.status     = dto.status;
    if (dto.dateFrom || dto.dateTo) {
      where.scheduledDate = {};
      if (dto.dateFrom) where.scheduledDate.gte = new Date(dto.dateFrom);
      if (dto.dateTo)   where.scheduledDate.lte = new Date(dto.dateTo);
    }
    return where;
  }

  private async fetchMaintenanceForExport(dto: FilterMaintenanceDto, recordIds?: string[]) {
    const t = this.scope().tenantWhere();
    const where: any = recordIds?.length
      ? { id: { in: recordIds }, ...t }
      : { ...this.buildMaintenanceWhere(dto), ...t };
    return this.prisma.maintenanceRecord.findMany({ // @tenant-reviewed: phase223-pilot-scope
      where,
      select: {
        id: true,
        status: true,
        scheduledDate: true,
        completedDate: true,
        mileageAtService: true,
        nextServiceDate: true,
        nextServiceMileage: true,
        cost: true,
        laborCost: true,
        partsCost: true,
        description: true,
        technicianName: true,
        invoiceNumber: true,
        notes: true,
        createdAt: true,
        vehicle: { select: { registrationNumber: true, make: true, model: true } },
        maintenanceType: { select: { name: true } },
        workshop: { select: { name: true, city: true, country: true } },
      },
      orderBy: [{ completedDate: 'desc' }, { scheduledDate: 'desc' }],
    });
  }

  async exportMaintenanceRecordsExcel(dto: FilterMaintenanceDto, recordIds?: string[], locale: ServerLocale = 'en'): Promise<Buffer> {
    const records = await this.fetchMaintenanceForExport(dto, recordIds);

    const workbook = new ExcelJS.Workbook();
    const mcol = (key: string) => tServer(`vehicles.maintenanceColumns.${key}`, {}, locale, 'exports');
    const sheet    = workbook.addWorksheet(
      tServer('vehicles.maintenanceSheetName', {}, locale, 'exports'),
      { views: [{ state: 'frozen', ySplit: 1 }] },
    );

    const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    const headers = [
      mcol('vehicle'), mcol('makeModel'), mcol('maintenanceType'), mcol('workshop'), mcol('status'),
      mcol('scheduled'), mcol('completed'), mcol('mileageKm'), mcol('nextServiceDate'),
      mcol('nextServiceMileage'), mcol('laborCost'), mcol('partsCost'), mcol('totalCost'),
      mcol('technician'), mcol('invoiceNumber'), mcol('description'), mcol('notes'),
    ];

    sheet.columns = headers.map((h, i) => ({
      header: h,
      width: i === 15 || i === 16 ? 30 : 16,
    }));
    sheet.getRow(1).eachCell((cell) => {
      cell.fill      = headerFill;
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    sheet.getRow(1).height = 22;

    const statusColors: Record<string, string> = {
      SCHEDULED: 'FFDBEAFE', IN_PROGRESS: 'FFFEF3C7', COMPLETED: 'FFD1FAE5', CANCELLED: 'FFF3F4F6',
    };

    for (const r of records) {
      const row = sheet.addRow([
        r.vehicle?.registrationNumber ?? '',
        r.vehicle ? `${r.vehicle.make} ${r.vehicle.model}` : '',
        r.maintenanceType?.name ?? '',
        r.workshop?.name ?? '',
        r.status,
        r.scheduledDate ? r.scheduledDate.toISOString().split('T')[0] : '',
        r.completedDate ? r.completedDate.toISOString().split('T')[0] : '',
        r.mileageAtService ?? '',
        r.nextServiceDate ? r.nextServiceDate.toISOString().split('T')[0] : '',
        r.nextServiceMileage ?? '',
        r.laborCost ?? '',
        r.partsCost ?? '',
        r.cost ?? '',
        r.technicianName ?? '',
        r.invoiceNumber ?? '',
        r.description ?? '',
        r.notes ?? '',
      ]);
      const statusFill: ExcelJS.Fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: statusColors[r.status] ?? 'FFFFFFFF' },
      };
      row.getCell(5).fill = statusFill;
    }

    sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + headers.length)}1` };

    return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
  }

  async exportMaintenanceRecordsPdf(dto: FilterMaintenanceDto, recordIds?: string[], locale: ServerLocale = 'en'): Promise<Buffer> {
    const records = await this.fetchMaintenanceForExport(dto, recordIds);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' } as any);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Title + subtitle (localized)
      const generatedLabel = tServer('common.generatedAt', {}, locale, 'exports');
      const recordsLabel   = tServer('common.recordsSuffix', {}, locale, 'exports');
      const mcol = (k: string) => tServer(`vehicles.maintenancePdfColumns.${k}`, {}, locale, 'exports');
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#0F172A')
        .text(tServer('vehicles.maintenancePdfTitle', {}, locale, 'exports'), { align: 'center' });
      doc.fontSize(9).font('Helvetica').fillColor('#64748B')
        .text(`${generatedLabel}: ${formatDisplayDateTime(new Date())}  |  ${records.length} ${recordsLabel}`, { align: 'center' });
      doc.moveDown(0.6);

      const columns = [
        { label: mcol('vehicle'),    key: 'vehicle',     width: 70 },
        { label: mcol('type'),       key: 'type',        width: 80 },
        { label: mcol('workshop'),   key: 'workshop',    width: 90 },
        { label: mcol('status'),     key: 'status',      width: 70 },
        { label: mcol('scheduled'),  key: 'scheduled',   width: 65 },
        { label: mcol('completed'),  key: 'completed',   width: 65 },
        { label: mcol('mileage'),    key: 'mileage',     width: 60 },
        { label: mcol('cost'),       key: 'cost',        width: 60 },
        { label: mcol('technician'), key: 'technician',  width: 80 },
        { label: mcol('invoice'),    key: 'invoice',     width: 70 },
      ];

      const tblW   = columns.reduce((s, c) => s + c.width, 0);
      const startX = ((doc as any).page.width - tblW) / 2;
      const rowH   = 16;
      const hdrH   = 20;
      let y = (doc as any).y;

      // Header row
      doc.rect(startX, y, tblW, hdrH).fill('#2563EB');
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
      let x = startX;
      for (const col of columns) {
        doc.text(col.label, x + 3, y + 6, { width: col.width - 6, ellipsis: true });
        x += col.width;
      }
      y += hdrH;

      // Data rows
      doc.font('Helvetica').fontSize(7.5);
      const statusColor: Record<string, string> = {
        SCHEDULED: '#DBEAFE', IN_PROGRESS: '#FEF3C7', COMPLETED: '#D1FAE5', CANCELLED: '#F3F4F6',
      };

      records.forEach((r, ri) => {
        if (y + rowH > (doc as any).page.height - 50) {
          doc.addPage();
          y = 36;
        }
        if (ri % 2 === 0) doc.rect(startX, y, tblW, rowH).fill('#F8FAFC');

        const values = [
          r.vehicle?.registrationNumber ?? '—',
          r.maintenanceType?.name ?? '—',
          r.workshop?.name ?? '—',
          r.status,
          r.scheduledDate ? r.scheduledDate.toISOString().split('T')[0] : '—',
          r.completedDate ? r.completedDate.toISOString().split('T')[0] : '—',
          r.mileageAtService != null ? `${r.mileageAtService} km` : '—',
          r.cost != null ? `£${r.cost.toFixed(2)}` : '—',
          r.technicianName ?? '—',
          r.invoiceNumber ?? '—',
        ];

        x = startX;
        values.forEach((v, i) => {
          if (i === 3) {
            doc.rect(x + 1, y + 1, columns[i].width - 2, rowH - 2)
              .fill(statusColor[r.status] ?? '#FFFFFF');
            doc.fillColor('#0F172A');
          } else {
            doc.fillColor('#0F172A');
          }
          doc.text(String(v), x + 3, y + 4, { width: columns[i].width - 6, ellipsis: true });
          x += columns[i].width;
        });

        doc.rect(startX, y, tblW, rowH).stroke('#E2E8F0');
        y += rowH;
      });

      // Footer
      doc.fillColor('#94A3B8').fontSize(8)
        .text(tServer('vehicles.maintenancePdfFooter', {}, locale, 'exports'), 36, (doc as any).page.height - 24, { align: 'center' });
      doc.end();
    });
  }
}
