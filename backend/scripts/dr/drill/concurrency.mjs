#!/usr/bin/env node
// DB↔file consistency under CONCURRENT application writes.
//
//  A) Deterministic race: run the backup engine (same backup.sh the app uses)
//     with a test-only pause between the DB snapshot and the file capture, and
//     during that pause drive real writes through the API: a new upload, a
//     PHOTO REPLACEMENT (the app writes a new object and purges the old one),
//     a document RENEWAL, and a soft-delete. Expect the capture to detect the
//     purged object, retry, and finish consistent.
//  B) Real overlap: trigger a FULL backup through the API while a load loop
//     keeps uploading / replacing / deleting, and confirm a second backup
//     request is refused while one runs (cross-instance advisory lock).
//     Whatever the timing, the result must be either COMPLETED with zero
//     missing references, or explicitly INCOMPLETE — never a silently broken
//     "completed" backup.
//
// Usage: node concurrency.mjs <apiBase> <evidenceDir> <drillDir>
//   DRILL_ENGINE=stream → exercises scripts/dr/snapshot.sh (bucket-native
//   snapshots) instead of backup.sh; results are read back from the bucket.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [API, EV, DRILL] = process.argv.slice(2);
const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const results = {};
const fail = (m) => { console.error(`✗ ${m}`); writeFileSync(`${EV}/concurrency.json`, JSON.stringify({ ...results, error: m }, null, 2)); process.exit(1); };
const ok = (m) => console.log(`  ✓ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(readFileSync(`${EV}/source-data.json`, 'utf8'));

async function call(method, path, token, body, form) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload = form;
  if (!form && body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + path, { method, headers, body: payload });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j?.data ?? j };
}
async function login(company, email, password) {
  const r = await call('POST', '/auth/login-v2', null, { company, email, password });
  if (!r.json?.accessToken) fail(`login ${email}: ${r.status}`); return r.json.accessToken;
}
const pdf = (l) => new Blob([`%PDF-1.4\n% ${l}\n${randomBytes(400).toString('base64')}\n%%EOF\n`], { type: 'application/pdf' });
const png = () => new Blob([Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(200)])], { type: 'image/png' });
const docTypes = async (tok) => (await call('GET', '/settings/document-types', tok)).json;

async function uploadDoc(tok, empId, typeId, label) {
  const f = new FormData(); f.append('file', pdf(label), `${label}.pdf`);
  f.append('name', label); f.append('documentTypeId', typeId); f.append('entityType', 'EMPLOYEE'); f.append('entityId', empId);
  return call('POST', '/documents/upload', tok, undefined, f);
}
async function replacePhoto(tok, empId) {
  const f = new FormData(); f.append('photo', png(), 'photo.png');
  return call('PATCH', `/employees/${empId}/photo`, tok, undefined, f);
}
async function renewDoc(tok, docId, label) {
  const f = new FormData(); f.append('file', pdf(label), `${label}.pdf`); f.append('name', label);
  return call('POST', `/documents/${docId}/renew`, tok, undefined, f);
}

const hr = await login('alpha', 'hr@alpha.test', env.TENANT_USER_PASSWORD);
const admin = await login('tempworks', env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
const types = await docTypes(admin);
const typeId = types[0].id;
const alphaEmp = data.employees.find((e) => e.tenant === 'alpha');
const photoEmp = data.photos.find((p) => p.tenant === 'alpha').employeeId;
const alphaDocs = data.documents.filter((d) => d.tenant === 'alpha');

// Run backup.sh against the SOURCE with a test-only pause between the DB
// snapshot and the file capture; `during` runs inside that window.
const srcEnv = Object.fromEntries(readFileSync(join(DRILL, 'source/backend.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const STREAM = env.DRILL_ENGINE === 'stream';
const snapCat = (pkg, rel) => execFileSync('bash', [join(HERE, '..', 'snapshot.sh'), 'cat', pkg, rel], { env: { ...process.env, ...srcEnv } });
async function pausedBackup(name, during) {
  const outDir = join(DRILL, `concurrency-${name}`); rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true });
  const signal = join(outDir, 'paused.signal');
  const child = spawn('bash', STREAM ? [join(HERE, '..', 'snapshot.sh'), 'backup', '--kind', 'full'] : [join(HERE, '..', 'backup.sh'), '--kind', 'full', '--no-tar'], {
    env: { ...process.env, ...srcEnv, BACKUP_DIR: outDir, DR_TEST_PAUSE_AFTER_DUMP_SECS: '8', DR_TEST_SIGNAL_FILE: signal },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let so = '', se = ''; child.stdout.on('data', (d) => (so += d)); child.stderr.on('data', (d) => (se += d));
  const done = new Promise((r) => child.on('close', r));
  for (let i = 0; i < 120 && !existsSync(signal); i++) await sleep(250);
  if (!existsSync(signal)) fail(`${name}: backup never reached the snapshot→capture window`);
  const extra = await during();
  const code = await done;
  writeFileSync(join(EV, `concurrency-${name}-backup.log`), se);
  const res = JSON.parse(so.trim().split('\n').pop() || '{}');
  const ref = JSON.parse(STREAM ? snapCat(res.package, 'uploads.refcheck.json').toString() : readFileSync(join(res.dir, 'uploads.refcheck.json'), 'utf8'));
  const v = STREAM
    ? spawn('bash', [join(HERE, '..', 'snapshot.sh'), 'verify', res.package, '--deep'], { stdio: 'ignore', env: { ...process.env, ...srcEnv } })
    : spawn('bash', [join(HERE, '..', 'verify.sh'), res.dir], { stdio: 'ignore' });
  const verifyExit = await new Promise((r) => v.on('close', r));
  return { code, res, ref, log: se, verifyExit, extra };
}

// ── S3 client for out-of-band operations (simulates a tool writing to the bucket) ──
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
const s3 = new S3Client({ endpoint: srcEnv.DO_SPACES_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: srcEnv.DO_SPACES_ACCESS_KEY, secretAccessKey: srcEnv.DO_SPACES_SECRET_KEY } });
const BUCKET = srcEnv.DO_SPACES_BUCKET;
const keyOf = (url) => url.slice(srcEnv.DO_SPACES_PUBLIC_URL.length + 1);
const exists = async (key) => { try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; } catch { return false; } };

// ── A1) application writes inside the window → PREVENTED (consistent on attempt 1) ──
console.log('A1) app writes inside the snapshot→capture window (upload, photo replacement, renewal, soft-delete)');
const photoBefore = (await call('GET', `/employees/${photoEmp}`, hr)).json.photoUrl;
const a1 = await pausedBackup('a1', async () => {
  const up = await uploadDoc(hr, alphaEmp.id, typeId, 'Uploaded-during-backup');
  const ph = await replacePhoto(hr, photoEmp);
  const rn = await renewDoc(hr, alphaDocs[1].id, 'Renewed-during-backup');
  const del = await call('DELETE', `/documents/${alphaDocs[0].id}`, admin);
  const oldPhotoStillThere = await exists(keyOf(photoBefore));
  console.log(`  · during window: upload=${up.status} photo-replace=${ph.status} renew=${rn.status} soft-delete=${del.status}; replaced photo object still present: ${oldPhotoStillThere}`);
  return { statuses: { upload: up.status, photoReplace: ph.status, renew: rn.status, softDelete: del.status }, oldPhotoStillThere };
});
results.A1 = { exitCode: a1.code, consistencyAttempts: a1.res.consistencyAttempts, uploadsComplete: a1.res.uploadsComplete,
  referenced: a1.ref.referenced, inconsistent: a1.ref.missingCount, verifyExit: a1.verifyExit, ...a1.extra };
if (Object.values(a1.extra.statuses).some((st) => st >= 300)) fail('an API write during the window failed');
if (!a1.extra.oldPhotoStillThere) fail('A1: the replaced photo object was deleted immediately (deferred deletion not active)');
ok('photo replacement inside the window: old object kept (deletion deferred to the purge queue)');
if (a1.code !== 0 || !a1.res.uploadsComplete || a1.res.consistencyAttempts !== 1) fail(`A1: expected consistent on attempt 1, got exit ${a1.code} attempts ${a1.res.consistencyAttempts}`);
ok(`app writes inside the window → consistent on the FIRST attempt (${a1.ref.referenced} referenced, 0 inconsistent) — prevented, not just detected`);
if (a1.verifyExit !== 0) fail('A1 package failed verify.sh'); ok('A1 package passes verify.sh');

// ── A2) OUT-OF-BAND overwrite of a referenced object key → DETECTED + retried ──
console.log('A2) out-of-band overwrite of an existing, referenced object key inside the window');
const victim = data.documents.find((d) => d.tenant === 'beta');
const victimKey = keyOf(victim.fileUrl);
const newBytes = Buffer.from(`%PDF-1.4\n% overwritten out-of-band ${Date.now()}\n%%EOF\n`);
const a2 = await pausedBackup('a2', async () => {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: victimKey, Body: newBytes, ContentType: 'application/pdf' }));
  return { overwrittenKey: victimKey };
});
const capturedSha = STREAM
  ? JSON.parse(snapCat(a2.res.package, 'uploads.manifest.json').toString()).files.find((f) => f.key === victimKey)?.sha256
  : createHash('sha256').update(readFileSync(join(a2.res.dir, 'uploads', victimKey))).digest('hex');
const newSha = createHash('sha256').update(newBytes).digest('hex');
results.A2 = { exitCode: a2.code, consistencyAttempts: a2.res.consistencyAttempts, uploadsComplete: a2.res.uploadsComplete,
  detectedOnAttempt1: /missing or overwritten during backup/.test(a2.log), capturedIsNewVersion: capturedSha === newSha, verifyExit: a2.verifyExit };
if (!results.A2.detectedOnAttempt1) fail('A2: overwrite of a referenced key was NOT detected');
ok('overwrite of a referenced key detected on attempt 1 (pre-snapshot ETag ≠ captured ETag)');
if (a2.code !== 0 || !a2.res.uploadsComplete || a2.res.consistencyAttempts !== 2) fail(`A2: expected consistent on attempt 2, got exit ${a2.code} attempts ${a2.res.consistencyAttempts}`);
if (!results.A2.capturedIsNewVersion) fail('A2: captured bytes are not the version current at the retry snapshot');
ok('retry → consistent on attempt 2; package holds the overwritten bytes together with a snapshot taken after the overwrite');
if (a2.verifyExit !== 0) fail('A2 package failed verify.sh'); ok('A2 package passes verify.sh');

// ── B) real overlap through the API (no hooks) ────────────────────────────────
console.log('B) real overlap: API-triggered FULL backup while a write load runs');
let stop = false; const loadStats = { uploads: 0, photoReplacements: 0, deletes: 0, errors: 0 };
const load = (async () => {
  let n = 0;
  while (!stop) {
    n++;
    try {
      const u = await uploadDoc(hr, alphaEmp.id, typeId, `Load-${n}`); u.status < 300 ? loadStats.uploads++ : loadStats.errors++;
      const p = await replacePhoto(hr, photoEmp); p.status < 300 ? loadStats.photoReplacements++ : loadStats.errors++;
      if (u.status < 300 && n % 2 === 0) { const d = await call('DELETE', `/documents/${u.json.id}`, admin); d.status < 300 ? loadStats.deletes++ : loadStats.errors++; }
    } catch { loadStats.errors++; }
  }
})();
await sleep(300);
const start = await call('POST', '/backup', admin, { kind: 'FULL_SYSTEM', notes: 'DR drill — concurrent load' });
if (start.status >= 300) fail(`could not start backup under load: ${start.status} ${JSON.stringify(start.json).slice(0, 200)}`);
const second = await call('POST', '/backup', admin, { kind: 'DATABASE', notes: 'should be refused' });
results.B = { overlapRequestStatus: second.status };
if (second.status !== 503) fail(`a second concurrent backup was NOT refused (HTTP ${second.status})`);
ok('second backup request while one is running → HTTP 503 (advisory lock prevents overlap)');
let row;
for (let i = 0; i < 240; i++) {
  row = (await call('GET', `/backup/${start.json.id}`, admin)).json;
  if (row.status !== 'RUNNING') break; await sleep(500);
}
stop = true; await load;
results.B = { ...results.B, status: row.status, consistencyAttempts: row.metadata?.consistencyAttempts,
  uploadsComplete: row.metadata?.uploadsComplete, offsiteStatus: row.offsiteStatus, load: loadStats };
console.log(`  · load during backup: ${JSON.stringify(loadStats)}`);
if (row.status !== 'COMPLETED') fail(`backup under sustained load ended ${row.status} (expected COMPLETED now that deletions are deferred): ${row.errorMessage}`);
const vB = (await call('POST', `/backup/${row.id}/verify`, admin)).json;
results.B.verify = vB.verified;
if (!vB.verified || row.metadata?.uploadsComplete !== true) fail('COMPLETED under load but not verifiable');
ok(`backup under sustained load: COMPLETED (attempts=${row.metadata?.consistencyAttempts}), verify=VERIFIED, off-site=${row.offsiteStatus}`);

// ── P) deferred-deletion purge safety ─────────────────────────────────────────
console.log('P) purge worker: never during a backup, never a referenced object');
const psql = (q) => execFileSync('/usr/lib/postgresql/18/bin/psql', ['-h', '127.0.0.1', '-p', '57432', '-U', 'postgres', '-d', 'tempworks', '-tAX', '-c', q],
  { env: { ...process.env, PGPASSWORD: env.PG_SUPERUSER_PASSWORD }, encoding: 'utf8' }).trim();
const queued = Number(psql(`SELECT count(*) FROM storage_purge_queue`));
const oldPhotoKey = keyOf(photoBefore);
results.P = { queuedBefore: queued };
if (queued < 1) fail('nothing was queued for deletion — deletions are not deferred');
if (!(await exists(oldPhotoKey))) fail('a queued (replaced) photo object is already gone before any purge');
ok(`${queued} deletion(s) queued; replaced objects still present until purged`);
const holder = spawn('/usr/lib/postgresql/18/bin/psql', ['-h', '127.0.0.1', '-p', '57432', '-U', 'postgres', '-d', 'tempworks', '-c',
  'SELECT pg_advisory_lock(7243008153); SELECT pg_sleep(6);'], { env: { ...process.env, PGPASSWORD: env.PG_SUPERUSER_PASSWORD }, stdio: 'ignore' });
await sleep(1500);
const pLocked = (await call('POST', '/backup/storage-purge', admin, { graceHours: 0 })).json;
results.P.whileBackupLocked = pLocked;
if (!pLocked.skippedBecauseBackupRunning || !(await exists(oldPhotoKey))) fail(`purge ran while a backup held the lock: ${JSON.stringify(pLocked)}`);
ok('purge while a backup holds the lock → skipped, nothing deleted');
await new Promise((r) => holder.on('close', r));
const current = (await call('GET', `/employees/${photoEmp}`, hr)).json.photoUrl;
psql(`INSERT INTO storage_purge_queue ("id","objectKey","originalRef","driver","requestedAt") VALUES ('drill-referenced','${keyOf(current)}','${current}','spaces', now() - interval '2 hours')`);
const pRun = (await call('POST', '/backup/storage-purge', admin, { graceHours: 0 })).json;
results.P.run = pRun;
if (pRun.stillReferenced < 1 || !(await exists(keyOf(current)))) fail(`purge deleted (or did not recognise) a STILL-REFERENCED object: ${JSON.stringify(pRun)}`);
ok(`queued-but-still-referenced object kept (stillReferenced=${pRun.stillReferenced})`);
if (pRun.purged < 1 || (await exists(oldPhotoKey))) fail(`unreferenced queued objects were not purged: ${JSON.stringify(pRun)}`);
ok(`unreferenced queued objects purged (${pRun.purged}); queue now ${psql('SELECT count(*) FROM storage_purge_queue')}`);

writeFileSync(`${EV}/concurrency.json`, JSON.stringify(results, null, 2));
console.log(`concurrency results → ${EV}/concurrency.json`);
