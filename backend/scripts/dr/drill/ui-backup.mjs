#!/usr/bin/env node
// Triggers a FULL SYSTEM backup through the real admin UI (browser → SPA →
// API → background job → backup.sh → off-site copy) and waits for it to
// finish. Screenshots are written to <evidence>/screenshots.
//
// Usage: node ui-backup.mjs <webOrigin> <evidenceDir>
import { createRequire } from 'node:module';
// Playwright is installed globally (resolved via NODE_PATH by CommonJS require).
const { chromium } = createRequire(import.meta.url)('playwright');
import { writeFileSync } from 'node:fs';

const [WEB, EV] = process.argv.slice(2);
const env = process.env;
const shot = (page, n) => page.screenshot({ path: `${EV}/screenshots/${n}.png`, fullPage: true });
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

async function apiToken() {
  const r = await fetch(`${WEB}/api/v1/auth/login-v2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'tempworks', email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  });
  return (await r.json()).accessToken;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(30000);

// 1. Sign in through the real login page.
await page.goto(`${WEB}/login`);
await page.fill('#company', 'tempworks');
await page.fill('#email', env.ADMIN_EMAIL);
await page.fill('#password', env.ADMIN_PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(/\/dashboard/, { timeout: 30000 });
console.log('  ✓ signed in through the UI as platform admin');

// 2. Open Settings → Database Backup; wait for the preflight banner.
await page.goto(`${WEB}/dashboard/settings/database-backup`);
await page.getByText(/Backup environment (ready|not ready)/).waitFor({ timeout: 60000 });
const preflightOk = await page.getByText(/Backup environment ready/).count() > 0;
await shot(page, '01-source-backup-page-preflight');
console.log(`  ✓ backup page loaded; preflight banner: ${preflightOk ? 'READY' : 'NOT READY'}`);
if (!preflightOk) fail('preflight reported the environment as not ready');

// 3. Create Backup → choose "Full system" → confirm.
const token = await apiToken();
const before = await (await fetch(`${WEB}/api/v1/backup?limit=50`, { headers: { Authorization: `Bearer ${token}` } })).json();
const beforeIds = new Set((before.data ?? []).map((b) => b.id));

await page.getByRole('button', { name: /Create Backup/i }).first().click();
const dialog = page.getByRole('dialog');
await dialog.getByRole('combobox').first().click();
await page.getByRole('option', { name: /Full system/i }).click();
await dialog.locator('input').last().fill('DR drill — triggered from admin UI');
await shot(page, '02-source-create-full-system-dialog');
const t0 = Date.now();
await dialog.getByRole('button', { name: /Create Backup/i }).click();
console.log('  ✓ "Full system" backup requested from the UI');

// 4. Wait for the background job (the HTTP request returned immediately).
let row = null;
for (let i = 0; i < 180; i++) {
  const list = await (await fetch(`${WEB}/api/v1/backup?limit=50`, { headers: { Authorization: `Bearer ${token}` } })).json();
  row = (list.data ?? []).find((b) => !beforeIds.has(b.id));
  if (row && row.status !== 'RUNNING') break;
  await new Promise((r) => setTimeout(r, 1000));
}
const seconds = ((Date.now() - t0) / 1000).toFixed(1);
if (!row) fail('no backup row appeared');
if (row.status !== 'COMPLETED') fail(`backup ended ${row.status}: ${row.errorMessage}`);
console.log(`  ✓ background job finished: ${row.status} in ${seconds}s, kind=${row.kind}, off-site=${row.offsiteStatus}`);

// 5. Verify integrity from the UI (separate state from "created").
await page.reload();
await page.getByText(row.fileName).waitFor();
const tr = page.locator('tr', { hasText: row.fileName });
await tr.getByTitle(/Verify integrity/i).click();
await tr.getByText(/^(Integrity verified|Failed)$/).waitFor({ timeout: 120000 });
await shot(page, '03-source-backup-completed-verified');
const after = await (await fetch(`${WEB}/api/v1/backup/${row.id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
const b = after.data ?? after;
console.log(`  ✓ integrity verified from the UI: ${b.verifyResult}`);
await browser.close();

const meta = b.metadata ?? {};
const out = {
  id: b.id, status: b.status, kind: b.kind, verifyResult: b.verifyResult,
  offsiteStatus: b.offsiteStatus, offsiteLocation: b.offsiteLocation,
  package: (b.fileName || '').replace(/\.tar\.gz$/, ''), fileName: b.fileName, engine: b.engine ?? meta.engine ?? 'staging',
  uploadsCount: meta.uploadsCount, uploadsComplete: meta.uploadsComplete, globalsCaptured: meta.globalsCaptured,
  createdAt: b.createdAt, completedAt: b.completedAt, uiToCompletedSeconds: Number(seconds),
};
writeFileSync(`${EV}/ui-backup.json`, JSON.stringify(out, null, 2));
if (out.verifyResult !== 'VERIFIED') fail('integrity verification did not pass');
if (out.offsiteStatus !== 'VERIFIED') fail(`off-site copy not verified (${out.offsiteStatus})`);
console.log(`backup recorded → ${EV}/ui-backup.json`);
