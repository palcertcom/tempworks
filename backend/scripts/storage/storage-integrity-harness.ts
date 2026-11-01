/**
 * storage-integrity-harness.ts — StorageService guarantees that backups rely on:
 *
 *   write-once keys   an existing key is never overwritten (ConflictException)
 *   deferred deletes  with a database, deletes are QUEUED (object stays) so a
 *                     running backup never loses an object its snapshot references
 *   compatibility     without a database (scripts/harnesses) or with
 *                     STORAGE_DEFERRED_DELETE=off, deletes stay immediate;
 *                     a queue failure falls back to an immediate delete
 *
 * Local driver always runs. The S3 path runs when S3_TEST_ENDPOINT is set
 * (e.g. a local s3rver: S3_TEST_ENDPOINT=http://127.0.0.1:5555 S3_TEST_BUCKET=...).
 *
 *   npx ts-node --transpile-only scripts/storage/storage-integrity-harness.ts
 */
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StorageService } from '../../src/common/storage/storage.service';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log(`  ✓ ${m}`); pass++; };
const no = (m: string) => { console.log(`  ✗ ${m}`); fail++; };
const expect = (c: boolean, m: string) => (c ? ok(m) : no(m));

/** Minimal PrismaService stand-in: records purge-queue inserts. */
function stubPrisma(opts: { throwOnInsert?: boolean } = {}) {
  const inserts: any[][] = [];
  return {
    inserts,
    $executeRawUnsafe: async (sql: string, ...args: any[]) => {
      if (opts.throwOnInsert) throw new Error('relation "storage_purge_queue" does not exist');
      if (/INSERT INTO "storage_purge_queue"/.test(sql)) inserts.push(args);
      return 1;
    },
  } as any;
}

function mk(driver: 'local' | 'spaces', prisma?: any): StorageService {
  process.env.UPLOAD_STORAGE_DRIVER = driver;
  const s = new StorageService(prisma);
  s.onModuleInit();
  return s;
}

async function rejectsConflict(p: Promise<unknown>): Promise<boolean> {
  try { await p; return false; } catch (e: any) { return e?.response?.code === 'STORAGE.KEY_EXISTS'; }
}

async function local() {
  console.log('== local driver ==');
  process.env.UPLOAD_DEST = mkdtempSync(join(tmpdir(), 'storage-harness-'));
  const root = process.env.UPLOAD_DEST;
  const s = mk('local');

  const a = await s.uploadFile(Buffer.from('original'), { keyPrefix: 'documents', contentType: 'application/pdf', originalName: 'a.pdf', filename: 'fixed.pdf' });
  expect(await rejectsConflict(s.uploadFile(Buffer.from('REPLACED'), { keyPrefix: 'documents', contentType: 'application/pdf', originalName: 'a.pdf', filename: 'fixed.pdf' })),
    'second write to an existing key is refused (STORAGE.KEY_EXISTS)');
  expect(readFileSync(join(root, a.key), 'utf8') === 'original', 'original bytes unchanged after the refused overwrite');
  const k1 = await s.uploadFile(Buffer.from('x'), { keyPrefix: 'documents', contentType: 'application/pdf', originalName: 'b.pdf' });
  const k2 = await s.uploadFile(Buffer.from('x'), { keyPrefix: 'documents', contentType: 'application/pdf', originalName: 'b.pdf' });
  expect(k1.key !== k2.key, 'normal uploads always get a fresh key');

  // Deferred delete with a database: queued, object stays.
  const prisma = stubPrisma();
  const sd = mk('local', prisma);
  await sd.deleteFileByUrlOrKey(k1.key);
  expect(prisma.inserts.length === 1 && prisma.inserts[0][1] === k1.key, 'delete is QUEUED (purge queue insert recorded)');
  expect(existsSync(join(root, k1.key)), 'queued object is still present (a running backup can capture it)');
  await sd.deleteByPrefix('documents');
  // documents/ now holds exactly 3 objects: fixed.pdf, k1 (queued, still present), k2.
  expect(prisma.inserts.length === 1 + 3, `prefix delete queues every object under the prefix (${prisma.inserts.length - 1} of 3 queued)`);
  expect(existsSync(join(root, a.key)) && existsSync(join(root, k2.key)), 'prefix-queued objects are still present');

  // Explicit opt-out and no-database construction keep immediate deletes.
  process.env.STORAGE_DEFERRED_DELETE = 'off';
  await mk('local', stubPrisma()).deleteFileByUrlOrKey(k2.key);
  expect(!existsSync(join(root, k2.key)), 'STORAGE_DEFERRED_DELETE=off deletes immediately');
  delete process.env.STORAGE_DEFERRED_DELETE;
  await mk('local').deleteFileByUrlOrKey(a.key);
  expect(!existsSync(join(root, a.key)), 'without a database (harness construction) deletes immediately');

  // Queue unavailable → fall back to immediate delete rather than leaking.
  const k3 = await s.uploadFile(Buffer.from('y'), { keyPrefix: 'documents', contentType: 'application/pdf', originalName: 'c.pdf' });
  await mk('local', stubPrisma({ throwOnInsert: true })).deleteFileByUrlOrKey(k3.key);
  expect(!existsSync(join(root, k3.key)), 'queue failure falls back to an immediate delete');
}

async function spaces() {
  if (!process.env.S3_TEST_ENDPOINT) { console.log('== S3 path skipped (set S3_TEST_ENDPOINT) =='); return; }
  console.log(`== S3 path (${process.env.S3_TEST_ENDPOINT}) ==`);
  const bucket = process.env.S3_TEST_BUCKET || 'src-uploads';
  Object.assign(process.env, {
    DO_SPACES_ENDPOINT: process.env.S3_TEST_ENDPOINT, DO_SPACES_REGION: 'us-east-1', DO_SPACES_BUCKET: bucket,
    DO_SPACES_ACCESS_KEY: process.env.S3_TEST_KEY || 'S3RVER', DO_SPACES_SECRET_KEY: process.env.S3_TEST_SECRET || 'S3RVER',
    DO_SPACES_PUBLIC_URL: `${process.env.S3_TEST_ENDPOINT}/${bucket}`, DO_SPACES_FORCE_PATH_STYLE: '1',
  });
  const s = mk('spaces');
  const name = `harness-${Date.now()}.pdf`;
  const a = await s.uploadFile(Buffer.from('original'), { keyPrefix: 'harness', contentType: 'application/pdf', originalName: 'a.pdf', filename: name });
  expect(await rejectsConflict(s.uploadFile(Buffer.from('REPLACED'), { keyPrefix: 'harness', contentType: 'application/pdf', originalName: 'a.pdf', filename: name })),
    'S3: second write to an existing key is refused');
  const body = await (await fetch(a.url)).text();
  expect(body === 'original', 'S3: original object bytes unchanged');
  const prisma = stubPrisma();
  await mk('spaces', prisma).deleteFileByUrlOrKey(a.url);
  expect(prisma.inserts.length === 1 && (await s.objectExists(a.key)), 'S3: delete queued, object still present');
  await mk('spaces').deleteFileByUrlOrKey(a.url);
  expect(!(await s.objectExists(a.key)), 'S3: immediate delete (no database) removes the object');
}

(async () => {
  await local();
  await spaces();
  console.log(`\nSTORAGE INTEGRITY: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
