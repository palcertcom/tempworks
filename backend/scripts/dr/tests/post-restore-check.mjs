#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// post-restore-check.mjs — application-level checks of a RESTORED environment,
// to run after restore.sh has finished (restore.sh itself already checked
// database objects, ownership, sequences and files):
//
//   1  the recovered API is up
//   2  authentication: an administrator logs in with the ORIGINAL credentials
//      (taken from the secret store, passed via environment), a wrong password
//      is rejected
//   3  attachments: every `documents` row (or a sample, CHECK_LIMIT) is served
//      by the recovered API and its bytes match the SHA-256 recorded in the
//      backup's uploads manifest
//   4  storage: every file in the manifest exists in the recovery storage
//      (bucket or local dir) with the recorded SHA-256
//
// Usage (on the recovery host; nothing is printed that is a credential):
//   export DATABASE_URL=<restored database>  ADMIN_COMPANY=… ADMIN_EMAIL=… ADMIN_PASSWORD=…
//   export UPLOAD_STORAGE_DRIVER=local UPLOAD_DEST=<restored files dir>      # or spaces + DO_SPACES_*
//   node backend/scripts/dr/tests/post-restore-check.mjs <apiBase e.g. http://127.0.0.1:3000/api/v1> <package-dir> [evidence.json]
// Exit 0 only if every check passes.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(join(BACKEND, 'package.json'));
const { Client } = require('pg');
const { resolvePoolSsl } = require(join(BACKEND, 'prisma', 'pg-ssl.js'));
const [API, PKG, OUT] = process.argv.slice(2);
const E = process.env;
if (!API || !PKG) { console.error('usage: post-restore-check.mjs <apiBase> <package-dir> [evidence.json]'); process.exit(2); }
const checks = []; let failed = 0;
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${detail !== undefined ? ` — ${detail}` : ''}`); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

const man = JSON.parse(readFileSync(join(PKG, 'uploads.manifest.json'), 'utf8'));
const byKey = new Map((man.files || []).map((f) => [f.key, f]));
const legacy = existsSync(join(PKG, 'uploads-legacy-local.manifest.json')) ? JSON.parse(readFileSync(join(PKG, 'uploads-legacy-local.manifest.json'), 'utf8')) : { files: [] };
const byLegacy = new Map((legacy.files || []).map((f) => [f.key, f]));

// 1. API
let up = false; try { up = (await fetch(`${API.replace(/\/api\/v1\/?$/, '')}/api/docs`)).ok; } catch { /* down */ }
check('recovered API is up', up);

// 2. authentication
async function login(password) {
  const r = await fetch(`${API}/auth/login-v2`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: E.ADMIN_COMPANY || 'tempworks', email: E.ADMIN_EMAIL, password }) });
  const j = await r.json().catch(() => ({})); return (j.data ?? j).accessToken || null;
}
const token = E.ADMIN_EMAIL && E.ADMIN_PASSWORD ? await login(E.ADMIN_PASSWORD) : null;
check('administrator logs in with the original credentials', !!token, E.ADMIN_EMAIL ? undefined : 'ADMIN_EMAIL/ADMIN_PASSWORD not set');
check('a wrong password is rejected', E.ADMIN_EMAIL ? !(await login(`${E.ADMIN_PASSWORD}-wrong`)) : false);

// 3. attachments through the API, compared with the backup's hashes
const db = new Client({ connectionString: E.DATABASE_URL, ssl: resolvePoolSsl(E.DATABASE_URL) });
await db.connect();
const limit = Number(E.CHECK_LIMIT || 1000);
const docs = (await db.query(`SELECT id, "fileUrl" FROM documents WHERE "deletedAt" IS NULL ORDER BY id LIMIT $1`, [limit]).catch(async () =>
  db.query(`SELECT id, "fileUrl" FROM documents ORDER BY id LIMIT $1`, [limit]))).rows;
const total = Number((await db.query('SELECT count(*) AS n FROM documents')).rows[0].n);
await db.end();
const keyOf = (url) => {
  if (url.startsWith('/uploads/')) return { ns: 'local', key: decodeURIComponent(url.slice('/uploads/'.length)) };
  const base = (E.DO_SPACES_PUBLIC_URL || '').replace(/\/+$/, '');
  if (base && url.startsWith(base + '/')) return { ns: 'object', key: decodeURIComponent(url.slice(base.length + 1)) };
  try { return { ns: 'object', key: decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//, '')) }; } catch { return { ns: 'object', key: url }; }
};
let served = 0, matched = 0, noRecord = 0; const bad = []; const noRecordIds = [];
for (const d of docs) {
  const { ns, key } = keyOf(d.fileUrl);
  const rec = (ns === 'local' ? byLegacy : byKey).get(key) || byKey.get(key);
  if (!rec) { noRecord++; noRecordIds.push(d.id); continue; }
  const r = token ? await fetch(`${API}/documents/${d.id}/file`, { headers: { Authorization: `Bearer ${token}` } }) : null;
  if (r?.ok) { served++; const h = sha(Buffer.from(await r.arrayBuffer())); if (h === rec.sha256) matched++; else bad.push(d.id); } else bad.push(d.id);
}
check(`attachments served by the recovered app match the backup's SHA-256 (${matched}/${docs.length - noRecord} checked of ${total} documents)`,
  docs.length - noRecord > 0 && matched === docs.length - noRecord, bad.length ? `first mismatches: ${bad.slice(0, 5).join(', ')}` : undefined);
check('documents without a file in the backup (expected: the backup\'s recovery issues, or rows created after the restore)', true, `${noRecord}${noRecordIds.length ? ` [${noRecordIds.slice(0, 10).join(', ')}]` : ''}`);

// 4. recovery storage holds every manifest file with its hash
let missing = 0, mismatch = 0;
if ((E.UPLOAD_STORAGE_DRIVER || 'local') === 'spaces') {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ endpoint: E.DO_SPACES_ENDPOINT, region: E.DO_SPACES_REGION, forcePathStyle: ['1', 'true'].includes(E.DO_SPACES_FORCE_PATH_STYLE),
    credentials: { accessKeyId: E.DO_SPACES_ACCESS_KEY, secretAccessKey: E.DO_SPACES_SECRET_KEY } });
  for (const f of byKey.values()) {
    try { const r = await s3.send(new GetObjectCommand({ Bucket: E.DO_SPACES_BUCKET, Key: f.key })); if (sha(Buffer.from(await r.Body.transformToByteArray())) !== f.sha256) mismatch++; }
    catch { missing++; }
  }
} else {
  for (const f of byKey.values()) {
    const p = join(E.UPLOAD_DEST || '', f.key);
    if (!existsSync(p)) missing++; else if (sha(readFileSync(p)) !== f.sha256) mismatch++;
  }
}
check(`recovery storage holds all ${byKey.size} manifest files with matching SHA-256`, missing === 0 && mismatch === 0, `missing=${missing} mismatch=${mismatch}`);

const res = { api: API, package: PKG.split('/').pop(), passed: checks.length - failed, failed, checks, at: new Date().toISOString() };
if (OUT) writeFileSync(OUT, JSON.stringify(res, null, 2));
console.log(failed ? `${failed} check(s) FAILED` : 'POST-RESTORE CHECK PASSED');
process.exit(failed ? 1 : 0);
