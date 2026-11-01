#!/usr/bin/env node
// End-to-end verification of the RECOVERED TempWorks installation through its
// own UI, API, database and object storage — with the source stopped.
//
// Usage: node verify-recovery.mjs <drillDir>
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const { chromium } = createRequire(import.meta.url)('playwright');
const [DRILL] = process.argv.slice(2);
const EV = `${DRILL}/evidence`;
const env = process.env;
const WEB = 'http://127.0.0.1:8201';
const API = `${WEB}/api/v1`;
const REC_PG = '57433';
const S3 = 'http://127.0.0.1:5555';
const data = JSON.parse(readFileSync(`${EV}/source-data.json`, 'utf8'));
const backup = JSON.parse(readFileSync(`${EV}/ui-backup.json`, 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const checks = [];
let failed = 0;
const check = (name, pass, detail = '') => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failed++;
};
const shot = (page, n) => page.screenshot({ path: `${EV}/screenshots/${n}.png`, fullPage: true });

async function call(method, path, token, body, form) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload = form;
  if (!form && body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + path, { method, headers, body: payload });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j?.data ?? j, raw: t };
}
async function login(company, email, password) {
  const r = await call('POST', '/auth/login-v2', null, { company, email, password });
  return r.json?.accessToken ? r.json.accessToken : null;
}
const sql = (q) => execFileSync('/usr/lib/postgresql/18/bin/psql',
  ['-h', '127.0.0.1', '-p', REC_PG, '-U', 'postgres', '-d', 'tempworks', '-tAX', '-c', q],
  { env: { ...process.env, PGPASSWORD: env.PG_SUPERUSER_PASSWORD }, encoding: 'utf8' }).trim();
const sqlErr = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr || e.message); } };
const s3 = new S3Client({ endpoint: S3, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } });
async function listBucket(b) {
  const out = []; let t;
  do { const r = await s3.send(new ListObjectsV2Command({ Bucket: b, ContinuationToken: t })); out.push(...(r.Contents || [])); t = r.IsTruncated ? r.NextContinuationToken : undefined; } while (t);
  return out;
}
async function objSha(b, k) {
  const r = await s3.send(new GetObjectCommand({ Bucket: b, Key: k }));
  const ch = []; for await (const c of r.Body) ch.push(c); return sha(Buffer.concat(ch));
}

