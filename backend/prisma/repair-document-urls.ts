/**
 * Repair malformed document/photo URLs in the database.
 *
 * Background:
 *   An older bug on the frontend persisted "${API_BASE}${absoluteUrl}"
 *   into the DB instead of just the absolute Spaces URL — producing
 *   values like:
 *     "https://whale-app-…ondigitalocean.apphttps://tempworks-uploads.…/foo.jpg"
 *
 *   The frontend renderer was patched to strip the doubled prefix at
 *   read time, but new readers (PDF exports, email templates, audit
 *   exports) might still see the corrupted DB value. This script does
 *   a one-time cleanup so the DB matches what the storage actually has.
 *
 * What it touches:
 *   - documents.fileUrl
 *   - users.photoUrl
 *   - applicants.photoUrl
 *   - employees.photoUrl
 *
 * Logic:
 *   For any value matching /https?:\/\/.+?https?:\/\//, slice from the
 *   second "http" onwards — that leaves only the original absolute URL.
 *
 * Run:
 *   npm run db:repair:doc-urls
 *
 * Idempotent — re-running on a clean DB is a no-op (regex won't match).
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

const DOUBLED_PREFIX = /https?:\/\/.+?(https?:\/\/)/;

function repair(url: string | null | undefined): string | null {
  if (!url) return null;
  if (DOUBLED_PREFIX.test(url)) {
    return url.slice(url.indexOf('http', 1));
  }
  return null; // null === "no change needed"
}

async function repairTable<T extends { id: string }>(
  label: string,
  fetcher: () => Promise<Array<T & Record<string, any>>>,
  field: string,
  updater: (id: string, value: string) => Promise<unknown>,
): Promise<void> {
  const rows = await fetcher();
  let updated = 0;
  for (const row of rows) {
    const fixed = repair(row[field]);
    if (fixed && fixed !== row[field]) {
      try {
        await updater(row.id, fixed);
        updated++;
      } catch (err: any) {
        console.error(`   ⚠️  ${label}#${row.id}:`, err?.message ?? err);
      }
    }
  }
  console.log(`✅  ${label}: scanned=${rows.length} repaired=${updated}`);
}

async function main(): Promise<void> {
  console.log('🔍  Scanning for malformed asset URLs…');

  await repairTable(
    'documents.fileUrl',
    () => prisma.document.findMany({ where: { fileUrl: { contains: 'httphttp' } }, select: { id: true, fileUrl: true } as any }) as any,
    'fileUrl',
    (id, value) => prisma.document.update({ where: { id }, data: { fileUrl: value } }),
  );

  // Use raw filter for the `https?://...https?://` pattern via contains on
  // the safest substring marker: any URL with two "://" separated by a
  // host segment will contain "://" twice. We narrow to those then re-filter
  // in JS via the regex.
  const dblFilter = { contains: '://' };

  await repairTable(
    'documents.fileUrl (deep scan)',
    async () => {
      const rows = await prisma.document.findMany({
        where: { fileUrl: dblFilter },
        select: { id: true, fileUrl: true } as any,
      });
      return (rows as any[]).filter(r => DOUBLED_PREFIX.test(r.fileUrl ?? ''));
    },
    'fileUrl',
    (id, value) => prisma.document.update({ where: { id }, data: { fileUrl: value } }),
  );

  await repairTable(
    'users.photoUrl',
    async () => {
      const rows = await prisma.user.findMany({
        where: { photoUrl: dblFilter },
        select: { id: true, photoUrl: true } as any,
      });
      return (rows as any[]).filter(r => DOUBLED_PREFIX.test(r.photoUrl ?? ''));
    },
    'photoUrl',
    (id, value) => prisma.user.update({ where: { id }, data: { photoUrl: value } }),
  );

  await repairTable(
    'applicants.photoUrl',
    async () => {
      const rows = await prisma.applicant.findMany({
        where: { photoUrl: dblFilter },
        select: { id: true, photoUrl: true } as any,
      });
      return (rows as any[]).filter(r => DOUBLED_PREFIX.test(r.photoUrl ?? ''));
    },
    'photoUrl',
    (id, value) => prisma.applicant.update({ where: { id }, data: { photoUrl: value } }),
  );

  await repairTable(
    'employees.photoUrl',
    async () => {
      const rows = await prisma.employee.findMany({
        where: { photoUrl: dblFilter },
        select: { id: true, photoUrl: true } as any,
      });
      return (rows as any[]).filter(r => DOUBLED_PREFIX.test(r.photoUrl ?? ''));
    },
    'photoUrl',
    (id, value) => prisma.employee.update({ where: { id }, data: { photoUrl: value } }),
  );

  console.log('✅  Repair complete.');
}

main()
  .catch((err) => {
    console.error('❌  Repair failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
