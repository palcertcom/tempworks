#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// stream-race-test.mjs — concurrency / failure tests for snapshot-engine.mjs.
//
// Runs against a perf-env.sh environment (PostgreSQL + S3 SIMULATOR). Each case
// uses the engine's test-only pause between the DB snapshot and the file
// capture (DR_TEST_PAUSE_AFTER_DUMP_SECS) to race storage changes against a
// running backup, deterministically.
//
//   A  overwrite a referenced object IN PLACE (same key)      → retry, consistent
//   B  delete a referenced object for good                    → INCOMPLETE (exit 4)
//   C  delete + re-create a referenced object (transient)     → retry, consistent
//   D  reference that exists in NO source (pre-existing loss) → DEGRADED (exit 6), evidence, verify exit 6
//   D2 lost object, earlier copy WITHOUT version evidence      → candidate kept, DEGRADED
//   D2p lost app-written object (write-once evidence)          → recovered, COMPLETE (provably identical)
//   D5 legacy key V1 backed up → replaced by V2 → lost         → V1 kept as candidate, DEGRADED, disclosed
//   D6 other instance's inventory V1, replaced there by V2     → candidate, DEGRADED (same rule)
//   R  DEGRADED snapshot newer than the last COMPLETE one      → both kept; complete never displaced
//   E  SIGTERM mid-backup (redeploy)                          → exit 143, nothing committed, lock free
//   F  second backup while one runs (any instance)            → exit 5 (busy)
//   G  retention keep=1 + blob GC                             → old snapshots + unreferenced blobs gone
//   H  restore-side: kept snapshot still verifies (deep)      → exit 0
//
// Usage (env from `perf-env.sh env` already exported):
//   node stream-race-test.mjs <evidence.json>
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', '..', 'package.json'));
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const SNAP = join(HERE, '..', 'snapshot.sh');
const OUT = process.argv[2] || '/tmp/stream-race.json';
const E = process.env;
const s3 = new S3Client({ endpoint: E.DO_SPACES_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' } });
const LIVE = E.DO_SPACES_BUCKET; const BK = E.BACKUP_SPACES_BUCKET; const PFX = E.BACKUP_SPACES_PREFIX || 'dr/';
const PSQL = (E.PG_BIN_PATH || '/usr/lib/postgresql/18/bin') + '/psql';
const results = {}; let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (c, name, cond, detail) => {
  (results[c] ??= { checks: [] }).checks.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} [${c}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!cond) failures++;
};
const sql = (q) => execFileSync(PSQL, ['-X', '-qtA', '-d', E.DATABASE_URL, '-c', q], { encoding: 'utf8' }).trim();
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function body(Bucket, Key) { const r = await s3.send(new GetObjectCommand({ Bucket, Key })); return Buffer.from(await r.Body.transformToByteArray()); }
const keyOf = (url) => url.replace(`${E.DO_SPACES_PUBLIC_URL}/`, '');

function snap(args, extraEnv = {}) {
  const c = spawn('bash', [SNAP, ...args], { env: { ...E, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = ''; let se = '';
  c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { se += d; });
  c.result = new Promise((res) => c.on('close', (code) => {
    let json = null; try { json = JSON.parse(so.trim().split('\n').pop()); } catch { /* none */ }
    res({ code, json, stderr: se });
  }));
  return c;
}
async function paused(name, during, extraEnv = {}) {
  const signal = `/tmp/stream-race-${name}.signal`; rmSync(signal, { force: true });
  const c = snap(['backup', '--kind', 'full', '--label', `race-${name}`], { DR_TEST_PAUSE_AFTER_DUMP_SECS: '4', DR_TEST_SIGNAL_FILE: signal, ...extraEnv });
  for (let i = 0; i < 400 && !existsSync(signal); i++) await sleep(100);
  if (!existsSync(signal)) throw new Error(`${name}: never reached the snapshot→capture window`);
  const extra = await during(c);
  const r = await c.result;
  return { ...r, extra };
}
async function refcheckOf(pkg) { return JSON.parse((await body(BK, `${PFX}snapshots/${pkg}/uploads.refcheck.json`)).toString()); }
async function manifestOf(pkg) { return JSON.parse((await body(BK, `${PFX}snapshots/${pkg}/MANIFEST.json`)).toString()); }
async function uploadsManifest(pkg) { return JSON.parse((await body(BK, `${PFX}snapshots/${pkg}/uploads.manifest.json`)).toString()); }
async function keys(Bucket, Prefix) { const out = []; let t; do { const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: t })); for (const o of r.Contents || []) out.push(o.Key); t = r.IsTruncated ? r.NextContinuationToken : undefined; } while (t); return out; }
const lockFree = () => sql('SELECT pg_try_advisory_lock(7243008153) AND pg_advisory_unlock(7243008153)') === 't';

