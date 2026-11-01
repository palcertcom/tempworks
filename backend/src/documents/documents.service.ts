import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger, Optional, Inject, forwardRef,
} from '@nestjs/common';
import { join } from 'path';
import { promises as fs } from 'fs';
import AdmZip = require('adm-zip');
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIF_EVENTS } from '../notifications/notification-events';
import { DocumentIdService } from './document-id.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { activeTenantWhere } from '../saas/prisma/active-tenant-where';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { CreateDocumentDto } from './dto/create-document.dto';
import { VerifyDocumentDto, VerifyActionEnum } from './dto/verify-document.dto';
import { FilterDocumentsDto } from './dto/filter-documents.dto';
import { RenewDocumentDto } from './dto/renew-document.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';
import { assertDocumentMetadata } from './document-metadata-rules';
import { ContractsService } from '../contracts/contracts.service';
import { decodeUploadFilename } from '../common/storage/multer.config';

// Roles that receive document notifications
const DOC_NOTIFY_ROLES = ['System Admin', 'HR Manager', 'Compliance Officer'];

/**
 * Phase 2.20 — Documents reads-first pilot.
 *
 * READ paths route through `pilot.client()` and spread
 * `scope.tenantWhere()` when the pilot scope is active. Production
 * default (flag off) is byte-identical to pre-2.20.
 *
 * WRITE / mutation paths (create / update / verify / renew /
 * remove / upsertDocTypePermission / checkAndAutoCompleteStage)
 * and storage-fetch paths (`createBulkDownloadArchive`) explicitly
 * use `legacyPrisma` and remain annotated
 * `phase220-excluded-mutation` / `phase220-excluded-download`
 * until follow-up pilots audit them.
 *
 * `DocumentType` and `DocumentTypePermission` are tenant-less
 * catalogs in the current schema; their reads/writes are
 * `phase220-global`. Per-tenant catalog overrides are a Phase 3
 * product question.
 *
 * Audit-log writes use `legacyPrisma` always (`phase220-audit-log`).
 *
 * The pilot scope is active iff:
 *   - `TENANT_PRISMA_PILOT_ENABLED=true`
 *   - `TENANT_PRISMA_PILOT_MODULES` empty or includes `documents`
 *   - env classifies as SAFE_CLONE / SAFE_STAGING
 *   - a tenant is in the active ALS frame
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly legacyPrisma: PrismaService,
    private readonly documentIdService: DocumentIdService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly pilot: PilotPrismaAccessor,
    private readonly tenantAuditLog: TenantAuditLogService,
    // Optional so harness scripts that instantiate DocumentsService
    // directly keep their existing arity; guarded with `?.` at the
    // call site. forwardRef resolves the two-way Documents↔Contracts link.
    @Optional() @Inject(forwardRef(() => ContractsService)) private readonly contracts?: ContractsService,
  ) {}

  /** Pilot-aware Prisma surface used by READ paths only. Mutation
   *  paths use `legacyPrisma` directly. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'documents');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Read a stored document's bytes for the bulk-download ZIP. Handles
   * both Spaces public URLs (HTTP fetch) and legacy `/uploads/...`
   * paths (local fs read), so the archive keeps working during the
   * gradual migration window.
   */
  private async fetchDocumentBuffer(fileUrl: string): Promise<Buffer> {
    if (/^https?:\/\//i.test(fileUrl)) {
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${fileUrl}`);
      return Buffer.from(await res.arrayBuffer());
    }
    // Legacy `/uploads/<rest>` URLs are served by express.static from
    // `<cwd>/uploads`. Mirror that exact mapping here so the bulk-download
    // ZIP keeps working for historical rows during the Spaces migration.
    const rel = fileUrl.startsWith('/uploads/')
      ? fileUrl.slice('/uploads/'.length)
      : fileUrl.replace(/^\/+/, '');
    const diskPath = join(process.cwd(), 'uploads', rel);
    await fs.access(diskPath);
    return fs.readFile(diskPath);
  }

  private sanitize(raw: string): string {
    return raw
      .replace(/[^a-zA-Z0-9\-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  /**
   * Phase 2.21 — STORAGE GUARD. Resolves the owner entity by id with
   * the active pilot scope (tenant predicate when active). Raises
   * NotFoundException if the entity does not belong to the caller's
   * tenant — BEFORE the upload path touches object storage.
   *
   * Legacy mode (`tenantWhere()` returns `{}`) reduces to a plain
   * by-id lookup — same behaviour as pre-2.21.
   */
  /**
   * Resolve the tenantId of a Document's owning entity. Documents inherit
   * their tenant from the person/agency they belong to, NOT from whichever
   * tenant the uploader was active on. Returns null when the entity has
   * no tenantId stamped (legacy / global rows).
   */
  /**
   * True when the caller is entitled to read documents generally —
   * either a built-in document role or a custom role/agency holding
   * the `documents:read` permission. Callers who only hold
   * `attendance:read` return false here and are restricted (by the
   * read paths) to ATTENDANCE-linked documents, so an attendance
   * manager can open a day's proof file without gaining access to
   * every employee/applicant document.
   */
  private static readonly BUILTIN_DOC_ROLES = new Set([
    'System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only',
  ]);
  private async hasGeneralDocumentReadAccess(caller?: any): Promise<boolean> {
    if (!caller) return false;
    const role = (caller.role ?? '').toString().trim();
    if (DocumentsService.BUILTIN_DOC_ROLES.has(role)) return true;
    if (!caller.id) return false;
    const u = await this.legacyPrisma.user.findUnique({
      where: { id: caller.id },
      select: { role: { select: { permissions: { select: { permission: { select: { name: true } } } } } } },
    });
    let allowed = (u?.role?.permissions ?? []).some((rp: any) => rp.permission?.name === 'documents:read');
    if (caller.agencyId) {
      const overrides = await this.legacyPrisma.agencyPermissionOverride.findMany({
        where: { agencyId: caller.agencyId, permission: 'documents:read' },
        select: { allow: true },
      });
      for (const o of overrides) allowed = o.allow;
    }
    return allowed;
  }

  /**
   * Guard the document read paths: callers without general document
   * access (e.g. an attendance manager who only holds attendance:read)
   * may only reach ATTENDANCE-linked documents. Throws the same 404 the
   * tenant gate uses so we don't leak the existence of other docs.
   *
   * NOTE: when `caller` is undefined this is an internal server-to-server
   * call (verify / update / renew / remove all reuse findOne with no
   * caller — their own controller endpoints carry the required permission
   * check). Bypass the gate in that case, otherwise legitimate write
   * actions on EMPLOYEE/APPLICANT docs would 404 themselves.
   */
  private async assertReadableByCaller(entityType: string, id: string, caller?: any): Promise<void> {
    if (!caller) return; // internal call
    if (entityType === 'ATTENDANCE') return; // attendance:read (verified by the controller) suffices
    if (await this.hasGeneralDocumentReadAccess(caller)) return;
    throw new NotFoundException({ code: 'DOCUMENT.NOT_FOUND', message: `Document ${id} not found`, params: { id } });
  }

  /**
   * Tenant gate for a document, decided by its OWNING ENTITY (same rule as
   * findOne). Enforced regardless of the pilot/legacy Prisma mode: in the
   * default legacy mode scope().tenantWhere() is `{}`, so without this the
   * byte-streaming and bulk-ZIP paths served other tenants' files by id.
   * SUPER (agencyIsSystem) bypasses. Returns false when the caller is in a
   * different tenant than the document's entity.
   */
  private async isSameTenantAsCaller(entityType: string, entityId: string, caller?: any): Promise<boolean> {
    if (!caller || caller?.agencyIsSystem === true) return true;
    const callerTenantId = (caller?.tenantId ?? '').toString().trim() || null;
    if (!callerTenantId) return true;
    const entityTenantId = await this.resolveEntityTenantId(entityType, entityId);
    return !entityTenantId || entityTenantId === callerTenantId;
  }

  private async resolveEntityTenantId(entityType: string, entityId: string): Promise<string | null> {
    switch (entityType) {
      case 'EMPLOYEE': {
        const e: any = await this.prisma.employee.findUnique({ where: { id: entityId }, select: { tenantId: true } });
        return e?.tenantId ?? null;
      }
      case 'APPLICANT': {
        const a: any = await this.prisma.applicant.findUnique({ where: { id: entityId }, select: { tenantId: true } });
        return a?.tenantId ?? null;
      }
      case 'AGENCY': {
        const ag: any = await this.prisma.agency.findUnique({ where: { id: entityId }, select: { tenantId: true } });
        return ag?.tenantId ?? null;
      }
      case 'USER': {
        const u: any = await this.prisma.user.findUnique({ where: { id: entityId }, select: { agency: { select: { tenantId: true } } } });
        return u?.agency?.tenantId ?? null;
      }
      case 'ATTENDANCE': {
        const rec: any = await (this.prisma as any).attendanceRecord.findUnique({
          where: { id: entityId },
          select: { tenantId: true, employee: { select: { tenantId: true } } },
        });
        return rec?.tenantId ?? rec?.employee?.tenantId ?? null;
      }
      default:
        return null;
    }
  }

  private async assertEntityOwnedByActiveTenant(entityType: string, entityId: string): Promise<void> {
    const t = this.scope().tenantWhere();
    let found: { id: string } | null = null;
    switch (entityType) {
      case 'EMPLOYEE':
        found = await this.prisma.employee.findFirst({ where: { id: entityId, ...t }, select: { id: true } }); // @tenant-reviewed: phase221-storage-guard
        break;
      case 'APPLICANT':
        found = await this.prisma.applicant.findFirst({ where: { id: entityId, ...t }, select: { id: true } }); // @tenant-reviewed: phase221-storage-guard
        break;
      case 'AGENCY':
        found = await this.prisma.agency.findFirst({ where: { id: entityId, ...t }, select: { id: true } }); // @tenant-reviewed: phase221-storage-guard
        break;
      case 'USER':
        found = await this.prisma.user.findFirst({ where: { id: entityId, ...t }, select: { id: true } }); // @tenant-reviewed: phase221-storage-guard
        break;
      case 'ATTENDANCE': {
        // Phase 2C (#32) — supporting attendance documents. The
        // attendance record carries tenantId in pilot mode AND the
        // parent employee's tenant in legacy mode (via the FK), so we
        // resolve through the employee's tenant predicate.
        const rec: any = await (this.prisma as any).attendanceRecord.findFirst({
          where: { id: entityId },
          select: { id: true, employeeId: true, tenantId: true },
        });
        if (rec) {
          // If pilot is active and the record carries a tenantId, just
          // gate against it. Otherwise gate against the parent employee.
          if ((t as any).tenantId && rec.tenantId && (t as any).tenantId === rec.tenantId) {
            found = { id: rec.id };
          } else if (!(t as any).tenantId) {
            const emp = await this.prisma.employee.findFirst({ where: { id: rec.employeeId, ...t }, select: { id: true } });
            if (emp) found = { id: rec.id };
          }
        }
        break;
      }
      default:
        throw new BadRequestException({ code: 'DOCUMENT.ENTITY_TYPE_INVALID', message: `Invalid entityType ${entityType}` });
    }
    if (!found) {
      throw new NotFoundException({
        code: 'DOCUMENT.ENTITY_NOT_FOUND',
        message: `Entity ${entityId} not found`,
        params: { entityType, entityId },
      });
    }
  }

  private async resolveEntityName(entityType: string, entityId: string): Promise<string> {
    try {
      switch (entityType) {
        case 'EMPLOYEE': {
          const e = await this.legacyPrisma.employee.findUnique({ where: { id: entityId }, select: { firstName: true, lastName: true } }); // @tenant-reviewed: phase220-excluded-helper
          return e ? `${e.firstName} ${e.lastName}` : '';
        }
        case 'APPLICANT': {
          const a = await this.legacyPrisma.applicant.findUnique({ where: { id: entityId }, select: { firstName: true, lastName: true } }); // @tenant-reviewed: phase220-excluded-helper
          return a ? `${a.firstName} ${a.lastName}` : '';
        }
        case 'AGENCY': {
          const ag = await this.legacyPrisma.agency.findUnique({ where: { id: entityId }, select: { name: true } }); // @tenant-reviewed: phase220-excluded-helper
          return ag ? ag.name : '';
        }
        case 'USER': {
          const u = await this.legacyPrisma.user.findUnique({ where: { id: entityId }, select: { firstName: true, lastName: true } }); // @tenant-reviewed: phase220-excluded-helper
          return u ? `${u.firstName} ${u.lastName}` : '';
        }
        default: return '';
      }
    } catch { return ''; }
  }

  private get docInclude() {
    return {
      documentType: { select: { id: true, name: true, code: true, category: true, trackExpiry: true, renewalPeriodDays: true } },
      uploadedBy:  { select: { id: true, firstName: true, lastName: true } },
      verifiedBy:  { select: { id: true, firstName: true, lastName: true } },
      renewedFrom: { select: { id: true, docId: true, name: true, status: true } },
    };
  }

  // ── Build WHERE clause from FilterDocumentsDto ─────────────────────────────

  private buildWhere(filter: FilterDocumentsDto): any {
    const where: any = { deletedAt: null };

    // Archive view. Default hides archived ("No longer valid") documents
    // so the active list stays clean; 'archived' shows only them (history
    // view); 'all' shows both.
    if (filter.archived === 'archived') where.archivedAt = { not: null };
    else if (filter.archived === 'all') { /* no archive predicate */ }
    else where.archivedAt = null;

    if (filter.search) {
      where.OR = [
        { name:           { contains: filter.search, mode: 'insensitive' } },
        { documentNumber: { contains: filter.search, mode: 'insensitive' } },
        { docId:          { contains: filter.search, mode: 'insensitive' } },
        { issuer:         { contains: filter.search, mode: 'insensitive' } },
      ];
    }
    if (filter.status === 'EXPIRING_SOON') {
      // Computed state — the dashboard tile counts docs whose
      // expiryDate falls in (now, +60d]. Match that here so clicking
      // the tile lands on the same set.
      const now = new Date();
      const fwd60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      where.expiryDate = { not: null, gt: now, lte: fwd60 };
    } else if (filter.status === 'EXPIRED') {
      // Stored EXPIRED status OR live expiryDate already past — either
      // qualifies. Use AND so an existing search-OR isn't dissolved.
      where.AND = [
        ...(where.AND ?? []),
        { OR: [{ status: 'EXPIRED' as any }, { expiryDate: { lt: new Date() } }] },
      ];
    } else if (filter.status) {
      where.status = filter.status;
    }
    if (filter.documentTypeId) where.documentTypeId = filter.documentTypeId;
    if (filter.entityType)     where.entityType     = filter.entityType;
    if (filter.entityId)       where.entityId       = filter.entityId;
    if (filter.uploadedById)   where.uploadedById   = filter.uploadedById;
    if (filter.verifiedById)   where.verifiedById   = filter.verifiedById;

    if (filter.docId)
      where.docId = { contains: filter.docId, mode: 'insensitive' };
    if (filter.documentNumber)
      where.documentNumber = { contains: filter.documentNumber, mode: 'insensitive' };

    // Date range filters
    if (filter.issueDateFrom || filter.issueDateTo) {
      where.issueDate = {};
      if (filter.issueDateFrom) where.issueDate.gte = new Date(filter.issueDateFrom);
      if (filter.issueDateTo)   where.issueDate.lte = new Date(filter.issueDateTo);
    }
    if (filter.expiryDateFrom || filter.expiryDateTo) {
      where.expiryDate = {};
      if (filter.expiryDateFrom) where.expiryDate.gte = new Date(filter.expiryDateFrom);
      if (filter.expiryDateTo)   where.expiryDate.lte = new Date(filter.expiryDateTo);
    }

    return where;
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async findAll(filter: FilterDocumentsDto, caller?: any) {
    const { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = filter;
    const skip  = (Number(page) - 1) * Number(limit);
    const t = this.scope().tenantWhere();
    // Phase F2 (SPIKE-010) — accept SUPER USER ?tenantId= override.
    // Helpers gate by `caller.agencyIsSystem === true`; everyone else's
    // value is silently dropped and the existing scope() + activeTenant
    // predicates stand.
    await assertRequestedTenantExists(caller, filter.tenantId, this.legacyPrisma.tenant);
    // Document has no `agency` relation — use the direct-only variant.
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, filter.tenantId);
    // Phase 2 (#5) — enforce active tenant even when read-pilot is off.
    // When SUPER picks an explicit per-page tenant override, that override
    // wins over the session's active tenant (otherwise the two predicates
    // ANDed together collapse to zero rows whenever they differ).
    const where: any = {
      ...this.buildWhere(filter), ...t,
      ...(superTenantPredicate ? {} : activeTenantWhere(caller)),
    };
    if (superTenantPredicate) {
      // Inherit tenancy from the owning entity for legacy docs whose own
      // tenantId is null or was stamped to the uploader's wrong-tenant
      // session. Pull entity IDs in the requested tenant once and OR them
      // alongside the direct tenantId match.
      const targetTenantId = (superTenantPredicate as any).tenantId as string;
      const [emps, apps, agencies] = await Promise.all([
        this.prisma.employee.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
        this.prisma.applicant.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
        this.prisma.agency.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
      ]);
      const entityOr: any[] = [];
      if (emps.length)     entityOr.push({ entityType: 'EMPLOYEE',  entityId: { in: emps.map(e => e.id) } });
      if (apps.length)     entityOr.push({ entityType: 'APPLICANT', entityId: { in: apps.map(a => a.id) } });
      if (agencies.length) entityOr.push({ entityType: 'AGENCY',    entityId: { in: agencies.map(a => a.id) } });
      where.AND = [
        ...(where.AND ?? []),
        { OR: [superTenantPredicate, ...entityOr] },
      ];
    }

    // Validate sort field to prevent injection
    const allowedSorts = [
      'createdAt', 'updatedAt', 'name', 'status', 'issueDate',
      'expiryDate', 'documentNumber', 'docId', 'verifiedAt',
    ];
    const orderField = allowedSorts.includes(sortBy) ? sortBy : 'createdAt';

    const [items, total] = await Promise.all([
      this.prisma.document.findMany({ // @tenant-reviewed: phase220-pilot-scope
        where, skip, take: Number(limit),
        orderBy: { [orderField]: sortOrder },
        include: this.docInclude,
      }),
      this.prisma.document.count({ where }), // @tenant-reviewed: phase220-pilot-scope
    ]);

    // Batch-resolve owner names to avoid N+1 queries
    const empIds = [...new Set(items.filter(d => d.entityType === 'EMPLOYEE').map(d => d.entityId))];
    const appIds = [...new Set(items.filter(d => d.entityType === 'APPLICANT').map(d => d.entityId))];
    const [emps, apps] = await Promise.all([
      empIds.length ? this.prisma.employee.findMany({ where: { id: { in: empIds }, ...t }, select: { id: true, firstName: true, lastName: true, employeeNumber: true } }) : [], // @tenant-reviewed: phase220-pilot-scope
      appIds.length ? this.prisma.applicant.findMany({ where: { id: { in: appIds }, ...t }, select: { id: true, firstName: true, lastName: true, candidateNumber: true, leadNumber: true } }) : [], // @tenant-reviewed: phase220-pilot-scope
    ]);
    const empMap = Object.fromEntries(emps.map(e => [e.id, e]));
    const appMap = Object.fromEntries(apps.map(a => [a.id, a]));

    const enriched = items.map(doc => {
      if (doc.entityType === 'EMPLOYEE') {
        const e = empMap[doc.entityId];
        return { ...doc, ownerName: e ? `${e.firstName} ${e.lastName}` : null, ownerSystemId: e?.employeeNumber ?? null };
      }
      if (doc.entityType === 'APPLICANT') {
        const a = appMap[doc.entityId];
        return { ...doc, ownerName: a ? `${a.firstName} ${a.lastName}` : null, ownerSystemId: a?.candidateNumber ?? a?.leadNumber ?? null };
      }
      return { ...doc, ownerName: null, ownerSystemId: null };
    });

    return PaginatedResponse.create(enriched, total, page, limit);
  }

  /**
   * KPI counters for the list page tiles. Re-uses findAll's WHERE
   * construction (tenant scope + filters) but ignores the `status`
   * filter so the four tiles always sum to the visible list when
   * no other status filter is active.
   *
   * `expiringSoon` and `expired` are computed from `expiryDate`
   * (matching the dashboard widget definition), not from the stored
   * status column — which is usually VERIFIED/PENDING even when the
   * doc is past expiry.
   */
  async getKpis(filter: FilterDocumentsDto, caller?: any) {
    const t = this.scope().tenantWhere();
    await assertRequestedTenantExists(caller, filter.tenantId, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, filter.tenantId);

    // Strip status from the filter so each tile can apply its own.
    const baseFilter = { ...filter, status: undefined };
    const where: any = {
      ...this.buildWhere(baseFilter), ...t,
      ...(superTenantPredicate ? {} : activeTenantWhere(caller)),
    };
    if (superTenantPredicate) {
      const targetTenantId = (superTenantPredicate as any).tenantId as string;
      const [emps, apps, agencies] = await Promise.all([
        this.prisma.employee.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
        this.prisma.applicant.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
        this.prisma.agency.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
      ]);
      const entityOr: any[] = [];
      if (emps.length)     entityOr.push({ entityType: 'EMPLOYEE',  entityId: { in: emps.map(e => e.id) } });
      if (apps.length)     entityOr.push({ entityType: 'APPLICANT', entityId: { in: apps.map(a => a.id) } });
      if (agencies.length) entityOr.push({ entityType: 'AGENCY',    entityId: { in: agencies.map(a => a.id) } });
      where.AND = [...(where.AND ?? []), { OR: [superTenantPredicate, ...entityOr] }];
    }

    const now = new Date();
    const fwd60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    const [valid, expiringSoon, expired, pending, total] = await Promise.all([
      // VERIFIED and not currently expired and not in the 60-day window
      this.prisma.document.count({ where: { ...where, status: 'VERIFIED' as any, OR: [{ expiryDate: null }, { expiryDate: { gt: fwd60 } }] } }),
      // expiryDate in (now, +60d]
      this.prisma.document.count({ where: { ...where, expiryDate: { not: null, gt: now, lte: fwd60 } } }),
      // expiryDate < now OR stored EXPIRED
      this.prisma.document.count({ where: { ...where, OR: [{ status: 'EXPIRED' as any }, { expiryDate: { lt: now } }] } }),
      this.prisma.document.count({ where: { ...where, status: 'PENDING' as any } }),
      this.prisma.document.count({ where }),
    ]);

    return { valid, expiringSoon, expired, pending, total };
  }

  async findOne(id: string, caller?: any) {
    const t = this.scope().tenantWhere();
    // Look up by id first; tenant isolation is enforced by gating on the
    // owning entity below (same approach as findByEntity). Filtering on
    // doc.tenantId here would 404 legacy / mis-stamped docs that still
    // belong to a person the caller can reach.
    const doc = await this.prisma.document.findFirst({ // @tenant-reviewed: phase220-pilot-scope
      where: { id, deletedAt: null, ...t },
      include: {
        ...this.docInclude,
        renewals: { select: { id: true, docId: true, name: true, status: true, createdAt: true } },
      },
    });
    if (!doc) throw new NotFoundException({ code: 'DOCUMENT.NOT_FOUND', message: `Document ${id} not found`, params: { id } });

    // Permission scope: a caller who reached this endpoint via
    // attendance:read only (no general documents:read) may view only
    // ATTENDANCE-linked documents.
    await this.assertReadableByCaller(doc.entityType as string, id, caller);

    // Tenant gate via entity (SUPER bypasses).
    if (!(await this.isSameTenantAsCaller(doc.entityType as string, doc.entityId, caller))) {
      throw new NotFoundException({ code: 'DOCUMENT.NOT_FOUND', message: `Document ${id} not found`, params: { id } });
    }

    // Resolve the owning entity (employee/applicant) so the View page can
    // show owner name + system id. Tenant-scoped identically to the list.
    let ownerName: string | null = null;
    let ownerSystemId: string | null = null;
    if (doc.entityType === 'EMPLOYEE') {
      const e = await this.prisma.employee.findFirst({ where: { id: doc.entityId, ...t }, select: { firstName: true, lastName: true, employeeNumber: true } }); // @tenant-reviewed: phase220-pilot-scope
      if (e) { ownerName = `${e.firstName} ${e.lastName}`; ownerSystemId = e.employeeNumber ?? null; }
    } else if (doc.entityType === 'APPLICANT') {
      const a = await this.prisma.applicant.findFirst({ where: { id: doc.entityId, ...t }, select: { firstName: true, lastName: true, candidateNumber: true, leadNumber: true } }); // @tenant-reviewed: phase220-pilot-scope
      if (a) { ownerName = `${a.firstName} ${a.lastName}`; ownerSystemId = a.candidateNumber ?? a.leadNumber ?? null; }
    }
    return { ...doc, ownerName, ownerSystemId };
  }

  /**
   * Reads a single document's bytes for the same-origin file proxy.
   * Uses the same fetch path as the bulk-download archive so URL repair
   * and legacy `/uploads/...` handling stay in one place.
   */
  async readDocumentBytes(id: string, caller?: any): Promise<{ buffer: Buffer; mimeType: string; name: string }> {
    const t = this.scope().tenantWhere();
    // findFirst (was findUnique) so the metadata lookup is tenant-
    // scoped in pilot mode. The storage byte fetch uses only the URL
    // returned by this lookup, so a cross-tenant id can never reach
    // a foreign file's bytes.
    const doc = await this.prisma.document.findFirst({ // @tenant-reviewed: phase222-download-guard (metadata gates storage read; cross-tenant ids never reach fetchDocumentBuffer)
      where: { id, deletedAt: null, ...t },
      select: { id: true, name: true, fileUrl: true, mimeType: true, entityType: true, entityId: true },
    });
    if (!doc) throw new NotFoundException({ code: 'DOCUMENT.NOT_FOUND', message: `Document ${id} not found`, params: { id } });
    // Same permission scope as findOne: attendance-only callers may
    // stream ATTENDANCE-linked files only.
    await this.assertReadableByCaller(doc.entityType as string, id, caller);
    // Same tenant gate as findOne — the byte stream must never be weaker
    // than the metadata endpoint.
    if (!(await this.isSameTenantAsCaller(doc.entityType as string, doc.entityId, caller))) {
      throw new NotFoundException({ code: 'DOCUMENT.NOT_FOUND', message: `Document ${id} not found`, params: { id } });
    }
    if (!doc.fileUrl) throw new NotFoundException({ code: 'DOCUMENT.FILE_MISSING', message: 'Document has no file', params: { id } });
    const buffer = await this.fetchDocumentBuffer(doc.fileUrl);
    return { buffer, mimeType: doc.mimeType ?? 'application/octet-stream', name: doc.name ?? 'document' };
  }

  async findByEntity(entityType: string, entityId: string, pagination: PaginationDto, caller?: any) {
    const { page = 1, limit = 50 } = pagination;
    const skip  = (Number(page) - 1) * Number(limit);
    // Archive view (query param `archived`): default hides archived docs
    // so the profile's Documents tab shows only the active set.
    const archivedView = (pagination as any).archived as string | undefined;
    const archivedPredicate: any =
      archivedView === 'archived' ? { archivedAt: { not: null } } :
      archivedView === 'all'      ? {} :
                                    { archivedAt: null };
    // Tenant gate is on the entity, not on doc.tenantId. Legacy or
    // mis-stamped doc.tenantId would otherwise hide rows belonging to
    // a person whose profile the caller has full access to. SUPER may
    // see any entity's docs; non-SUPER must match the entity's tenant
    // (or pass through when the entity has no tenant stamped).
    const isSuper = caller?.agencyIsSystem === true;
    if (!isSuper) {
      const entityTenantId = await this.resolveEntityTenantId(entityType, entityId);
      const callerTenantId = (caller?.tenantId ?? '').toString().trim() || null;
      if (entityTenantId && callerTenantId && entityTenantId !== callerTenantId) {
        return PaginatedResponse.create([], 0, page, limit);
      }
    }
    // Base filter: documents owned directly by the entity.
    // For EMPLOYEE entities we also include proof files attached to
    // any of the employee's attendance days (entityType=ATTENDANCE),
    // so the Document Explorer & Employee Documents tab show every
    // file linked to the person in one place.
    let where: any = { entityType: entityType as any, entityId, deletedAt: null, ...archivedPredicate };
    if (entityType === 'EMPLOYEE') {
      const attRecords = await (this.prisma as any).attendanceRecord.findMany({ // @tenant-reviewed: phase220-pilot-scope (parent employee already tenant-gated above)
        where: { employeeId: entityId },
        select: { id: true },
      });
      const attendanceIds = attRecords.map((r: any) => r.id);
      if (attendanceIds.length) {
        where = {
          deletedAt: null,
          ...archivedPredicate,
          OR: [
            { entityType: 'EMPLOYEE', entityId },
            { entityType: 'ATTENDANCE' as any, entityId: { in: attendanceIds } },
          ],
        };
      }
    }
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({ // @tenant-reviewed: phase220-pilot-scope
        where, skip, take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: this.docInclude,
      }),
      this.prisma.document.count({ where }), // @tenant-reviewed: phase220-pilot-scope
    ]);
    return PaginatedResponse.create(items, total, page, limit);
  }

  // ── Check document-type permission for a user role ─────────────────────────

  async checkDocTypePermission(
    documentTypeId: string,
    roleId: string,
    action: 'canUpload' | 'canView' | 'canEdit' | 'canDelete' | 'canRenew',
  ): Promise<boolean> {
    const perm = await this.prisma.documentTypePermission.findUnique({ // @tenant-reviewed: phase220-global
      where: { documentTypeId_roleId: { documentTypeId, roleId } },
    });
    // No specific permission row → fall back to allowed (general role check covers it)
    if (!perm) return true;
    return perm[action] === true;
  }

  // ── Public upload (no auth) ────────────────────────────────────────────────

  async publicCreate(
    file: Express.Multer.File,
    entityId: string,
    name: string,
    documentTypeName: string,
    sectionKey?: string,
  ) {
    // Recover UTF-8 names multer decoded as latin1 (the public apply
    // form often sends the raw filename).
    name = decodeUploadFilename(name);
    // Profile photo short-circuit ─────────────────────────────────────────
    // The public /apply form uploads the applicant's profile photo via
    // the same endpoint as supporting documents. It isn't a compliance
    // artefact, so we only persist it to applicant.photoUrl (which the
    // profile header + Step 1 preview read) and skip the Document row.
    // Otherwise, when no "Profile Photo" DocumentType exists, the
    // first-available fallback below mis-classifies the photo as the
    // oldest type (typically Passport), producing a ghost entry in the
    // Documents tab like "Profile Photo · Passport".
    if (documentTypeName?.toLowerCase().includes('photo')) {
      // Phase 2.21 — when an ALS tenant IS attached (rare for the
      // public flow), validate the applicant belongs to it before
      // touching storage. When no ALS tenant, the pilot scope is
      // inactive and the lookup matches by id alone (legacy).
      if (this.scope().active) {
        const t = this.scope().tenantWhere();
        const owner = await this.prisma.applicant.findFirst({ where: { id: entityId, ...t }, select: { id: true } }); // @tenant-reviewed: phase221-storage-guard
        if (!owner) throw new NotFoundException({ code: 'DOCUMENT.ENTITY_NOT_FOUND', message: `Applicant ${entityId} not found`, params: { entityId } });
      }
      const upload = await this.storage.uploadFile(file.buffer, {
        keyPrefix: `applicants/${entityId}/photos`,
        contentType: file.mimetype,
        originalName: file.originalname,
        inline: true,
      });
      await this.legacyPrisma.applicant.updateMany({ where: { id: entityId }, data: { photoUrl: upload.url } }); // @tenant-reviewed: phase221-pilot-scope-precheck (storage guard above gates the photo write)
      return { id: null, photoUrl: upload.url, name, mimeType: file.mimetype, fileSize: file.size };
    }

    // Section-key → canonical DocumentType-name hints. The public form
    // upload widgets pass language-agnostic section keys, which we
    // resolve here BEFORE the documentTypeName so a localized label
    // like "رفع جواز السفر" can never get mis-classified as "the first
    // DocumentType in the DB".
    const sectionToTypeName: Record<string, string> = {
      drivingLicense: 'Driving License',
      passport: 'Passport',
      idCard: 'National ID Card',
      euVisa: 'EU Visa',
      euResidence: 'EU Residence',
      euWorkPermit: 'EU Work Permit',
      workPermit: 'EU Work Permit',
      homeCriminalRecord: 'Criminal Record',
      euCriminalRecord: 'Criminal Record',
      firstAid: 'First Aid Certificate',
    };
    const sectionHint = sectionKey?.startsWith('required:')
      ? sectionKey.slice('required:'.length)
      : sectionToTypeName[sectionKey ?? ''];

    const findByName = (n: string) =>
      this.prisma.documentType.findFirst({ where: { name: { equals: n, mode: 'insensitive' } } }); // @tenant-reviewed: phase220-global

    let docType: any = null;

    // Try the section hint first (stable, language-agnostic).
    if (sectionHint) docType = await findByName(sectionHint);

    // Then the explicit documentTypeName (exact → contains → substring).
    if (!docType && documentTypeName) {
      docType = await findByName(documentTypeName);
    }
    if (!docType && documentTypeName) {
      docType = await this.prisma.documentType.findFirst({ // @tenant-reviewed: phase220-global
        where: { name: { contains: documentTypeName, mode: 'insensitive' } },
      });
    }
    if (!docType && documentTypeName) {
      const all = await this.prisma.documentType.findMany(); // @tenant-reviewed: phase220-global
      docType = all.find(t => documentTypeName.toLowerCase().includes(t.name.toLowerCase())) ?? null;
    }
    // Last-resort fallback: only use "Other" (or auto-create it) instead
    // of "first DocumentType in DB" so an unmatched upload never silently
    // gets classified as Passport just because it happens to be the first
    // row created during seeding.
    if (!docType) {
      docType = await findByName('Other');
      if (!docType) {
        try {
          docType = await this.legacyPrisma.documentType.create({ // @tenant-reviewed: phase220-excluded-mutation
            data: { name: 'Other', category: 'OTHER', isActive: true },
          });
        } catch {
          // If create fails (e.g. unique-name race), retry the lookup.
          docType = await findByName('Other');
        }
      }
    }
    if (!docType) throw new BadRequestException({ code: 'DOCUMENT.TYPES_NOT_CONFIGURED', message: 'No document types configured' });

    // Phase 2.21 — STORAGE GUARD for the public flow. Active only
    // when an ALS tenant is attached (rare). When no ALS tenant,
    // pilot scope is inactive and behaviour is byte-identical to
    // pre-2.21 public uploads.
    if (this.scope().active) {
      const t = this.scope().tenantWhere();
      const owner = await this.prisma.applicant.findFirst({ where: { id: entityId, ...t }, select: { id: true } }); // @tenant-reviewed: phase221-storage-guard
      if (!owner) throw new NotFoundException({ code: 'DOCUMENT.ENTITY_NOT_FOUND', message: `Applicant ${entityId} not found`, params: { entityId } });
    }

    // Attribute to System Admin
    let systemUser = await this.legacyPrisma.user.findFirst({ // @tenant-reviewed: phase220-excluded-mutation
      where: { role: { name: 'System Admin' }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!systemUser) systemUser = await this.legacyPrisma.user.findFirst({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } }); // @tenant-reviewed: phase220-excluded-mutation
    if (!systemUser) throw new BadRequestException({ code: 'DOCUMENT.NO_ATTRIBUTION_USER', message: 'No users found to attribute upload to' });

    const safeDocType = this.sanitize(docType.name) || 'Others';
    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `documents/APPLICANT/${entityId}/${safeDocType}`,
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),
    });
    const fileUrl = upload.url;

    // Generate doc ID inside a transaction
    const tdataPub = this.scope().tenantData();
    const document = await this.legacyPrisma.$transaction(async (tx) => { // @tenant-reviewed: phase221-pilot-scope (writes tenantId via scope.tenantData when ALS attached; no-op for public flow)
      const docId = await this.documentIdService.generate(entityId, 'APPLICANT', docType!.id, tx);
      return tx.document.create({
        data: {
          docId,
          name,
          documentTypeId: docType!.id,
          entityType: 'APPLICANT' as any,
          entityId,
          fileUrl,
          mimeType: file.mimetype,
          fileSize: file.size,
          status: 'PENDING',
          uploadedById: systemUser!.id,
          ...tdataPub,
        },
        include: this.docInclude,
      });
    });

    return document;
  }

  // ── Authenticated upload ───────────────────────────────────────────────────

  async create(
    dto: CreateDocumentDto,
    file: Express.Multer.File,
    uploadedById: string,
    callerTenantId?: string | null,
    opts?: { skipContractSync?: boolean },
  ) {
    const docType = await this.prisma.documentType.findUnique({ where: { id: dto.documentTypeId } }); // @tenant-reviewed: phase220-global
    if (!docType) throw new NotFoundException({ code: 'DOCUMENT.TYPE_NOT_FOUND', message: 'Document type not found' });

    // Per-type required metadata (e.g. Passport needs issue + expiry date).
    // Enforced server-side so a crafted payload can't bypass the form.
    assertDocumentMetadata(docType, {
      issueDate: dto.issueDate,
      expiryDate: dto.expiryDate,
      documentNumber: dto.documentNumber,
    });

    // Phase 2.21 — STORAGE GUARD. Validate that the owner entity
    // belongs to the active tenant BEFORE touching object storage.
    // In legacy mode (`tenantWhere()` returns `{}`) the lookup matches
    // by id alone — same as pre-2.21. In pilot mode a cross-tenant
    // entityId raises 404 before any file bytes are uploaded.
    await this.assertEntityOwnedByActiveTenant(dto.entityType, dto.entityId);

    const entityName  = await this.resolveEntityName(dto.entityType, dto.entityId);
    const safeDocType = this.sanitize(docType.name) || 'Others';
    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `documents/${dto.entityType}/${dto.entityId}/${safeDocType}`,
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),
    });
    const fileUrl = upload.url;

    const tdata = this.scope().tenantData();
    // Documents inherit tenant from their owning entity (Employee, Applicant,
    // etc.) — NOT from whichever tenant the uploader was active on. A SUPER
    // admin uploading a doc for a TempWorks s.r.o employee while their own
    // session is on TempWorks Europe must produce a TempWorks s.r.o-tagged
    // document, otherwise it disappears for that employee's tenant.
    const entityTenantId = await this.resolveEntityTenantId(dto.entityType, dto.entityId);
    const doc = await this.legacyPrisma.$transaction(async (tx) => { // @tenant-reviewed: phase221-pilot-scope (writes tenantId via scope.tenantData; entity pre-validated)
      const docId = await this.documentIdService.generate(dto.entityId, dto.entityType, dto.documentTypeId, tx);
      return tx.document.create({
        data: {
          docId,
          name:           dto.name,
          documentTypeId: dto.documentTypeId,
          entityType:     dto.entityType as any,
          entityId:       dto.entityId,
          fileUrl,
          mimeType:  file.mimetype,
          fileSize:  file.size,
          status:    'PENDING',
          issueDate:      dto.issueDate      ? new Date(dto.issueDate)   : undefined,
          expiryDate:     dto.expiryDate     ? new Date(dto.expiryDate)  : undefined,
          issuer:         dto.issuer,
          issueCountry:   (dto as any).issueCountry,
          documentNumber: dto.documentNumber,
          notes:          dto.notes,
          uploadedById,
          ...tdata,
          // tenantId precedence: pilot scope → entity → caller. Entity wins
          // over caller so cross-tenant uploads by SUPER tag correctly.
          ...(!(tdata as any).tenantId
            ? { tenantId: entityTenantId ?? callerTenantId ?? null }
            : {}),
        },
        include: this.docInclude,
      });
    });

    // @tenant-reviewed: phase230-audit-log-pilot
    await this.tenantAuditLog.write({
      userId: uploadedById,
      action: 'UPLOAD',
      entity: 'Document',
      entityId: doc.id,
      changes: { docId: doc.docId, name: dto.name, entityType: dto.entityType, entityId: dto.entityId },
    });

    // Phase 3 (#19) — Driving License: propagate the document number
    // to the employee's licenseNumber when that profile field is
    // empty. Failures here must never block document upload.
    try { await this.syncLicenseNumberFromDrivingLicenseDocument(doc.id, uploadedById); }
    catch (e) { this.logger.warn(`license auto-fill (create) failed: ${(e as any)?.message ?? e}`); }

    // Contracts integration — when the uploaded document is a configured
    // contract type (default: "Employment/Work Contract"), auto-create
    // or update the employee's contract record from the document
    // (Issue Date → start, Expiry Date → end). Best-effort; the service
    // itself swallows errors so upload never breaks. Skipped when the
    // caller is the Contracts flow itself (it links the contract
    // explicitly, so auto-sync would double-create).
    if (!opts?.skipContractSync) {
      await this.contracts?.syncFromDocument(doc.id, uploadedById);
    }

    if (dto.expiryDate) {
      const expiry = new Date(dto.expiryDate);
      const daysUntilExpiry = Math.floor((expiry.getTime() - Date.now()) / 86400000);
      // Per-document-type notification lead time. Operators configure
      // DocumentType.renewalPeriodDays (e.g. passport=90, driving licence=60,
      // work permit=30); falls back to 30 days when not set. Without this
      // a passport six months out never fired the 'Expiring Soon' alert
      // even though the operator had wanted a 90-day warning.
      const leadDays = Math.max(1, (docType as any)?.renewalPeriodDays ?? 30);
      if (daysUntilExpiry <= leadDays) {
        await this.legacyPrisma.complianceAlert.create({ // @tenant-reviewed: phase221-pilot-scope (writes tenantId via scope.tenantData when ComplianceAlert.tenantId column lands)
          data: {
            entityType: dto.entityType as any, entityId: dto.entityId, documentId: doc.id,
            alertType: 'DOCUMENT_EXPIRY',
            severity:  daysUntilExpiry <= 7 ? 'CRITICAL' : daysUntilExpiry <= 14 ? 'HIGH' : 'MEDIUM',
            message:   `Document "${dto.name}" (${doc.docId}) expires in ${daysUntilExpiry} days`,
            status:    'OPEN', dueDate: expiry,
            ...tdata,
          },
        });
        // Fire expiring-soon or already-expired notification
        const isExpired = daysUntilExpiry <= 0;
        this.notifications.notifyUploaderAndRoles(
          uploadedById,
          DOC_NOTIFY_ROLES,
          isExpired ? NOTIF_EVENTS.DOCUMENT_EXPIRED : NOTIF_EVENTS.DOCUMENT_EXPIRING_SOON,
          isExpired ? 'Document Expired' : 'Document Expiring Soon',
          isExpired
            ? `Document "${dto.name}" for ${entityName} has already expired.`
            : `Document "${dto.name}" for ${entityName} expires in ${daysUntilExpiry} days.`,
          dto.entityType,
          dto.entityId,
          {
            titleKey: isExpired ? 'events.documentExpired.title' : 'events.documentExpiringSoon.title',
            messageKey: isExpired ? 'events.documentExpired.body' : 'events.documentExpiringSoon.body',
            // Full document context so the daily digest renders every
            // column. relatedEntityId is the PERSON id (entityId), so
            // the digest reads document fields from params, not via a
            // doc-id lookup.
            params: {
              documentName: dto.name,
              docId: doc.docId,
              documentId: doc.id,
              documentType: (docType as any)?.name ?? null,
              expiryDate: expiry.toISOString(),
              entityType: dto.entityType,
              entityId: dto.entityId,
              entityName,
              daysUntilExpiry,
            },
          },
        ).catch(e => this.logger.error('Doc expiry notification error:', e));
      }
    }

    // Notify on every upload
    this.notifications.notifyUploaderAndRoles(
      uploadedById,
      DOC_NOTIFY_ROLES,
      NOTIF_EVENTS.DOCUMENT_UPLOADED,
      'New Document Uploaded',
      `A new document "${dto.name}" was uploaded for ${entityName}.`,
      dto.entityType,
      dto.entityId,
      {
        titleKey: 'events.documentUploaded.title',
        messageKey: 'events.documentUploaded.body',
        // documentId + entity context so the email can render clickable
        // "Open document" / "View profile" links.
        params: {
          documentName: dto.name,
          documentId: doc.id,
          docId: (doc as any).docId ?? null,
          entityType: dto.entityType,
          entityId: dto.entityId,
          entityName,
          uploaderName: '',
        },
      },
    ).catch(e => this.logger.error('Doc upload notification error:', e));

    return doc;
  }

  // ── Update metadata ────────────────────────────────────────────────────────

  async update(id: string, updateData: any, updatedById?: string) {
    const existing = await this.findOne(id);

    // Resolve the document's effective type after this update (it may be
    // changing documentTypeId) and validate the merged metadata against
    // the per-type rules. Absent keys keep the stored value, so editing
    // an unrelated field on a Passport still requires its dates to be
    // present — and clearing a required date is rejected.
    let effectiveType: { code?: string | null; name?: string | null } | null =
      (existing as any).documentType ?? null;
    if (updateData.documentTypeId && updateData.documentTypeId !== (existing as any).documentTypeId) {
      effectiveType = await this.prisma.documentType.findUnique({ where: { id: updateData.documentTypeId } }); // @tenant-reviewed: phase220-global
    }
    const pick = (key: string) => (key in updateData ? updateData[key] : (existing as any)[key]);
    assertDocumentMetadata(effectiveType, {
      issueDate: pick('issueDate'),
      expiryDate: pick('expiryDate'),
      documentNumber: pick('documentNumber'),
    });

    const data: any = { ...updateData };
    // Date fields: a present-but-empty value is an intentional clear
    // (→ null); a present non-empty value converts to a Date. Absent
    // keys are left untouched so a partial update never nulls metadata
    // the user didn't edit. Also guards against Prisma rejecting '' on
    // a DateTime column.
    if ('issueDate' in updateData) {
      data.issueDate = updateData.issueDate ? new Date(updateData.issueDate) : null;
    }
    if ('expiryDate' in updateData) {
      data.expiryDate = updateData.expiryDate ? new Date(updateData.expiryDate) : null;
    }
    // Prevent overwriting docId via update
    delete data.docId;
    const doc = await this.legacyPrisma.document.update({ where: { id }, data, include: this.docInclude }); // @tenant-reviewed: phase221-pilot-scope-precheck (findOne above is tenant-scoped)
    if (updatedById) {
      // @tenant-reviewed: phase230-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: updatedById,
        action: 'UPDATE',
        entity: 'Document',
        entityId: id,
        changes: updateData,
      });
    }

    // Phase 3 (#19) — re-evaluate Driving License auto-fill after
    // metadata edits. Only fills when the employee's licenseNumber
    // is empty, so editing the document number later never
    // overwrites a value the user has already entered.
    if ('documentNumber' in updateData || 'documentTypeId' in updateData) {
      try { await this.syncLicenseNumberFromDrivingLicenseDocument(id, updatedById); }
      catch (e) { this.logger.warn(`license auto-fill (update) failed: ${(e as any)?.message ?? e}`); }
    }

    // Keep the linked contract record in sync when the document's
    // effective dates or type change (Issue → start, Expiry → end).
    if ('issueDate' in updateData || 'expiryDate' in updateData || 'documentTypeId' in updateData) {
      await this.contracts?.syncFromDocument(id, updatedById);
    }

    return doc;
  }

  /**
   * Phase 3 (#19) — Driving License auto-fill.
   *
   * After a Driving License document is created OR its metadata
   * edited, copy the document's `documentNumber` into the owning
   * Employee's `licenseNumber` field — but only when the profile
   * field is currently empty. We never overwrite a manually-entered
   * license number.
   *
   * Detection is metadata-based (no OCR): we match by the canonical
   * DocumentType name "Driving License" (case-insensitive) so a
   * relabelled localized display string can't mis-classify the doc.
   * The lookup is gated on the document's tenant so we can never
   * mutate a cross-tenant profile in pilot mode.
   *
   * APPLICANT documents are skipped because the Applicant schema
   * stores license details inside the `applicationData` JSON blob
   * rather than a flat column, and the user spec opted out of
   * back-filling JSON shape.
   *
   * Public — re-used by upload/create/update/verify flows. Safe to
   * call multiple times; the empty-only guard makes the operation
   * idempotent.
   */
  async syncLicenseNumberFromDrivingLicenseDocument(
    documentId: string,
    actorUserId?: string,
  ): Promise<{ updated: boolean; reason?: string }> {
    const doc = await this.legacyPrisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        documentNumber: true,
        tenantId: true,
        documentType: { select: { name: true } },
      },
    });
    if (!doc) return { updated: false, reason: 'document-not-found' };
    const typeName = (doc.documentType?.name ?? '').trim().toLowerCase();
    if (typeName !== 'driving license') return { updated: false, reason: 'not-driving-license' };
    const number = (doc.documentNumber ?? '').trim();
    if (!number) return { updated: false, reason: 'document-number-empty' };

    // Gate lookups on the document's tenant when both sides carry one.
    // The create() path pre-validates this via assertEntityOwnedByActiveTenant;
    // the extra predicate here protects the update() path.
    const tenantPredicate = doc.tenantId ? { tenantId: doc.tenantId } : {};

    if (doc.entityType === 'EMPLOYEE') {
      const employee = await this.legacyPrisma.employee.findFirst({
        where: { id: doc.entityId, ...tenantPredicate },
        select: { id: true, licenseNumber: true, tenantId: true },
      });
      if (!employee) return { updated: false, reason: 'employee-not-in-tenant' };
      const existing = (employee.licenseNumber ?? '').trim();
      if (existing) return { updated: false, reason: 'license-number-already-set' };

      await this.legacyPrisma.employee.update({
        where: { id: employee.id },
        data: { licenseNumber: number },
      });

      if (actorUserId) {
        try {
          await this.tenantAuditLog.write({
            userId: actorUserId,
            action: 'AUTO_FILL_LICENSE_NUMBER',
            entity: 'Employee',
            entityId: employee.id,
            changes: { licenseNumber: number, source: 'document', documentId: doc.id },
          });
        } catch (e) {
          this.logger.warn(`license auto-fill audit log failed: ${(e as any)?.message ?? e}`);
        }
      }
      return { updated: true };
    }

    if (doc.entityType === 'APPLICANT') {
      // Applicant license details live inside applicationData JSON. Read,
      // patch the licenseNumber key only when empty, write back.
      const applicant: any = await this.legacyPrisma.applicant.findFirst({
        where: { id: doc.entityId, ...tenantPredicate },
        select: { id: true, applicationData: true, tenantId: true },
      });
      if (!applicant) return { updated: false, reason: 'applicant-not-in-tenant' };
      const ad = (applicant.applicationData && typeof applicant.applicationData === 'object')
        ? { ...(applicant.applicationData as Record<string, any>) }
        : {};
      const existing = (ad.licenseNumber ?? '').toString().trim();
      if (existing) return { updated: false, reason: 'license-number-already-set' };

      ad.licenseNumber = number;
      await this.legacyPrisma.applicant.update({
        where: { id: applicant.id },
        data: { applicationData: ad },
      });

      if (actorUserId) {
        try {
          await this.tenantAuditLog.write({
            userId: actorUserId,
            action: 'AUTO_FILL_LICENSE_NUMBER',
            entity: 'Applicant',
            entityId: applicant.id,
            changes: { licenseNumber: number, source: 'document', documentId: doc.id },
          });
        } catch (e) {
          this.logger.warn(`license auto-fill audit log failed: ${(e as any)?.message ?? e}`);
        }
      }
      return { updated: true };
    }

    return { updated: false, reason: 'entity-type-not-supported' };
  }

  // ── Verify / reject ────────────────────────────────────────────────────────

  async verify(id: string, dto: VerifyDocumentDto, verifiedById: string) {
    const doc = await this.findOne(id);

    if (doc.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'DOCUMENT.ALREADY_VERIFIED',
        message: `Document is already ${doc.status.charAt(0) + doc.status.slice(1).toLowerCase()} and cannot be re-verified`,
        params: { status: doc.status.toLowerCase() },
      });
    }

    const isApprove = dto.action === VerifyActionEnum.VERIFY;
    const newStatus = isApprove ? 'VERIFIED' : 'REJECTED';

    const updated = await this.legacyPrisma.document.update({ // @tenant-reviewed: phase221-pilot-scope-precheck (findOne above is tenant-scoped)
      where: { id },
      data: {
        status:          newStatus as any,
        verifiedById,
        verifiedAt:      new Date(),
        rejectionReason: isApprove ? null : (dto.reason ?? null),
        notes:           dto.reason
          ? `${(doc as any).notes || ''}\n[${isApprove ? 'Approved' : 'Rejected'}] ${dto.reason}`.trim()
          : (doc as any).notes,
      },
      include: this.docInclude,
    });

    if (isApprove) {
      await this.legacyPrisma.complianceAlert.updateMany({ // @tenant-reviewed: phase221-pilot-scope-precheck (parent document tenant-checked above)
        where: { documentId: id, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: verifiedById },
      });
      await this.checkAndAutoCompleteStage(doc.entityType as string, doc.entityId, verifiedById);
    }

    // @tenant-reviewed: phase230-audit-log-pilot
    await this.tenantAuditLog.write({
      userId: verifiedById,
      action: isApprove ? 'VERIFY_DOCUMENT' : 'REJECT_DOCUMENT',
      entity: 'Document',
      entityId: id,
      changes: { status: newStatus, docId: (doc as any).docId, reason: dto.reason },
    });

    // Spec §4.11 — Documents & Compliance: notify the uploader + the
    // standard doc-roles group that the pending document has been
    // approved or rejected. The rejection message carries the reason
    // verbatim so the recipient sees what to fix. Fire-and-forget so
    // a transient notify failure never blocks the verify itself.
    const docName    = (doc as any).name as string;
    const uploaderId = (doc as any).uploadedById as string | undefined;
    if (isApprove) {
      this.notifications.notifyUploaderAndRoles(
        uploaderId ?? '',
        DOC_NOTIFY_ROLES,
        NOTIF_EVENTS.DOCUMENT_APPROVED,
        'Document Approved',
        `Document "${docName}" was approved.`,
        doc.entityType as string,
        doc.entityId,
        {
          titleKey: 'events.documentApproved.title',
          messageKey: 'events.documentApproved.body',
          params: {
            documentName: docName,
            documentId: (doc as any).id ?? id,
            entityType: doc.entityType,
            entityId: doc.entityId,
          },
        },
      ).catch(e => this.logger.error('Doc approval notification error:', e));
    } else {
      this.notifications.notifyUploaderAndRoles(
        uploaderId ?? '',
        DOC_NOTIFY_ROLES,
        NOTIF_EVENTS.DOCUMENT_REJECTED,
        'Document Rejected',
        dto.reason
          ? `Document "${docName}" was rejected: ${dto.reason}`
          : `Document "${docName}" was rejected.`,
        doc.entityType as string,
        doc.entityId,
        {
          titleKey: 'events.documentRejected.title',
          messageKey: 'events.documentRejected.body',
          // Full document context for the daily digest. relatedEntityId
          // is the PERSON id (entityId); the digest reads document
          // fields from params rather than a doc-id lookup.
          params: {
            documentName: docName,
            docId: (doc as any).docId ?? null,
            documentId: (doc as any).id ?? id,
            documentType: (doc as any).documentType?.name ?? null,
            expiryDate: (doc as any).expiryDate ? new Date((doc as any).expiryDate).toISOString() : null,
            entityType: doc.entityType,
            entityId: doc.entityId,
            reason: dto.reason ?? '',
          },
        },
      ).catch(e => this.logger.error('Doc rejection notification error:', e));
    }

    return updated;
  }

  // ── Renew a document ───────────────────────────────────────────────────────
  /**
   * Renewal creates a NEW Document record that:
   *  - shares entityId, entityType, documentTypeId with the original
   *  - sets renewedFromId = originalDoc.id
   *  - receives its own new business docId (next sequence number)
   *  - starts with PENDING status
   * The original document is NOT modified (history is preserved).
   * A file must be re-uploaded via a separate upload call if needed,
   * or pass existingFileUrl to reuse the file temporarily.
   */
  async renew(
    originalId: string,
    dto: RenewDocumentDto,
    file: Express.Multer.File | undefined,
    renewedById: string,
  ) {
    const original = await this.findOne(originalId);

    // Renewal now requires a new file — the whole point is to replace the
    // expiring/expired document with the fresh copy. (Previously the old
    // file reference was reused; that led to renewals with no new scan.)
    if (!file) {
      throw new BadRequestException({ code: 'DOCUMENT.RENEWAL_FILE_REQUIRED', message: 'A new document file is required to renew.' });
    }

    const safeDocType = this.sanitize((original as any).documentType?.name) || 'Others';
    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `documents/${original.entityType}/${original.entityId}/${safeDocType}`,
      contentType: file.mimetype,
      originalName: decodeUploadFilename(file.originalname),
      inline: file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),
    });
    const fileUrl  = upload.url;
    const mimeType = file.mimetype;
    const fileSize = file.size;

    const tdataRenew = this.scope().tenantData();
    const alreadyArchived = !!(original as any).archivedAt;
    const renewed = await this.legacyPrisma.$transaction(async (tx) => { // @tenant-reviewed: phase221-pilot-scope (findOne tenant gate above; renewal row carries tenantId via scope.tenantData)
      const docId = await this.documentIdService.generate(
        original.entityId, original.entityType as string, original.documentTypeId, tx,
      );
      const created = await tx.document.create({
        data: {
          docId,
          name:           dto.name ?? `${(original as any).name} (Renewal)`,
          documentTypeId: original.documentTypeId,
          entityType:     original.entityType,
          entityId:       original.entityId,
          fileUrl, mimeType, fileSize,
          status:         'PENDING',
          issueDate:      dto.issueDate      ? new Date(dto.issueDate)  : undefined,
          expiryDate:     dto.expiryDate     ? new Date(dto.expiryDate) : undefined,
          issuer:         dto.issuer         ?? (original as any).issuer,
          issueCountry:   dto.issueCountry   ?? (original as any).issueCountry,
          documentNumber: dto.documentNumber ?? (original as any).documentNumber,
          notes:          dto.notes,
          renewedFromId:  originalId,
          uploadedById:   renewedById,
          ...tdataRenew,
        },
        include: this.docInclude,
      });
      // Auto-archive the superseded original in the same transaction —
      // the new copy is now the current document; the old one drops out
      // of the active/highlighted set but stays in history.
      if (!alreadyArchived) {
        await tx.document.update({
          where: { id: originalId },
          data: { archivedAt: new Date(), archivedBy: renewedById },
        });
      }
      return created;
    });

    // @tenant-reviewed: phase230-audit-log-pilot
    await this.tenantAuditLog.write({
      userId: renewedById,
      action: 'RENEW_DOCUMENT',
      entity: 'Document',
      entityId: renewed.id,
      changes: { renewedFromId: originalId, originalDocId: (original as any).docId, newDocId: renewed.docId, archivedOriginal: !alreadyArchived },
    });
    if (!alreadyArchived) {
      await this.tenantAuditLog.write({
        userId: renewedById, action: 'ARCHIVE_DOCUMENT', entity: 'Document', entityId: originalId,
        changes: { reason: 'auto-archived on renewal', supersededBy: renewed.docId },
      }).catch(() => undefined);
    }

    // Spec §4.11 — Documents & Compliance: notify the original
    // uploader + the doc-roles group that a renewal has been filed.
    // Points to the new (renewed) document so the View link in the
    // bell-icon dropdown opens the replacement.
    this.notifications.notifyUploaderAndRoles(
      (original as any).uploadedById ?? '',
      DOC_NOTIFY_ROLES,
      NOTIF_EVENTS.DOCUMENT_RENEWED,
      'Document Renewed',
      `Document "${(original as any).name}" was renewed (new ${renewed.docId}).`,
      original.entityType as string,
      original.entityId,
      {
        titleKey: 'events.documentRenewed.title',
        messageKey: 'events.documentRenewed.body',
        params: {
          documentName: (original as any).name,
          newDocId: renewed.docId,
        },
      },
    ).catch(e => this.logger.error('Doc renewal notification error:', e));

    return renewed;
  }

  // ── Archive / Unarchive (manual "No longer valid") ─────────────────────────
  //
  // Distinct from delete: the document stays fully stored and viewable in
  // history, it just drops out of the active/highlighted set (lists,
  // compliance counts, expiry reminders, digest). Manual by design — an
  // expired-but-not-yet-replaced document (e.g. awaiting a new TRC) stays
  // active until the operator archives it.

  async archive(id: string, actorId?: string) {
    const doc = await this.findOne(id); // tenant-scoped lookup / 404
    if ((doc as any).archivedAt) return { message: 'Document already archived', id };
    await this.legacyPrisma.document.update({ // @tenant-reviewed: phase221-pilot-scope-precheck (findOne above is tenant-scoped)
      where: { id },
      data: { archivedAt: new Date(), archivedBy: actorId ?? null },
    });
    if (actorId) {
      // @tenant-reviewed: phase230-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: actorId, action: 'ARCHIVE_DOCUMENT', entity: 'Document', entityId: id,
        changes: { docId: (doc as any).docId, name: (doc as any).name },
      });
    }
    return { message: 'Document archived', id };
  }

  async unarchive(id: string, actorId?: string) {
    const doc = await this.findOne(id);
    if (!(doc as any).archivedAt) return { message: 'Document is not archived', id };
    await this.legacyPrisma.document.update({ // @tenant-reviewed: phase221-pilot-scope-precheck (findOne above is tenant-scoped)
      where: { id },
      data: { archivedAt: null, archivedBy: null },
    });
    if (actorId) {
      await this.tenantAuditLog.write({
        userId: actorId, action: 'UNARCHIVE_DOCUMENT', entity: 'Document', entityId: id,
        changes: { docId: (doc as any).docId, name: (doc as any).name },
      });
    }
    return { message: 'Document restored to active', id };
  }

  // ── Delete (soft) ──────────────────────────────────────────────────────────

  async remove(id: string, deletedById?: string) {
    const doc = await this.findOne(id);

    // Restriction: approved documents require explicit bypass
    if ((doc as any).status === 'VERIFIED') {
      // Allow System Admin via service; controller should check role before calling
    }

    await this.legacyPrisma.document.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: deletedById ?? null } }); // @tenant-reviewed: phase221-pilot-scope-precheck (findOne above is tenant-scoped)
    if (deletedById) {
      // @tenant-reviewed: phase230-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: deletedById,
        action: 'DELETE',
        entity: 'Document',
        entityId: id,
        changes: { docId: (doc as any).docId, name: (doc as any).name },
      });
    }
    return { message: 'Document deleted' };
  }

  // ── Bulk download as ZIP ───────────────────────────────────────────────────

  async createBulkDownloadArchive(ids: string[], caller?: any): Promise<Buffer> {
    // Phase 2.22 — DOWNLOAD GUARD. Pre-filter the requested id list
    // by the active tenant BEFORE issuing any storage reads. In legacy
    // mode the spread is `{}` and the lookup matches by id alone (same
    // as pre-2.22). In pilot mode foreign-tenant ids are silently
    // dropped; the storage loop below only sees URLs the active
    // tenant owns.
    const t = this.scope().tenantWhere();
    const found = await this.prisma.document.findMany({ // @tenant-reviewed: phase222-download-guard (tenant pre-filter on id list; foreign ids never reach fetchDocumentBuffer)
      where: { id: { in: ids }, deletedAt: null, ...t },
      include: { documentType: { select: { name: true } } },
    });
    // Entity-tenant gate (enforced in legacy mode too): foreign-tenant ids are
    // dropped before any storage read.
    const docs: typeof found = [];
    for (const d of found) {
      if (await this.isSameTenantAsCaller(d.entityType as string, d.entityId, caller)) docs.push(d);
    }
    const entityIds = [...new Set(docs.map(d => d.entityId))];
    const nameMap: Record<string, string> = {};
    await Promise.all(entityIds.map(async (eid) => {
      const d = docs.find(x => x.entityId === eid)!;
      nameMap[eid] = this.sanitize(await this.resolveEntityName(d.entityType as string, eid) || d.entityType);
    }));

    const zip = new AdmZip();
    const usedPaths = new Set<string>();
    for (const doc of docs) {
      let content: Buffer;
      try {
        content = await this.fetchDocumentBuffer(doc.fileUrl);
      } catch {
        continue;
      }
      const entityFolder = nameMap[doc.entityId] || 'Unknown';
      const typeFolder   = this.sanitize((doc as any).documentType?.name || 'Documents');
      const ext          = doc.fileUrl.includes('.') ? '.' + doc.fileUrl.split('.').pop()! : '';
      const baseName     = ((doc as any).docId ? this.sanitize((doc as any).docId) : this.sanitize(doc.name)) || 'document';
      let entryPath      = `${entityFolder}/${typeFolder}/${baseName}${ext}`;
      if (usedPaths.has(entryPath)) {
        let counter = 2;
        while (usedPaths.has(`${entityFolder}/${typeFolder}/${baseName}_${counter}${ext}`)) counter++;
        entryPath = `${entityFolder}/${typeFolder}/${baseName}_${counter}${ext}`;
      }
      usedPaths.add(entryPath);
      zip.addFile(entryPath, content);
    }
    return zip.toBuffer();
  }

  // ── Expiring documents ─────────────────────────────────────────────────────

  async getExpiringDocuments(days = 30) {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + days);
    const t = this.scope().tenantWhere();
    return this.prisma.document.findMany({ // @tenant-reviewed: phase220-pilot-scope
      where: { deletedAt: null, archivedAt: null, status: { notIn: ['REJECTED'] }, expiryDate: { not: null, lte: threshold, gte: new Date() }, ...t },
      include: this.docInclude,
      orderBy: { expiryDate: 'asc' },
    });
  }

  // ── Document-type permission CRUD (for Settings module) ────────────────────

  async getDocTypePermissions(documentTypeId: string) {
    return this.prisma.documentTypePermission.findMany({ // @tenant-reviewed: phase220-global
      where: { documentTypeId },
      include: { role: { select: { id: true, name: true } } },
    });
  }

  async upsertDocTypePermission(
    documentTypeId: string,
    roleId: string,
    perms: Partial<{ canUpload: boolean; canView: boolean; canEdit: boolean; canDelete: boolean; canRenew: boolean }>,
  ) {
    return this.legacyPrisma.documentTypePermission.upsert({ // @tenant-reviewed: phase220-excluded-mutation
      where: { documentTypeId_roleId: { documentTypeId, roleId } },
      create: { documentTypeId, roleId, ...perms },
      update: perms,
    });
  }

  // ── Private: auto-complete workflow stage ──────────────────────────────────

  private async checkAndAutoCompleteStage(entityType: string, entityId: string, actorId: string) {
    let currentStageId: string | null = null;
    if (entityType === 'EMPLOYEE') {
      const s = await this.legacyPrisma.employeeStage.findFirst({ where: { employeeId: entityId, status: 'IN_PROGRESS' } }); // @tenant-reviewed: phase220-excluded-mutation
      currentStageId = s?.stageId ?? null;
    } else if (entityType === 'APPLICANT') {
      const a = await this.legacyPrisma.applicant.findUnique({ where: { id: entityId, deletedAt: null }, select: { currentWorkflowStageId: true } }); // @tenant-reviewed: phase220-excluded-mutation
      currentStageId = a?.currentWorkflowStageId ?? null;
    }
    if (!currentStageId) return;

    const stage = await this.legacyPrisma.stageTemplate.findUnique({ where: { id: currentStageId }, select: { id: true, order: true, requirementsDocuments: true } }); // @tenant-reviewed: phase220-excluded-mutation
    if (!stage || stage.requirementsDocuments.length === 0) return;

    const verifiedDocs = await this.legacyPrisma.document.findMany({ // @tenant-reviewed: phase220-excluded-mutation
      where: { entityType: entityType as any, entityId, status: 'VERIFIED', deletedAt: null },
      include: { documentType: { select: { name: true } } },
    });
    const verifiedNames = new Set((verifiedDocs as any[]).map(d => d.documentType.name));
    if (!stage.requirementsDocuments.every(r => verifiedNames.has(r))) return;

    const nextStage = await this.legacyPrisma.stageTemplate.findFirst({ where: { order: { gt: stage.order }, isActive: true }, orderBy: { order: 'asc' } }); // @tenant-reviewed: phase220-excluded-mutation

    if (entityType === 'EMPLOYEE') {
      await this.legacyPrisma.employeeStage.updateMany({ where: { employeeId: entityId, stageId: currentStageId, status: 'IN_PROGRESS' }, data: { status: 'COMPLETED', completedAt: new Date() } }); // @tenant-reviewed: phase220-excluded-mutation
      if (nextStage) {
        await this.legacyPrisma.employeeStage.upsert({ // @tenant-reviewed: phase220-excluded-mutation
          where: { employeeId_stageId: { employeeId: entityId, stageId: nextStage.id } },
          create: { employeeId: entityId, stageId: nextStage.id, status: 'IN_PROGRESS', startedAt: new Date() },
          update: { status: 'IN_PROGRESS', startedAt: new Date(), completedAt: null },
        });
      }
    } else {
      await this.legacyPrisma.applicant.update({ where: { id: entityId }, data: { currentWorkflowStageId: nextStage?.id ?? currentStageId } }); // @tenant-reviewed: phase220-excluded-mutation
    }

    // @tenant-reviewed: phase230-audit-log-pilot
    await this.tenantAuditLog.write({
      userId: actorId,
      action: 'WORKFLOW_STAGE_AUTO_COMPLETE',
      entity: entityType === 'EMPLOYEE' ? 'Employee' : 'Applicant',
      entityId,
      changes: { completedStageId: currentStageId, nextStageId: nextStage?.id ?? null },
    });
  }
}