// ── 0. independence from the source ───────────────────────────────────────────
console.log('0) independence from the lost source');
const recEnv = readFileSync(`${DRILL}/recovery/backend.env`, 'utf8');
check('recovery config references no source DB/API/bucket', !/:57432|:3101|src-uploads/.test(recEnv));
let srcUp = true; try { await fetch('http://127.0.0.1:3101/api/docs', { signal: AbortSignal.timeout(2000) }); } catch { srcUp = false; }
check('source API is down', !srcUp);
let srcBucket = true; try { await listBucket('src-uploads'); } catch { srcBucket = false; }
check('source upload bucket is gone', !srcBucket);
if (env.DRILL_RECOVER_IMAGE) {
  // Image mode: the recovered backend IS the production image (no source tree,
  // no npm install); the restore itself also ran from that image.
  const img = JSON.parse(readFileSync(`${EV}/recovery-image.json`, 'utf8'));
  const running = execFileSync('docker', ['inspect', '-f', '{{.Image}} {{.State.Running}} {{.Config.User}}', 'tw-recovered'], { encoding: 'utf8' }).trim().split(' ');
  check('recovered backend runs from the production image (same image id as the restore)', running[0] === img.image && running[1] === 'true',
    `image=${img.image.slice(7, 19)} user=${running[2] || 'root'}`);
  check('recovered backend runs as a non-root user', running[2] && running[2] !== 'root' && running[2] !== '0', running[2]);
  const ilog = readFileSync(`${DRILL}/recovery/backend.log`, 'utf8');
  check('image start path on the recovered DB: migrate deploy → "No pending migrations" → server', /No pending migrations/.test(ilog) && /starting dist\/src\/main\.js/.test(ilog));
  const tgt = JSON.parse(readFileSync(`${EV}/recovery-target.json`, 'utf8'));
  check('restore ran into a FRESH cluster (no source roles) as a NON-superuser admin', tgt.sourceRolesOnFreshCluster === 0 && tgt.restoringRoleSuperuser === false, JSON.stringify(tgt));
  check('recovery upload storage was EMPTY before the restore', JSON.parse(readFileSync(`${EV}/recovery-bucket.json`, 'utf8')).recoveryBucketObjectsBeforeRestore === 0);
  const prereq = JSON.parse(readFileSync(`${DRILL}/recovery/incoming/${backup.package}/database/prerequisites.json`, 'utf8'));
  const needed = prereq.requiredRoles.filter((r) => !/^(postgres|pg_.*)$/.test(r));
  const present = sql(`SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN (${needed.map((r) => `'${r}'`).join(',')})`);
  check('every required role recorded by the backup exists on the recovered cluster', present === [...needed].sort().join(','), present);
  const man = JSON.parse(readFileSync(`${DRILL}/recovery/incoming/${backup.package}/MANIFEST.json`, 'utf8'));
  check('backup was COMPLETE even though pg_dumpall was refused at the source (roles from the catalog)',
    man.recoverability === 'COMPLETE' && man.components.globals.captured === false && man.components.prerequisites.captured === true,
    `recoverability=${man.recoverability} globals=${man.components.globals.captured} prereqs=${man.components.prerequisites.method}`);
} else {
  // fuser prints the PID(s) bound to the recovery API port; inspect its cwd.
  const pids = execFileSync('fuser', ['3201/tcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).filter(Boolean);
  const cwd = pids.length ? execFileSync('readlink', [`/proc/${pids[0]}/cwd`], { encoding: 'utf8' }).trim() : '';
  const rel = JSON.parse(readFileSync(`${DRILL}/recovery/app/RELEASE.json`, 'utf8'));
  check('recovered backend runs from the unpacked release artifact, not the source tree',
    cwd.startsWith(`${DRILL}/recovery/app`), `cwd=${cwd} gitSha=${rel.gitSha.slice(0, 12)}`);
}

{
  // The recovered app must be able to evolve its schema: its boot-time
  // drift-heal (idempotent DDL) has to apply every statement. A database owned
  // by the restoring superuser instead of the app role fails here.
  const blog = readFileSync(`${DRILL}/recovery/backend.log`, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const m = blog.match(/drift-heal: (\d+)\/(\d+) statements applied/);
  check('recovered app can run its schema migrations (boot drift-heal applies all statements)', m && m[1] === m[2], m ? `${m[1]}/${m[2]}` : 'no drift-heal line');
  check('outbound email is disabled in the recovered app', /Emails will NOT be sent/.test(blog));
}

// ── 1. authentication + permissions ────────────────────────────────────────────
console.log('1) login + permissions (original credentials restored with the data)');
const admin = await login('tempworks', env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
check('platform admin logs in with the ORIGINAL password', !!admin);
const hrA = await login('alpha', 'hr@alpha.test', env.TENANT_USER_PASSWORD);
const hrB = await login('beta', 'hr@beta.test', env.TENANT_USER_PASSWORD);
const viewerA = await login('alpha', 'viewer@alpha.test', env.TENANT_USER_PASSWORD);
check('tenant users log in (alpha HR, beta HR, alpha read-only)', hrA && hrB && viewerA);
check('wrong password is rejected', !(await login('alpha', 'hr@alpha.test', 'not-the-password')));
check('cross-tenant login is rejected (alpha user → company beta)', !(await login('beta', 'hr@alpha.test', env.TENANT_USER_PASSWORD)));
const roCreate = await call('POST', '/employees', viewerA, { firstName: 'X', lastName: 'Y', email: 'x@y.test', phone: '+1',
  nationality: 'SK', dateOfBirth: '1990-01-01', addressLine1: 'a', city: 'b', country: 'SK', postalCode: '1' });
check('Read Only user cannot create employees', roCreate.status === 403, `HTTP ${roCreate.status}`);

// ── 2. tenant isolation ───────────────────────────────────────────────────────
console.log('2) tenant isolation');
for (const [slug, tok] of [['alpha', hrA], ['beta', hrB]]) {
  const r = await call('GET', '/employees?limit=200', tok);
  const ids = (r.json.data ?? r.json.items ?? r.json).map((e) => e.id);
  const mine = data.employees.filter((e) => e.tenant === slug).map((e) => e.id);
  const others = data.employees.filter((e) => e.tenant !== slug).map((e) => e.id);
  check(`${slug} sees all ${mine.length} of its recovered employees`, mine.every((i) => ids.includes(i)));
  check(`${slug} sees none of the other tenant's employees`, !others.some((i) => ids.includes(i)));
}
const betaEmp = data.employees.find((e) => e.tenant === 'beta');
const cross = await call('GET', `/employees/${betaEmp.id}`, hrA);
check('direct cross-tenant record access is denied', [403, 404].includes(cross.status), `HTTP ${cross.status}`);
const betaDoc = data.documents.find((d) => d.tenant === 'beta');
const crossFile = await fetch(`${API}/documents/${betaDoc.id}/file`, { headers: { Authorization: `Bearer ${hrA}` } });
check('cross-tenant attachment download is denied', [403, 404].includes(crossFile.status), `HTTP ${crossFile.status}`);
{
  // Bulk ZIP must silently drop the other tenant's file.
  const alphaDoc = data.documents.find((d) => d.tenant === 'alpha');
  const r = await fetch(`${API}/documents/bulk-download`, { method: 'POST',
    headers: { Authorization: `Bearer ${hrA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [alphaDoc.id, betaDoc.id] }) });
  const AdmZip = createRequire(import.meta.url)('adm-zip');
  const entries = r.status === 200 ? new AdmZip(Buffer.from(await r.arrayBuffer())).getEntries().filter((e) => !e.isDirectory) : [];
  check('bulk ZIP download excludes the other tenant\'s file', r.status === 200 && entries.length === 1, `HTTP ${r.status}, ${entries.length} file(s)`);
}

// ── 3. existing attachments + recovery point ───────────────────────────────────
console.log('3) existing attachments, storage references, recovery point');
for (const d of data.documents) {
  const tok = d.tenant === 'alpha' ? hrA : hrB;
  const r = await fetch(`${API}/documents/${d.id}/file`, { headers: { Authorization: `Bearer ${tok}` } });
  const got = sha(Buffer.from(await r.arrayBuffer()));
  check(`attachment "${d.name}" downloads byte-identical`, r.status === 200 && got === d.sha256, `HTTP ${r.status}`);
}
const urls = sql(`SELECT count(*) FILTER (WHERE "fileUrl" LIKE '${S3}/rec-uploads/%'), count(*) FILTER (WHERE "fileUrl" LIKE '%src-uploads%') FROM documents`).split('|');
check('every document fileUrl points at the RECOVERY bucket (remapped)', urls[1] === '0' && Number(urls[0]) > 0, `rec=${urls[0]} src=${urls[1]}`);
for (const p of data.photos) {
  const url = sql(`SELECT "photoUrl" FROM employees WHERE id='${p.employeeId}'`);
  const r = await fetch(url);
  const got = sha(Buffer.from(await r.arrayBuffer()));
  check(`profile photo (${p.tenant}) is the one captured at the recovery point`, r.status === 200 && got === p.sha256 && url.includes('/rec-uploads/'));
}
const later = Number(sql(`SELECT count(*) FROM documents WHERE name LIKE 'Load-%' OR name LIKE '%during-backup%'`));
check('records written AFTER the backup are absent (recovery point = backup snapshot)', later === 0, `${later} found`);
const softDeleted = sql(`SELECT "deletedAt" IS NULL FROM documents WHERE id='${data.documents.find((d) => d.tenant === 'alpha').id}'`);
check('document soft-deleted after the backup is active again (state as of the snapshot)', softDeleted === 't');

// ── 4. business workflows: create, update, upload ─────────────────────────────
console.log('4) business workflows on the recovered system');
const alphaEmp = data.employees.find((e) => e.tenant === 'alpha');
const docs = await call('GET', `/employees/${alphaEmp.id}/documents`, hrA);
check('employee profile documents list loads', docs.status === 200 && (docs.json.length ?? docs.json.data?.length) >= 2);
const maxBefore = sql(`SELECT max("employeeNumber") FROM employees`);
const created = await call('POST', '/employees', hrA, { firstName: 'Post', lastName: 'Recovery', email: 'post.recovery@alpha.test',
  phone: '+421905555555', nationality: 'SK', dateOfBirth: '1995-05-05', addressLine1: 'Nova 1', city: 'Nitra', country: 'Slovakia', postalCode: '94901' });
check('create employee succeeds', created.status === 201, `HTTP ${created.status}`);
check('employee number continues the sequence (no collision)', created.json.employeeNumber > maxBefore, `${maxBefore} → ${created.json.employeeNumber}`);
const upd = await call('PATCH', `/employees/${created.json.id}`, hrA, { city: 'Trnava' });
const reread = await call('GET', `/employees/${created.json.id}`, hrA);
check('update employee persists', upd.status === 200 && reread.json.city === 'Trnava');
const types = (await call('GET', '/settings/document-types', admin)).json;
const bytes = Buffer.from(`%PDF-1.4\n% post-recovery upload\n${randomBytes(300).toString('base64')}\n%%EOF\n`);
const f = new FormData(); f.append('file', new Blob([bytes], { type: 'application/pdf' }), 'post-recovery.pdf');
f.append('name', 'Post-recovery contract'); f.append('documentTypeId', types[0].id); f.append('entityType', 'EMPLOYEE'); f.append('entityId', created.json.id);
const up = await call('POST', '/documents/upload', hrA, undefined, f);
check('new upload accepted', up.status === 201, `HTTP ${up.status}`);
check('new upload stored in the recovery bucket', (up.json.fileUrl || '').startsWith(`${S3}/rec-uploads/`));
const back = await fetch(`${API}/documents/${up.json.id}/file`, { headers: { Authorization: `Bearer ${hrA}` } });
check('new upload downloads byte-identical', sha(Buffer.from(await back.arrayBuffer())) === sha(bytes));

// ── 5. database integrity on the recovered instance ────────────────────────────
console.log('5) database ownership, grants, constraints, sequences');
check('all public tables owned by the app role', sql(`SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname='public'`) === 'tempworks_app');
const grants = Number(sql(`SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='tempworks_readonly' AND privilege_type='SELECT'`));
check('read-only role grants restored', grants >= 80, `${grants} table grants`);
check('foreign-key constraint enforced', /23503|foreign key/i.test(sqlErr(`INSERT INTO documents (id,name,"documentTypeId","entityType","entityId","fileUrl","mimeType","fileSize","uploadedById","updatedAt") VALUES ('fk-test','x','no-such-type','EMPLOYEE','x','x','x',1,'no-such-user',now())`) || ''));
check('unique constraint enforced', /23505|duplicate key/i.test(sqlErr(`INSERT INTO users (id,email,"passwordHash","firstName","lastName","roleId","agencyId","updatedAt") SELECT 'dup-test', email, 'x','x','x',"roleId","agencyId",now() FROM users LIMIT 1`) || ''));
const seqs = sql(`SELECT string_agg(sequencename, ',') FROM pg_sequences WHERE schemaname='public'`);
check('identity/serial sequences advance', seqs.split(',').every((s) => Number(sql(`SELECT nextval('"${s}"')`)) > 0), seqs);
const runningLeft = Number(sql(`SELECT count(*) FROM system_backups WHERE status='RUNNING'`));
const imported = sql(`SELECT status||'|'||"verifyResult"||'|'||("restoreTestedAt" IS NOT NULL) FROM system_backups WHERE id='${backup.id}'`);
check('backup catalog reconstructed: restored package = COMPLETED|VERIFIED|restore-tested', imported === 'COMPLETED|VERIFIED|true', imported);
check('no orphaned RUNNING rows in the recovered catalog', runningLeft === 0);
{
  const row = (await call('GET', `/backup/${backup.id}`, admin)).json;
  check('recovered catalog row describes the package (kind, file count, size, off-site source)',
    row.kind === 'FULL_SYSTEM' && row.uploadsCount === backup.uploadsCount && row.fileSize > 0 && row.offsiteStatus === 'VERIFIED',
    `kind=${row.kind} files=${row.uploadsCount} size=${row.fileSize} offsite=${row.offsiteStatus}`);
  const rv = (await call('POST', `/backup/${backup.id}/verify`, admin)).json;
  check('recovered system re-verifies the package it was restored from', rv.verified === true);
}

// ── 6. file inventory parity with the captured backup ──────────────────────────
console.log('6) file inventory + checksum parity with the backup package');
const pkgTar = `${DRILL}/recovery/incoming/${backup.package}.tar.gz`;
const manifest = backup.engine === 'stream'
  // Bucket-native snapshot: materialized on the recovery host as a package directory.
  ? JSON.parse(readFileSync(`${DRILL}/recovery/incoming/${backup.package}/uploads.manifest.json`, 'utf8'))
  : JSON.parse(execFileSync('tar', ['-xzOf', pkgTar, `${backup.package}/uploads.manifest.json`], { encoding: 'utf8' }));
const objs = new Map((await listBucket('rec-uploads')).map((o) => [o.Key, o]));
let missing = 0, mismatch = 0;
for (const fl of manifest.files) {
  if (!objs.has(fl.key)) { missing++; continue; }
  if ((await objSha('rec-uploads', fl.key)) !== fl.sha256) mismatch++;
}
check(`all ${manifest.files.length} captured files present in recovery storage with identical SHA-256`, missing === 0 && mismatch === 0, `missing=${missing} mismatch=${mismatch}`);

// ── 7. the recovered UI ────────────────────────────────────────────────────────
console.log('7) recovered UI (browser)');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(30000);
try {
  await page.goto(`${WEB}/login`);
  await page.fill('#company', 'alpha'); await page.fill('#email', 'hr@alpha.test');
  await page.fill('#password', env.TENANT_USER_PASSWORD); await page.click('button[type=submit]');
  await page.waitForURL(/\/dashboard/);
  check('UI login (tenant alpha HR) reaches the dashboard', true);
  await shot(page, '10-recovered-dashboard-alpha');
  await page.goto(`${WEB}/dashboard/employees`);
  await page.getByText(alphaEmp.name.split(' ')[1]).first().waitFor();
  const html = await page.content();
  check('UI employee list shows alpha employees only', html.includes(alphaEmp.name.split(' ')[1]) && !html.includes(betaEmp.name.split(' ')[1]));
  await shot(page, '11-recovered-employees-alpha');
  await page.goto(`${WEB}/dashboard/employees/${alphaEmp.id}`);
  await page.getByRole('tab', { name: /Documents/i }).click();
  const firstDoc = data.documents.find((d) => d.employeeId === alphaEmp.id);
  await page.getByText(firstDoc.name).first().waitFor();
  await shot(page, '12-recovered-employee-documents');
  const href = await page.locator('a[download]').first().getAttribute('href');
  const dl = await fetch(href.startsWith('http') ? href : `${WEB}${href}`);
  const dlSha = sha(Buffer.from(await dl.arrayBuffer()));
  check('UI "Download" link serves an original attachment from recovery storage',
    dl.status === 200 && href.includes('/rec-uploads/') && data.documents.some((d) => d.sha256 === dlSha), href);
  // Upload a new file through the UI form.
  await page.getByRole('button', { name: /Upload/i }).first().click();
  const form = page.locator('div.border.rounded-lg').filter({ has: page.locator('input[type=file]') }).first();
  await form.getByRole('combobox').first().click();
  await page.getByRole('option').first().click();
  await form.locator('input:not([type=file]):not([type=date]):not([type=checkbox])').first().fill('UI upload after recovery');
  const uiBytes = Buffer.from(`%PDF-1.4\n% ui upload\n${randomBytes(200).toString('base64')}\n%%EOF\n`);
  await form.locator('input[type=file]').setInputFiles({ name: 'ui-upload.pdf', mimeType: 'application/pdf', buffer: uiBytes });
  await form.getByRole('button', { name: /Upload/i }).last().click();
  await page.getByText('UI upload after recovery').first().waitFor({ timeout: 30000 });
  await shot(page, '13-recovered-ui-upload');
  const row = sql(`SELECT id||'|'||"fileUrl" FROM documents WHERE name='UI upload after recovery'`).split('|');
  const uiBack = await fetch(`${API}/documents/${row[0]}/file`, { headers: { Authorization: `Bearer ${hrA}` } });
  check('file uploaded through the recovered UI is stored + served byte-identical',
    row[1].includes('/rec-uploads/') && sha(Buffer.from(await uiBack.arrayBuffer())) === sha(uiBytes));
  // Admin: backup page shows the reconstructed catalog.
  await page.context().clearCookies(); await page.evaluate(() => localStorage.clear());
  await page.goto(`${WEB}/login`);
  await page.fill('#company', 'tempworks'); await page.fill('#email', env.ADMIN_EMAIL);
  await page.fill('#password', env.ADMIN_PASSWORD); await page.click('button[type=submit]');
  await page.waitForURL(/\/dashboard/);
  await page.goto(`${WEB}/dashboard/settings/database-backup`);
  await page.getByText(backup.package).first().waitFor();
  await shot(page, '14-recovered-backup-catalog');
  check('recovered admin UI shows the restored backup in its catalog', true);
} catch (e) {
  check('recovered UI flow', false, String(e.message || e).split('\n')[0]);
  await shot(page, '99-ui-failure').catch(() => {});
} finally { await browser.close(); }

writeFileSync(`${EV}/recovery-verification.json`, JSON.stringify({ passed: checks.length - failed, failed, checks }, null, 2));
console.log(`\nRECOVERY VERIFICATION: ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