const refs = sql(`SELECT id||'|'||"fileUrl" FROM documents ORDER BY id LIMIT 3`).split('\n').map((l) => l.split('|'));
const [A, B, C] = refs.map(([id, url]) => ({ id, url, key: keyOf(url) }));

// ── A overwrite in place ─────────────────────────────────────────────────────
console.log('A: overwrite a referenced object in place during the backup');
const newA = randomBytes(300_000);
const ra = await paused('A', async () => { await s3.send(new PutObjectCommand({ Bucket: LIVE, Key: A.key, Body: newA })); });
check('A', 'exit 0 (consistent after retry)', ra.code === 0, ra.code);
check('A', 'needed a retry (overwrite detected)', ra.json?.consistencyAttempts === 2, ra.json?.consistencyAttempts);
const ua = await uploadsManifest(ra.json.package);
check('A', 'captured bytes are the NEW content', ua.files.find((f) => f.key === A.key)?.sha256 === sha(newA));
results.A.package = ra.json.package;

// ── B delete for good ────────────────────────────────────────────────────────
console.log('B: delete a referenced object for good during the backup');
const savedB = await body(LIVE, B.key);
const rb = await paused('B', async () => { await s3.send(new DeleteObjectCommand({ Bucket: LIVE, Key: B.key })); });
check('B', 'exit 4 (INCOMPLETE)', rb.code === 4, rb.code);
const mb = await manifestOf(rb.json.package);
check('B', 'MANIFEST complete=false', mb.complete === false);
const rcb = await refcheckOf(rb.json.package);
check('B', 'refcheck lists the vanished reference as missing (not dangling)', rcb.missing.includes(B.url) && !rcb.dangling.includes(B.url), { missing: rcb.missingCount, dangling: rcb.danglingCount });
check('B', 'all retries used', rb.json.consistencyAttempts === 3, rb.json.consistencyAttempts);
const vb = await snap(['verify', rb.json.package]).result;
check('B', 'recoverability INCOMPLETE with FILES_CHANGED_DURING_BACKUP', mb.recoverability === 'INCOMPLETE' && mb.recoveryIssues.some((i) => i.code === 'FILES_CHANGED_DURING_BACKUP'));
check('B', 'verify: integrity OK, recoverability INCOMPLETE → exit 6 (not verified)', vb.code === 6 && vb.json.integrity === 'OK' && vb.json.verified === false, vb.code);
await s3.send(new PutObjectCommand({ Bucket: LIVE, Key: B.key, Body: savedB }));
results.B.package = rb.json.package;

// ── C transient delete ───────────────────────────────────────────────────────
console.log('C: delete + re-create a referenced object during the backup');
const savedC = await body(LIVE, C.key);
const rc = await paused('C', async () => {
  await s3.send(new DeleteObjectCommand({ Bucket: LIVE, Key: C.key }));
  setTimeout(() => { s3.send(new PutObjectCommand({ Bucket: LIVE, Key: C.key, Body: savedC })); }, 4500);
});
check('C', 'exit 0 (consistent after retry)', rc.code === 0, rc.code);
check('C', 'needed a retry', (rc.json?.consistencyAttempts ?? 0) >= 2, rc.json?.consistencyAttempts);

