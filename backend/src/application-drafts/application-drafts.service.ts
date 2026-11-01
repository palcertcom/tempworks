import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { ApplicantsService } from '../applicants/applicants.service';
import { SaveDraftDto } from './dto/save-draft.dto';
import { SubmitDraftDto } from './dto/submit-draft.dto';

interface DraftDoc {
  id: string;
  name: string;
  typeName: string;
  /** Slot key on the form (e.g. 'required:Passport', 'euVisa'). The
   *  front-end uses it to re-seat the saved file into the correct
   *  slot on resume. */
  sectionKey?: string;
  url: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: string;
}

/**
 * Save-for-later drafts on the applicant creation form.
 *
 * Invariants:
 *  • Exactly one draft per user — enforced by a UNIQUE constraint on
 *    application_drafts.createdById.
 *  • No Applicant row exists while a draft is open. The Lead is
 *    created only by submitMine(), which then deletes the draft.
 *  • Uploaded photo + supporting documents are persisted against the
 *    draft row so they survive across sessions. They're copied onto
 *    the Applicant when the draft is submitted, and wiped (storage +
 *    row) when the draft is discarded.
 */
@Injectable()
export class ApplicationDraftsService {
  private readonly logger = new Logger(ApplicationDraftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly applicants: ApplicantsService,
    private readonly storage: StorageService,
  ) {}

  async getMine(userId: string) {
    const draft = await (this.prisma as any).applicationDraft.findUnique({
      where: { createdById: userId },
    });
    return draft ?? null;
  }

  async saveMine(userId: string, dto: SaveDraftDto) {
    return (this.prisma as any).applicationDraft.upsert({
      where: { createdById: userId },
      create: {
        createdById: userId,
        jobAdId: dto.jobAdId ?? null,
        formData: (dto.formData ?? {}) as any,
      },
      update: {
        jobAdId: dto.jobAdId ?? null,
        formData: (dto.formData ?? {}) as any,
      },
    });
  }

  async deleteMine(userId: string) {
    const draft = await this.getMine(userId);
    if (!draft) return { message: 'No draft to discard' };
    await this.purgeDraftFiles(draft);
    await (this.prisma as any).applicationDraft.deleteMany({
      where: { id: draft.id },
    });
    return { message: 'Draft discarded' };
  }

  /**
   * Upsert an open draft for this user and return it. Used by the
   * photo + document upload endpoints: they need a draft row to
   * attach files to, but the user may not have explicitly saved yet.
   */
  private async ensureDraft(userId: string) {
    const existing = await this.getMine(userId);
    if (existing) return existing;
    return (this.prisma as any).applicationDraft.create({
      data: { createdById: userId },
    });
  }

