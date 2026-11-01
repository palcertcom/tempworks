import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { decodeUploadFilename } from '../common/storage/multer.config';
import {
  CreateProfileNoteDto, UpdateProfileNoteDto,
  NoteOwner, NoteCategory, NotePriority, NoteStatus,
} from './dto/profile-note.dto';

interface Caller {
  id?: string;
  tenantId?: string | null;
  agencyIsSystem?: boolean;
}

const noteInclude = {
  createdBy: { select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } } },
  updatedBy: { select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } } },
  attachments: { orderBy: { createdAt: 'asc' as const } },
};

@Injectable()
export class ProfileNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Resolve the tenantId of an Employee / Applicant / Candidate. Notes
   * inherit tenancy from the owning entity. Returns null when the entity
   * has no tenant stamped (legacy data).
   */
  private async resolveEntityTenantId(ownerType: NoteOwner, ownerId: string): Promise<string | null> {
    if (ownerType === 'EMPLOYEE') {
      const e: any = await this.prisma.employee.findUnique({ where: { id: ownerId }, select: { tenantId: true } });
      if (!e) throw new NotFoundException('Employee not found');
      return e.tenantId ?? null;
    }
    // Both APPLICANT and CANDIDATE live in the same Applicant table.
    const a: any = await this.prisma.applicant.findUnique({ where: { id: ownerId }, select: { tenantId: true } });
    if (!a) throw new NotFoundException(`${ownerType.toLowerCase()} not found`);
    return a.tenantId ?? null;
  }

  /** SUPER bypasses; non-SUPER must match entity tenant (or entity has no tenant). */
  private assertCanReachEntity(caller: Caller | undefined, entityTenantId: string | null): void {
    if (caller?.agencyIsSystem === true) return;
    const callerTenantId = (caller?.tenantId ?? '').toString().trim() || null;
    if (entityTenantId && callerTenantId && entityTenantId !== callerTenantId) {
      throw new ForbiddenException('Not authorised for this profile');
    }
  }

  async listByOwner(ownerType: NoteOwner, ownerId: string, caller?: Caller) {
    const tenantId = await this.resolveEntityTenantId(ownerType, ownerId);
    this.assertCanReachEntity(caller, tenantId);
    return (this.prisma as any).profileNote.findMany({
      where: { ownerType, ownerId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: noteInclude,
    });
  }

  async create(dto: CreateProfileNoteDto, caller: Caller) {
    if (!caller?.id) throw new ForbiddenException('Authentication required');
    const entityTenantId = await this.resolveEntityTenantId(dto.ownerType, dto.ownerId);
    this.assertCanReachEntity(caller, entityTenantId);
    return (this.prisma as any).profileNote.create({
      data: {
        ownerType: dto.ownerType,
        ownerId:   dto.ownerId,
        text:      dto.text,
        category:  dto.category ?? 'GENERAL',
        priority:  dto.priority ?? 'MEDIUM',
        status:    dto.status   ?? 'OPEN',
        tenantId:  entityTenantId ?? caller.tenantId ?? null,
        createdById: caller.id,
      },
      include: noteInclude,
    });
  }

  async update(id: string, dto: UpdateProfileNoteDto, caller: Caller) {
    if (!caller?.id) throw new ForbiddenException('Authentication required');
    const existing: any = await (this.prisma as any).profileNote.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Note not found');
    const entityTenantId = await this.resolveEntityTenantId(existing.ownerType, existing.ownerId);
    this.assertCanReachEntity(caller, entityTenantId);
    return (this.prisma as any).profileNote.update({
      where: { id },
      data: {
        ...(dto.text     !== undefined ? { text: dto.text }         : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.status   !== undefined ? { status: dto.status }     : {}),
        updatedById: caller.id,
      },
      include: noteInclude,
    });
  }

  async remove(id: string, caller: Caller) {
    if (!caller?.id) throw new ForbiddenException('Authentication required');
    const existing: any = await (this.prisma as any).profileNote.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Note not found');
    const entityTenantId = await this.resolveEntityTenantId(existing.ownerType, existing.ownerId);
    this.assertCanReachEntity(caller, entityTenantId);
    await (this.prisma as any).profileNote.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async addAttachment(
    noteId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    caller: Caller,
  ) {
    const note: any = await (this.prisma as any).profileNote.findFirst({
      where: { id: noteId, deletedAt: null },
    });
    if (!note) throw new NotFoundException('Note not found');
    const entityTenantId = await this.resolveEntityTenantId(note.ownerType, note.ownerId);
    this.assertCanReachEntity(caller, entityTenantId);
    const displayName = decodeUploadFilename(file.originalname);
    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `profile-notes/${note.ownerType}/${note.ownerId}`,
      contentType: file.mimetype,
      originalName: displayName,
      inline: file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),
    });
    return (this.prisma as any).profileNoteAttachment.create({
      data: {
        noteId,
        fileUrl:  upload.url,
        fileName: displayName,
        fileSize: file.size,
        mimeType: file.mimetype,
      },
    });
  }

  async removeAttachment(attachmentId: string, caller: Caller) {
    const att: any = await (this.prisma as any).profileNoteAttachment.findUnique({
      where: { id: attachmentId },
      include: { note: true },
    });
    if (!att) throw new NotFoundException('Attachment not found');
    const entityTenantId = await this.resolveEntityTenantId(att.note.ownerType, att.note.ownerId);
    this.assertCanReachEntity(caller, entityTenantId);
    await (this.prisma as any).profileNoteAttachment.delete({ where: { id: attachmentId } });
    return { ok: true };
  }
}