// ── D pre-existing missing reference (no copy anywhere) ──────────────────────
console.log('D: a reference to a file that exists in NO source (pre-existing loss)');
const ghost = `${E.DO_SPACES_PUBLIC_URL}/documents/EMPLOYEE/e1/Contract/never-existed-${randomBytes(4).toString('hex')}.pdf`;
sql(`INSERT INTO documents (id,name,"documentTypeId","entityType","entityId","fileUrl","mimeType","fileSize","uploadedById","tenantId","updatedAt") VALUES ('ghost','ghost','d1','EMPLOYEE','e1','${ghost}','application/pdf',1,'u1','t1',now())`);
const rd = await snap(['backup', '--kind', 'full', '--label', 'race-D']).result;
check('D', 'exit 6 DEGRADED (consistent, single attempt) — not COMPLETE', rd.code === 6 && rd.json.recoverability === 'DEGRADED' && rd.json.consistencyAttempts === 1, { code: rd.code, rec: rd.json?.recoverability });
const md = await manifestOf(rd.json.package);
check('D', 'MANIFEST: recoverability DEGRADED, complete=false, FILES_UNRESOLVED issue', md.recoverability === 'DEGRADED' && md.complete === false && md.recoveryIssues.some((i) => i.code === 'FILES_UNRESOLVED' && i.count === 1));
const rcd = await refcheckOf(rd.json.package);
const ev = rcd.unresolved[0];
check('D', 'evidence: listings + direct HEAD 404 + earlier snapshots searched', ev?.ref === ghost && ev.checked.some((c) => /HEAD → 404/.test(c)) && ev.checked.some((c) => /earlier snapshot/.test(c)) && rcd.evidence.directHeads >= 1, ev?.checked);
const vd = await snap(['verify', rd.json.package, '--deep']).result;
check('D', 'verify: integrity OK but recoverability DEGRADED → exit 6 (not "verified")', vd.code === 6 && vd.json.integrity === 'OK' && vd.json.recoverability === 'DEGRADED' && vd.json.verified === false, { code: vd.code });
const listD = JSON.parse(execFileSync('bash', [SNAP, 'list'], { encoding: 'utf8', env: E })).find((x) => x.package === rd.json.package);
check('D', 'list: shown as DEGRADED / complete=false', listD?.recoverability === 'DEGRADED' && listD.complete === false);
sql(`DELETE FROM documents WHERE id='ghost'`);