  /** Upload the draft profile photo to Spaces and persist its URL.
   *  Replaces any previous photo (best-effort delete). */
  async uploadPhoto(userId: string, file: Express.Multer.File) {
    const draft = await this.ensureDraft(userId);

    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `application-drafts/${draft.id}/photo`,
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: true,
    });

    if (draft.photoUrl && draft.photoUrl !== upload.url) {
      await this.storage.deleteFileByUrlOrKey(draft.photoUrl);
    }

    return (this.prisma as any).applicationDraft.update({
      where: { id: draft.id },
      data: { photoUrl: upload.url },
    });
  }

  async deletePhoto(userId: string) {
    const draft = await this.getMine(userId);
    if (!draft) throw new NotFoundException('No open draft');
    if (!draft.photoUrl) return draft;
    await this.storage.deleteFileByUrlOrKey(draft.photoUrl);
    return (this.prisma as any).applicationDraft.update({
      where: { id: draft.id },
      data: { photoUrl: null },
    });
  }

  /** Upload a supporting document and append an entry to draft.documents. */
  async uploadDocument(
    userId: string,
    file: Express.Multer.File,
    name: string,
    typeName: string,
    sectionKey?: string,
  ) {
    const draft = await this.ensureDraft(userId);

    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `application-drafts/${draft.id}/docs`,
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),
    });

    const id = randomUUID();
    const entry: DraftDoc = {
      id,
      name: name || file.originalname,
      typeName: typeName || 'Other',
      sectionKey,
      url: upload.url,
      mimeType: file.mimetype,
      fileSize: file.size,
      uploadedAt: new Date().toISOString(),
    };

    // If the caller uploads into a slot they already used, replace
    // the previous entry rather than stacking duplicates.
    const current: DraftDoc[] = Array.isArray(draft.documents) ? draft.documents : [];
    const kept = sectionKey
      ? current.filter(d => d.sectionKey !== sectionKey)
      : current;
    if (sectionKey) {
      const replaced = current.find(d => d.sectionKey === sectionKey);
      if (replaced) await this.storage.deleteFileByUrlOrKey(replaced.url);
    }

    return (this.prisma as any).applicationDraft.update({
      where: { id: draft.id },
      data: { documents: [...kept, entry] as any },
    });
  }

  async deleteDocument(userId: string, docId: string) {
    const draft = await this.getMine(userId);
    if (!draft) throw new NotFoundException('No open draft');
    const current: DraftDoc[] = Array.isArray(draft.documents) ? draft.documents : [];
    const target = current.find(d => d.id === docId);
    if (!target) throw new NotFoundException('Document not found on draft');
    await this.storage.deleteFileByUrlOrKey(target.url);
    return (this.prisma as any).applicationDraft.update({
      where: { id: draft.id },
      data: { documents: current.filter(d => d.id !== docId) as any },
    });
  }

  /**
   * Final submit. Persists the latest snapshot, creates the Applicant
   * via the shared service, transfers photo + documents onto the new
   * record, then deletes the draft row. Files stay in storage and are
   * now referenced by the Applicant + Documents records.
   */
  async submitMine(
    user: { id: string; role: string; agencyId?: string; agencyIsSystem?: boolean },
    dto: SubmitDraftDto,
  ) {
    await this.saveMine(user.id, { formData: dto.applicationData, jobAdId: (dto as any).jobAdId });
    const draft = await this.getMine(user.id);

    const { applicationData: _ignore, ...createPayload } = dto as any;
    const applicant = await this.applicants.create(
      { ...createPayload, applicationData: dto.applicationData } as any,
      user.id,
      { role: user.role, agencyId: user.agencyId, agencyIsSystem: user.agencyIsSystem },
    );

    if (draft) {
      // Carry forward the photo onto the applicant row.
      if (draft.photoUrl) {
        try {
          await (this.prisma as any).applicant.update({
            where: { id: applicant.id },
            data: { photoUrl: draft.photoUrl },
          });
          (applicant as any).photoUrl = draft.photoUrl;
        } catch { /* best effort */ }
      }

      // Materialise each draft-uploaded file as a Document row pointing
      // at the same storage URL. Resolve a DocumentType by name, with a
      // generous matching strategy so localized UI labels don't fall
      // through the cracks (the InlineDocUpload widget passes the i18n
      // string in `typeName` — e.g. "رفع رخصة القيادة"). Falls back to
      // "Other", auto-creating that row if it doesn't exist on this
      // tenant so the migration never silently drops files.
      const docs: DraftDoc[] = Array.isArray(draft.documents) ? draft.documents : [];
      if (docs.length > 0) {
        const fallback = await this.resolveOrCreateOtherType();

        // Hints: section keys → canonical DocumentType names.
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

        let migrated = 0;
        let skipped = 0;
        for (const d of docs) {
          try {
            const sectionHint = d.sectionKey?.startsWith('required:')
              ? d.sectionKey.slice('required:'.length)
              : sectionToTypeName[d.sectionKey ?? ''];

            const candidates = [d.typeName, sectionHint].filter(Boolean) as string[];

            let docType: any = null;
            for (const candidate of candidates) {
              docType = await (this.prisma as any).documentType.findFirst({
                where: { name: { equals: candidate, mode: 'insensitive' } },
              });
              if (docType) break;
            }
            if (!docType) docType = fallback;
            if (!docType) {
              this.logger.warn(`submitMine: no DocumentType resolvable for draft doc id=${d.id} typeName="${d.typeName}" — skipping.`);
              skipped++;
              continue;
            }

            await (this.prisma as any).document.create({
              data: {
                name: d.name,
                documentTypeId: docType.id,
                entityType: 'APPLICANT',
                entityId: applicant.id,
                fileUrl: d.url,
                mimeType: d.mimeType ?? 'application/octet-stream',
                fileSize: d.fileSize ?? 0,
                status: 'PENDING',
                uploadedById: user.id,
              },
            });
            migrated++;
          } catch (err: any) {
            // Don't let one bad row block the rest — but actually log
            // it so production failures are diagnosable.
            this.logger.error(
              `submitMine: failed to materialise draft doc id=${d.id} typeName="${d.typeName}": ${err?.message ?? err}`,
              err?.stack,
            );
            skipped++;
          }
        }
        this.logger.log(`submitMine: applicant=${applicant.id} migrated=${migrated} skipped=${skipped} total=${docs.length}`);
      }

      await (this.prisma as any).applicationDraft.deleteMany({
        where: { createdById: user.id },
      });
    }

    return applicant;
  }

  /** Convenience for the controller `GET mine/required` probe. */
  async requireMine(userId: string) {
    const draft = await this.getMine(userId);
    if (!draft) throw new NotFoundException('No open draft');
    return draft;
  }

  /**
   * Wipe every file uploaded for a discarded draft. Tries a single
   * prefix-delete first (fast on Spaces, recursive on local). If the
   * driver doesn't support prefix deletes, falls back to per-URL
   * deletes harvested from the draft row.
   */
  private async purgeDraftFiles(draft: { id: string; photoUrl?: string | null; documents?: any }) {
    await this.storage.deleteByPrefix(`application-drafts/${draft.id}`);
    // Defensive cleanup of legacy URLs that may have been written before
    // the Spaces migration (e.g. /uploads/drafts/<id>/...).
    if (draft.photoUrl) await this.storage.deleteFileByUrlOrKey(draft.photoUrl);
    const docs: DraftDoc[] = Array.isArray(draft.documents) ? draft.documents : [];
    for (const d of docs) await this.storage.deleteFileByUrlOrKey(d.url);
  }

  /**
   * Find the catch-all "Other" DocumentType, creating it if missing so
   * draft-document migration never silently drops a file just because
   * the seed didn't run on this tenant.
   */
  private async resolveOrCreateOtherType(): Promise<any> {
    try {
      const existing = await (this.prisma as any).documentType.findFirst({
        where: { name: { equals: 'Other', mode: 'insensitive' } },
      });
      if (existing) return existing;
      return await (this.prisma as any).documentType.create({
        data: {
          name: 'Other',
          category: 'OTHER',
          isActive: true,
        },
      });
    } catch (err: any) {
      this.logger.warn(`resolveOrCreateOtherType: ${err?.message ?? err}`);
      return null;
    }
  }
}
