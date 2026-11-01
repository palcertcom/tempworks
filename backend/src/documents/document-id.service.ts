/**
 * DocumentIdService — centralised business document-ID generation.
 *
 * Format:  DOC{PersonNumber}{TypeCode}{SEQ:3}{Timestamp}
 *
 * PersonNumber:
 *   APPLICANT → candidateNumber ?? leadNumber ?? first-8-of-UUID
 *   EMPLOYEE  → employeeNumber             ?? first-8-of-UUID
 *   Other     → first-8-of-UUID (uppercased)
 *
 * TypeCode: DocumentType.code ?? first-4-of-name, uppercased, only [A-Z0-9].
 *
 * SEQ: 3-digit zero-padded count of non-deleted docs for the same
 *      (entityId, documentTypeId) pair AFTER the new record is counted.
 *
 * Timestamp: Date.now() (ms since epoch) — guarantees uniqueness even
 *            against a same-second retry after a unique-index collision.
 *
 * Concurrency: the generation runs inside the Prisma $transaction that also
 * creates the Document row. If two concurrent requests somehow produce the
 * same prefix (e.g. both see count=0), the timestamp suffix differentiates
 * them; in the very rare case where they collide on both, Postgres' unique
 * index on `docId` will reject one and the outer service retries.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DocumentIdService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate the next business document ID for the given entity + doc type.
   * Must be called *inside* the same Prisma $transaction that creates the doc
   * so the count is accurate.
   */
  async generate(
    entityId: string,
    entityType: string,
    documentTypeId: string,
    tx?: any,          // Prisma interactive-transaction client
  ): Promise<string> {
    const client = tx ?? this.prisma;

    const [personNumber, typeCode, existingCount] = await Promise.all([
      this.resolvePersonNumber(entityId, entityType, client),
      this.resolveTypeCode(documentTypeId, client),
      client.document.count({
        where: { entityId, documentTypeId, deletedAt: null },
      }),
    ]);

    const seq = String(existingCount + 1).padStart(3, '0');
    const ts  = String(Date.now());
    return `DOC${personNumber}${typeCode}${seq}${ts}`;
  }

  private async resolvePersonNumber(
    entityId: string,
    entityType: string,
    client: any,
  ): Promise<string> {
    const fallback = entityId.replace(/-/g, '').slice(0, 8).toUpperCase();
    try {
      if (entityType === 'APPLICANT') {
        const a = await client.applicant.findUnique({
          where: { id: entityId },
          select: { candidateNumber: true, leadNumber: true },
        });
        const raw = a?.candidateNumber ?? a?.leadNumber ?? fallback;
        return raw.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      }
      if (entityType === 'EMPLOYEE') {
        const e = await client.employee.findUnique({
          where: { id: entityId },
          select: { employeeNumber: true },
        });
        const raw = e?.employeeNumber ?? fallback;
        return raw.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      }
    } catch {
      // fall through
    }
    return fallback;
  }

  private async resolveTypeCode(documentTypeId: string, client: any): Promise<string> {
    try {
      const dt = await client.documentType.findUnique({
        where: { id: documentTypeId },
        select: { code: true, name: true },
      });
      if (!dt) return 'DOC';
      const raw = dt.code ?? dt.name?.slice(0, 4) ?? 'DOC';
      return raw.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6);
    } catch {
      return 'DOC';
    }
  }
}