// Helper: upload through the REAL StorageService (records write-once version
// evidence in object metadata), returning { key, url }.
function appUpload(bytes) {
  const out = execFileSync('npx', ['ts-node', '--transpile-only', '-e',
    "const {StorageService}=require('./src/common/storage/storage.service');(async()=>{const s=new StorageService();s.onModuleInit();" +
    "const r=await s.uploadFile(Buffer.from(process.env.BODY_B64,'base64'),{keyPrefix:'documents/EMPLOYEE/e1/Contract',originalName:'x.pdf',contentType:'application/pdf'});" +
    "process.stdout.write('\\n'+JSON.stringify(r)+'\\n')})().catch(e=>{console.error(e);process.exit(1)})"],
    { cwd: join(HERE, '..', '..', '..'), env: { ...E, BODY_B64: bytes.toString('base64') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.trim().split('\n').pop());
}
const addDoc = (id, url) => sql(`INSERT INTO documents (id,name,"documentTypeId","entityType","entityId","fileUrl","mimeType","fileSize","uploadedById","tenantId","updatedAt") VALUES ('${id}','${id}','d1','EMPLOYEE','e1','${url}','application/pdf',1,'u1','t1',now())`);

// ── D2 object lost from live storage; copy in an earlier snapshot WITHOUT version evidence
console.log('D2: object deleted from live storage, an earlier snapshot holds a copy, but it was written without app version evidence');
const lost = (await uploadsManifest(results.A.package)).files.find((f) => f.key !== A.key);
const lostBody = await body(LIVE, lost.key);
await s3.send(new DeleteObjectCommand({ Bucket: LIVE, Key: lost.key }));
const rd2 = await snap(['backup', '--kind', 'full', '--label', 'race-D2']).result;
check('D2', 'NOT complete: exit 6 DEGRADED with FILES_VERSION_UNVERIFIED', rd2.code === 6 && rd2.json.recoverability === 'DEGRADED' && rd2.json.recoveryIssues.some((i) => i.code === 'FILES_VERSION_UNVERIFIED'), { code: rd2.code });
const ud2 = (await uploadsManifest(rd2.json.package)).files.find((f) => f.key === lost.key);
check('D2', 'candidate preserved in the backup, marked versionVerified=false, source disclosed', ud2 && ud2.versionVerified === false && /earlier snapshot/.test(ud2.recoveredFrom) && ud2.sha256 === sha(lostBody), ud2 && { from: ud2.recoveredFrom, verified: ud2.versionVerified });
await s3.send(new PutObjectCommand({ Bucket: LIVE, Key: lost.key, Body: lostBody }));

// ── D2p provably identical: app-written object (write-once evidence) ──────────
console.log('D2p: app-written object (write-once, unique key, recorded SHA-256) lost from live storage after a backup');
const pBody = randomBytes(4000);
const up = appUpload(pBody);
addDoc('proven1', up.url);
const rp1 = await snap(['backup', '--kind', 'full', '--label', 'race-D2p-1']).result;
const ep1 = (await uploadsManifest(rp1.json.package)).files.find((f) => f.key === up.key);
check('D2p', 'capture records the version evidence from the object metadata', rp1.code === 0 && ep1?.versionEvidence === 'app-write-once-unique-key', ep1?.versionEvidence);
await s3.send(new DeleteObjectCommand({ Bucket: LIVE, Key: up.key }));
const rp2 = await snap(['backup', '--kind', 'full', '--label', 'race-D2p-2']).result;
const ep2 = (await uploadsManifest(rp2.json.package)).files.find((f) => f.key === up.key);
check('D2p', 'normal recovery still works: COMPLETE, copy versionVerified=true, identical bytes', rp2.code === 0 && rp2.json.recoverability === 'COMPLETE' && ep2?.versionVerified === true && ep2.sha256 === sha(pBody), { code: rp2.code, verified: ep2?.versionVerified });
check('D2p', 'LIVE_STORAGE_MISSING_RECOVERED reported so live storage can be repaired', rp2.json.recoveryIssues.some((i) => i.code === 'LIVE_STORAGE_MISSING_RECOVERED'));
sql(`DELETE FROM documents WHERE id='proven1'`);

// ── D5 legacy key: V1 backed up, replaced by V2, then lost (the requested regression) ─
console.log('D5: legacy key backed up as V1, replaced with V2, live file removed, recovery attempted from the older snapshot');
const dirA = `/tmp/stream-race-instA`; const dirB = `/tmp/stream-race-instB`;
rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true });
execFileSync('mkdir', ['-p', `${dirA}/documents/legacy`, `${dirB}/documents/legacy`]);
const k5 = `documents/legacy/${randomBytes(4).toString('hex')}.pdf`; const V1 = randomBytes(5000); const V2 = randomBytes(5000);
writeFileSync(`${dirA}/${k5}`, V1);
addDoc('legacy5', `/uploads/${k5}`);
const r51 = await snap(['backup', '--kind', 'full', '--label', 'race-D5-v1'], { DR_INSTANCE_ID: 'instance-A', LEGACY_UPLOADS_DIR: dirA }).result;
const e51 = JSON.parse((await body(BK, `${PFX}snapshots/${r51.json.package}/uploads-legacy-local.manifest.json`)).toString()).files.find((f) => f.key === k5);
check('D5', 'V1 captured live (COMPLETE)', r51.code === 0 && e51?.sha256 === sha(V1), r51.code);
writeFileSync(`${dirA}/${k5}`, V2);                 // replaced in place …
rmSync(`${dirA}/${k5}`);                            // … then lost before the next backup
const r52 = await snap(['backup', '--kind', 'full', '--label', 'race-D5'], { DR_INSTANCE_ID: 'instance-A', LEGACY_UPLOADS_DIR: dirA }).result;
const e52 = JSON.parse((await body(BK, `${PFX}snapshots/${r52.json.package}/uploads-legacy-local.manifest.json`)).toString()).files.find((f) => f.key === k5);
const u52 = (await refcheckOf(r52.json.package)).versionUnverified.find((u) => u.key === k5);
check('D5', 'NOT COMPLETE merely because V1 is available: exit 6 DEGRADED, FILES_VERSION_UNVERIFIED', r52.code === 6 && r52.json.recoverability === 'DEGRADED' && r52.json.recoveryIssues.some((i) => i.code === 'FILES_VERSION_UNVERIFIED'), r52.code);
check('D5', 'V1 preserved as a disclosed candidate (sha, source, reason), versionVerified=false', e52?.sha256 === sha(V1) && e52.versionVerified === false && u52 && /earlier snapshot/.test(u52.from) && /no evidence/.test(u52.reason), u52 && { from: u52.from, reason: u52.reason });
const v52 = await snap(['verify', r52.json.package]).result;
check('D5', 'verify: integrity OK, recoverability DEGRADED (exit 6)', v52.code === 6 && v52.json.integrity === 'OK', v52.code);

