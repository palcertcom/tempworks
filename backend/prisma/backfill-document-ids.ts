/**
 * Backfill business document IDs (`docId`) for legacy Document rows
 * created before the DocumentIdService was wired in.
 *
 * Format mirrors document-id.service.ts exactly:
 *
 *   DOC{PersonNumber}{TypeCode}{SEQ:3}{Timestamp}
 *
 *   PersonNumber:
 *     APPLICANT → candidateNumber ?? leadNumber ?? first-8-of-UUID
 *     EMPLOYEE  → employeeNumber             ?? first-8-of-UUID
 *     Other     → first-8-of-UUID (uppercased)
 *
 *   TypeCode: DocumentType.code ?? first-4-of-name, uppercased, only [A-Z0-9].
 *
 *   SEQ: per-(entityId, documentTypeId) running counter, starting from
 *        1 and skipping over docIds already in use so re-runs are
 *        idempotent.
 *
 *   Timestamp: original row `createdAt` in ms since epoch (not Date.now())
 *              so backfilled IDs are deterministic and re-runs of the
 *              same row would produce the same value.
 *
 * Run with:
 *   npx ts-node prisma/backfill-document-ids.ts
 *
 * Or from the backend directory:
 *   npm run db:backfill:doc-ids
 *
 * Idempotent — only touches rows with docId IS NULL.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { resolvePoolSsl } from './pg-ssl';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: resolvePoolSsl(DATABASE_URL) });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter } as any);

function fallback(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function clean(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

async function resolvePersonNumber(entityId: string, entityType: string): Promise<string> {
  const fb = fallback(entityId);
  try {
    if (entityType === 'APPLICANT') {
      const a = await prisma.applicant.findUnique({
        where: { id: entityId },
        select: { candidateNumber: true, leadNumber: true },
      });
      const raw = a?.candidateNumber ?? a?.leadNumber ?? fb;
      return clean(raw) || fb;
    }
    if (entityType === 'EMPLOYEE') {
      const e = await prisma.employee.findUnique({
        where: { id: entityId },
        select: { employeeNumber: true },
      });
      const raw = e?.employeeNumber ?? fb;
      return clean(raw) || fb;
    }
  } catch {
    // fall through
  }
  return fb;
}

async function resolveTypeCode(documentTypeId: string): Promise<string> {
  try {
    const dt = await prisma.documentType.findUnique({
      where: { id: documentTypeId },
      select: { code: true, name: true },
    });
    if (!dt) return 'DOC';
    const raw = dt.code ?? dt.name?.slice(0, 4) ?? 'DOC';
    return clean(raw).slice(0, 6) || 'DOC';
  } catch {
    return 'DOC';
  }
}

async function main(): Promise<void> {
  console.log('🔍  Scanning for documents missing docId…');

  const missing = await prisma.document.findMany({
    where: { docId: null, deletedAt: null },
    select: { id: true, entityId: true, entityType: true, documentTypeId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`   Found ${missing.length} document(s) without a docId.`);
  if (missing.length === 0) {
    console.log('✅  Nothing to do.');
    return;
  }

  // Group by (entityId, documentTypeId) so the SEQ counter is computed
  // once per group and incremented locally.
  type Key = string;
  const groups = new Map<Key, typeof missing>();
  for (const d of missing) {
    const key = `${d.entityId}::${d.documentTypeId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  let updated = 0;
  let skipped = 0;

  for (const [key, docs] of groups) {
    const [entityId, documentTypeId] = key.split('::');
    const entityType = docs[0].entityType;

    const [personNumber, typeCode] = await Promise.all([
      resolvePersonNumber(entityId, entityType),
      resolveTypeCode(documentTypeId),
    ]);

    // Existing (already-assigned) docIds in this group — start the
    // SEQ above the highest one so we don't collide.
    const existing = await prisma.document.count({
      where: { entityId, documentTypeId, docId: { not: null }, deletedAt: null },
    });

    let seq = existing + 1;
    for (const doc of docs) {
      const ts = String(new Date(doc.createdAt).getTime());
      // Find the next free SEQ — Postgres' unique index on docId is
      // the source of truth, but we precompute to minimise wasted writes.
      let candidate = `DOC${personNumber}${typeCode}${String(seq).padStart(3, '0')}${ts}`;

      // Defensive loop in case any candidate already exists (e.g. a
      // partial earlier run).
      let attempt = 0;
      while (attempt < 1000) {
        try {
          await prisma.document.update({
            where: { id: doc.id },
            data: { docId: candidate },
          });
          updated++;
          break;
        } catch (err: any) {
          if (err?.code === 'P2002') {
            // unique-constraint violation — bump SEQ and try again.
            seq++;
            candidate = `DOC${personNumber}${typeCode}${String(seq).padStart(3, '0')}${ts}`;
            attempt++;
            continue;
          }
          console.error(`   ⚠️  Skipping ${doc.id}:`, err?.message ?? err);
          skipped++;
          break;
        }
      }
      seq++;
    }
  }

  console.log(`✅  Backfill complete. updated=${updated}, skipped=${skipped}, groups=${groups.size}.`);
}

main()
  .catch((err) => {
    console.error('❌  Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
