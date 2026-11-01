#!/usr/bin/env node
// Two app instances (App Platform instance_count=2 shape) sharing one database,
// one upload bucket and one backup bucket, with the bucket-native stream engine.
//
//   node two-instance.mjs core <apiA> <apiB> <evidenceDir> <drillDir>
//   node two-instance.mjs start-paused <apiA> <evidenceDir> <signalFile>   → prints backup id
//   node two-instance.mjs after-kill <apiB> <evidenceDir> <id> <term|kill>
//
// Object storage is the LOCAL S3 SIMULATOR (s3rver), not DigitalOcean Spaces.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP = join(HERE, '..', 'snapshot.sh');
const [cmd, ...args] = process.argv.slice(2);
const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const checks = [];
const check = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!cond) failures++;
};

async function call(api, method, path, token, body) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(api + path, { method, headers, body: payload });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j?.data ?? j };
}
async function login(api) {
  const r = await call(api, 'POST', '/auth/login-v2', null, { company: 'tempworks', email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
  if (!r.json?.accessToken) throw new Error(`login on ${api}: ${r.status}`);
  return r.json.accessToken;
}
async function waitDone(api, tok, id, ms = 300_000) {
  const t0 = Date.now(); let row;
  while (Date.now() - t0 < ms) {
    row = (await call(api, 'GET', `/backup/${id}`, tok)).json;
    if (row?.status && row.status !== 'RUNNING') return row;
    await sleep(1000);
  }
  return row;
}
const psql = (port, q) => execFileSync('/usr/lib/postgresql/18/bin/psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'tempworks', '-tAX', '-c', q],
  { env: { ...env, PGPASSWORD: env.PG_SUPERUSER_PASSWORD }, encoding: 'utf8' }).trim();
// A held lock: a psql session that takes the lock, then sleeps.
function holdLock(port, sqlLock, seconds) {
  const p = spawn('/usr/lib/postgresql/18/bin/psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'tempworks', '-c', `${sqlLock}; SELECT pg_sleep(${seconds});`],
    { env: { ...env, PGPASSWORD: env.PG_SUPERUSER_PASSWORD }, stdio: 'ignore' });
  p.closed = new Promise((r) => p.on('close', r)); // attached at once: never misses an early exit
  return p;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const srcEnvOf = (DRILL) => Object.fromEntries(readFileSync(join(DRILL, 'source/backend.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));

async function downloadAndVerify(api, tok, id, outDir) {
  rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true });
  const r = await fetch(`${api}/backup/${id}/download`, { headers: { Authorization: `Bearer ${tok}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(join(outDir, 'pkg.tar'), buf);
  const tar = spawnSync('tar', ['-xf', join(outDir, 'pkg.tar'), '-C', outDir]);
  const pkg = readdirSync(outDir).find((n) => n.startsWith('tempworks-dr_'));
  const v = pkg ? spawnSync('bash', [join(HERE, '..', 'verify.sh'), join(outDir, pkg)], { encoding: 'utf8' }) : { status: 1 };
  const dumpSha = pkg ? sha256(readFileSync(join(outDir, pkg, 'database', 'database.dump'))) : null;
  return { http: r.status, contentType: r.headers.get('content-type'), bytes: buf.length, tarOk: tar.status === 0, verifyExit: v.status, dumpSha, pkg };
}

// ─────────────────────────────────────────────────────────────────────────────
if (cmd === 'core') {
  const [A, B, EV, DRILL] = args;
  const srcEnv = srcEnvOf(DRILL);
  const tA = await login(A); const tB = await login(B);
  const out = {};

  console.log('T1 backup started on instance A, observed and finished via instance B');
  const st = await call(A, 'POST', '/backup', tA, { kind: 'FULL_SYSTEM', notes: 'two-instance: started on A' });
  check('backup accepted by A', st.status < 300, st.status);
  const second = await call(B, 'POST', '/backup', tB, { kind: 'DATABASE', notes: 'must be refused' });
  check('concurrent backup on B refused (cross-instance lock)', second.status === 503, second.status);
  const rowB = await waitDone(B, tB, st.json.id);
  check('B sees COMPLETED', rowB?.status === 'COMPLETED', rowB?.status);
  check('engine = stream (bucket-native)', rowB?.engine === 'stream', rowB?.engine);
  check('stored copy verified by the engine', rowB?.verifyResult === 'VERIFIED' && rowB?.offsiteStatus === 'VERIFIED', { verify: rowB?.verifyResult, offsite: rowB?.offsiteStatus });
  out.backup = { id: rowB?.id, fileName: rowB?.fileName, location: rowB?.location, checksum: rowB?.checksum };

  console.log('T2 list / verify / download through instance B');
  const listB = (await call(B, 'GET', '/backup?limit=50', tB)).json;
  const inList = (listB.data ?? listB).find((b) => b.id === st.json.id);
  check('B lists it as present (fileExists, not missing)', inList?.fileExists === true && inList?.fileMissing === false, { fileExists: inList?.fileExists, fileMissing: inList?.fileMissing });
  const vB = (await call(B, 'POST', `/backup/${st.json.id}/verify`, tB)).json;
  check('deep verification via B', vB?.verified === true, vB?.detail?.split('\n').slice(-2).join(' | '));
  const dB = await downloadAndVerify(B, tB, st.json.id, join(DRILL, 'dl-b'));
  check('download via B is a valid package (tar extracts, verify.sh passes)', dB.http === 200 && dB.tarOk && dB.verifyExit === 0, dB);
  check('downloaded dump sha256 = catalog checksum', dB.dumpSha === rowB?.checksum);
  out.downloadB = dB;

  console.log('T3 remove BOTH instances\' local backup + temp directories, then list / reconcile / download again');
  const wiped = [];
  for (const d of [srcEnv.BACKUP_DIR, srcEnv.TMPDIR, srcEnv.BACKUP_DIR.replace(/backups$/, 'backups-b'), `${srcEnv.BACKUP_DIR.replace(/backups$/, 'backups-b')}.tmp`]) {
    if (d && existsSync(d)) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); wiped.push(d); }
  }
  check('local dirs of both instances wiped', wiped.length >= 2, wiped);
  const listA2 = (await call(A, 'GET', '/backup?limit=50', tA)).json; const listB2 = (await call(B, 'GET', '/backup?limit=50', tB)).json;
  const a2 = (listA2.data ?? listA2).find((b) => b.id === st.json.id); const b2 = (listB2.data ?? listB2).find((b) => b.id === st.json.id);
  check('still present on A and on B (bucket is authoritative, not local cache)', a2?.fileExists === true && b2?.fileExists === true && !a2?.fileMissing && !b2?.fileMissing);
  const rec = (await call(A, 'POST', '/backup/reconcile', tA)).json;
  check('reconcile via A marks nothing missing', rec?.missing === 0, rec);
  const dA = await downloadAndVerify(A, tA, st.json.id, join(DRILL, 'dl-a'));
  check('download via A after the wipe: identical dump, verify.sh passes', dA.verifyExit === 0 && dA.dumpSha === dB.dumpSha, { verifyExit: dA.verifyExit });
  out.reconcileAfterWipe = rec;

  console.log('T4 purge coordination across instances');
  const pg = Number(new URL(srcEnv.DATABASE_URL).port);
  let h = holdLock(pg, 'SELECT pg_advisory_lock(7243008154)', 5); await sleep(1500);
  const p1 = (await call(B, 'POST', '/backup/storage-purge', tB, { graceHours: 0 })).json;
  check('purge on B skipped while another instance purges (purge lock)', p1?.skippedBecauseOtherInstancePurging === true, p1);
  await h.closed;
  h = holdLock(pg, 'SELECT pg_advisory_lock(7243008153)', 5); await sleep(1500);
  const p2 = (await call(B, 'POST', '/backup/storage-purge', tB, { graceHours: 0 })).json;
  check('purge skipped while a backup holds the lock exclusively', p2?.skippedBecauseBackupRunning === true, p2);
  await h.closed;
  h = holdLock(pg, 'SELECT pg_advisory_lock_shared(7243008153)', 4); await sleep(1500);
  const t0 = Date.now();
  const st2 = await call(A, 'POST', '/backup', tA, { kind: 'DATABASE', notes: 'two-instance: waits for a purge' });
  const waited = (Date.now() - t0) / 1000;
  check('a backup requested during a purge waits for it, then starts (no false "busy")', st2.status < 300 && waited >= 1.5, { status: st2.status, waitedSeconds: waited });
  await h.closed;
  const r2 = await waitDone(B, tB, st2.json.id);
  check('that backup completes', r2?.status === 'COMPLETED', r2?.status);

  console.log('T5 snapshot made OUTSIDE the app (external runner) is imported by reconcile');
  // An external runner must retry on exit 5 (lock busy): the previous backup
  // may still hold the operation lock for its retention step.
  let ext;
  for (let i = 0; i < 12; i++) {
    ext = spawnSync('bash', [SNAP, 'backup', '--kind', 'database', '--label', 'external-runner'], { env: { ...env, ...srcEnv }, encoding: 'utf8' });
    if (ext.status !== 5) break;
    await sleep(5000);
  }
  const extRes = JSON.parse(ext.stdout.trim().split('\n').pop() || '{}');
  check('external snapshot created', ext.status === 0, ext.status);
  const rec2 = (await call(B, 'POST', '/backup/reconcile', tB)).json;
  check('reconcile via B imports it', rec2?.imported >= 1, rec2);
  const listA3 = (await call(A, 'GET', '/backup?limit=50', tA)).json;
  const imp = (listA3.data ?? listA3).find((b) => b.fileName === extRes.package);
  check('A lists the imported snapshot as COMPLETED + present', imp?.status === 'COMPLETED' && imp?.fileExists === true, imp && { status: imp.status, notes: imp.notes });

  writeFileSync(join(EV, 'two-instance-core.json'), JSON.stringify({ environment: 'local, two backend processes, PostgreSQL 18, s3rver S3 SIMULATOR', failures, checks, ...out }, null, 2));
  console.log(failures ? `${failures} check(s) FAILED` : 'two-instance core: all checks passed');
  process.exit(failures ? 1 : 0);
}

if (cmd === 'start-paused') {
  const [A, EV, signal] = args;
  rmSync(signal, { force: true });
  const tA = await login(A);
  const st = await call(A, 'POST', '/backup', tA, { kind: 'FULL_SYSTEM', notes: 'two-instance: interrupted by termination' });
  if (st.status >= 300) { console.error(`backup not accepted: ${st.status}`); process.exit(1); }
  for (let i = 0; i < 600 && !existsSync(signal); i++) await sleep(100);
  if (!existsSync(signal)) { console.error('engine never reached the paused window'); process.exit(1); }
  process.stdout.write(st.json.id + '\n');
  process.exit(0);
}

if (cmd === 'after-kill') {
  const [B, EV, id, mode, DRILL] = args;
  const srcEnv = srcEnvOf(DRILL);
  const tB = await login(B);
  const t0 = Date.now(); let row;
  // SIGTERM: recorded by the stopping instance. SIGKILL: by the survivor's
  // periodic reconcile (every 2 min) once PostgreSQL drops the dead session.
  const limit = mode === 'term' ? 60_000 : 300_000;
  while (Date.now() - t0 < limit) {
    row = (await call(B, 'GET', `/backup/${id}`, tB)).json;
    if (row?.status && row.status !== 'RUNNING') break;
    await sleep(2000);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  check(`${mode}: catalog row leaves RUNNING → FAILED`, row?.status === 'FAILED', { status: row?.status, afterSeconds: secs });
  check(`${mode}: reason recorded`, /Interrupted/.test(row?.errorMessage ?? ''), row?.errorMessage);
  const snaps = JSON.parse(execFileSync('bash', [SNAP, 'list'], { env: { ...env, ...srcEnv }, encoding: 'utf8' }));
  check(`${mode}: no snapshot committed for the interrupted run (no MANIFEST with its catalogId)`, !snaps.some((x) => x.catalogId === id));
  if (mode === 'kill') {
    // SIGKILL leaves the uncommitted files behind (no chance to clean up);
    // retention GC removes them once older than the grace period.
    const gc = spawnSync('bash', [SNAP, 'retention', '--keep', '100'], { env: { ...env, ...srcEnv, DR_GC_GRACE_HOURS: '0' }, encoding: 'utf8' });
    const g = JSON.parse(gc.stdout.trim().split('\n').pop() || '{}');
    check('kill: retention GC removes the orphaned uncommitted snapshot files', gc.status === 0 && g.orphanSnapshotsDeleted >= 1, g);
  }
  const st = await call(B, 'POST', '/backup', tB, { kind: 'DATABASE', notes: `after ${mode}` });
  check(`${mode}: lock released — a new backup starts on the surviving instance`, st.status < 300, st.status);
  if (st.status < 300) { const r = await waitDone(B, tB, st.json.id); check(`${mode}: that backup completes`, r?.status === 'COMPLETED', r?.status); }
  const file = join(EV, 'two-instance-termination.json');
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  prev[mode] = { failures, checks, detectedAfterSeconds: secs };
  writeFileSync(file, JSON.stringify(prev, null, 2));
  process.exit(failures ? 1 : 0);
}

console.error('usage: two-instance.mjs core|start-paused|after-kill …');
process.exit(2);