// ── D6 the same rule for another instance's inventory ─────────────────────────
console.log('D6: legacy file inventoried on instance B as V1, replaced there with V2 afterwards');
const k6 = `documents/legacy/${randomBytes(4).toString('hex')}.pdf`;
writeFileSync(`${dirB}/${k6}`, V1);
addDoc('legacy6', `/uploads/${k6}`);
const r64 = await snap(['backup', '--kind', 'full', '--label', 'race-D6-before'], { DR_INSTANCE_ID: 'instance-A', LEGACY_UPLOADS_DIR: dirA }).result;
const ev64 = (await refcheckOf(r64.json.package)).unresolved.find((u) => u.key === k6);
check('D6', 'before instance B reported: unresolved, evidence names this instance + "no inventory from any other instance"', r64.code === 6 && ev64 && ev64.checked.some((c) => /instance instance-A/.test(c)) && ev64.checked.some((c) => /no inventory from any other instance/.test(c)), ev64?.checked);
const inv = await snap(['legacy-inventory'], { DR_INSTANCE_ID: 'instance-B', LEGACY_UPLOADS_DIR: dirB }).result;
check('D6', 'legacy-inventory on instance B records its file', inv.code === 0 && inv.json.instance === 'instance-B' && inv.json.files >= 1, inv.json);
writeFileSync(`${dirB}/${k6}`, V2);                 // B's copy replaced after its inventory
const r6 = await snap(['backup', '--kind', 'full', '--label', 'race-D6'], { DR_INSTANCE_ID: 'instance-A', LEGACY_UPLOADS_DIR: dirA }).result;
const e6 = JSON.parse((await body(BK, `${PFX}snapshots/${r6.json.package}/uploads-legacy-local.manifest.json`)).toString()).files.find((f) => f.key === k6);
const u6 = (await refcheckOf(r6.json.package)).versionUnverified.find((u) => u.key === k6);
check('D6', 'inventory copy is a CANDIDATE, not proof: DEGRADED, versionVerified=false, source = instance B', r6.code === 6 && e6?.versionVerified === false && e6.sha256 === sha(V1) && /instance instance-B/.test(u6?.from || ''), { code: r6.code, from: u6?.from });
sql(`DELETE FROM documents WHERE id IN ('legacy5','legacy6')`);

// ── E SIGTERM mid-backup ─────────────────────────────────────────────────────
console.log('E: SIGTERM during the backup (redeploy / scale-in)');
const before = new Set(await keys(BK, `${PFX}snapshots/`));
const re = await paused('E', async (c) => { c.kill('SIGTERM'); });
check('E', 'exit 143', re.code === 143, re.code);
const after = (await keys(BK, `${PFX}snapshots/`)).filter((k) => !before.has(k));
check('E', 'no uncommitted snapshot files left behind', after.length === 0, after.slice(0, 3));
check('E', 'operation lock released', lockFree());
check('E', 'list does not show an interrupted snapshot', !(JSON.parse(execFileSync('bash', [SNAP, 'list'], { encoding: 'utf8', env: E })).some((s) => s.label === 'race-E')));

// ── F busy ───────────────────────────────────────────────────────────────────
console.log('F: a second backup while one is running');
const rf = await paused('F', async () => (await snap(['backup', '--kind', 'database']).result));
check('F', 'second backup refused with exit 5 (lock held)', rf.extra.code === 5, rf.extra.code);
check('F', 'first backup still completes', rf.code === 0, rf.code);

// ── G retention + GC ─────────────────────────────────────────────────────────
console.log('G: retention keep=1 with blob garbage collection');
// A stray blob, as left by a backup that crashed before committing MANIFEST.
const strayBody = randomBytes(1000); const stray = `${PFX}blobs/sha256/${sha(strayBody).slice(0, 2)}/${sha(strayBody)}`;
await s3.send(new PutObjectCommand({ Bucket: BK, Key: stray, Body: strayBody }));
const blobsBefore = (await keys(BK, `${PFX}blobs/`)).length;
await snap(['retention', '--keep', '1']).result; // default 24 h grace
check('G', 'fresh unreferenced blob survives the GC grace period (protects in-flight backups)', (await keys(BK, `${PFX}blobs/`)).includes(stray));
const rg = await snap(['retention', '--keep', '1'], { DR_GC_GRACE_HOURS: '0' }).result;
const left = JSON.parse(execFileSync('bash', [SNAP, 'list'], { encoding: 'utf8', env: E }));
check('G', 'exactly one snapshot kept (the newest complete)', left.length === 1 && left[0].package === rf.json.package, left.map((s) => s.package));
const keptFiles = new Set((await uploadsManifest(left[0].package).catch(() => ({ files: [] }))).files.map((f) => f.sha256));
const blobsAfter = await keys(BK, `${PFX}blobs/`);
check('G', 'unreferenced blobs collected after grace', !blobsAfter.includes(stray) && blobsAfter.every((k) => keptFiles.has(k.split('/').pop())), { before: blobsBefore, after: blobsAfter.length, removed: rg.json?.blobsDeleted });

// ── R a NEWER partial snapshot never displaces the last COMPLETE one ─────────
console.log('R: retention with a DEGRADED snapshot newer than the last COMPLETE one');
sql(`INSERT INTO documents (id,name,"documentTypeId","entityType","entityId","fileUrl","mimeType","fileSize","uploadedById","tenantId","updatedAt") VALUES ('ghost2','ghost','d1','EMPLOYEE','e1','${E.DO_SPACES_PUBLIC_URL}/documents/none-${randomBytes(3).toString('hex')}.pdf','application/pdf',1,'u1','t1',now())`);
const rr = await snap(['backup', '--kind', 'full', '--label', 'race-R']).result;
const rret = await snap(['retention', '--keep', '1'], { DR_GC_GRACE_HOURS: '0' }).result;
const leftR = JSON.parse(execFileSync('bash', [SNAP, 'list'], { encoding: 'utf8', env: E }));
check('R', 'the last COMPLETE snapshot is kept AND the newer DEGRADED one is kept as a partial', rr.code === 6 && leftR.some((x) => x.package === rf.json.package && x.recoverability === 'COMPLETE') && leftR.some((x) => x.package === rr.json.package && x.recoverability === 'DEGRADED'), leftR.map((x) => `${x.package}:${x.recoverability}`));
check('R', 'retention reports them separately', (rret.json?.keptComplete || []).includes(rf.json.package) && (rret.json?.keptPartial || []).includes(rr.json.package), rret.json);
sql(`DELETE FROM documents WHERE id='ghost2'`);

// ── H kept snapshot still fully verifiable ───────────────────────────────────
console.log('H: deep verification of the kept snapshot after GC');
const rh = await snap(['verify', left[0].package, '--deep']).result;
check('H', 'deep verify exit 0', rh.code === 0, rh.json?.problems);

writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), environment: 'local PostgreSQL 18 + s3rver S3 SIMULATOR (not real Spaces)', failures, results }, null, 2));
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
