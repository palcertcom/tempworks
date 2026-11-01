#!/usr/bin/env node
// Scheduled backups: verifies the schedule is ACTIVE, that a scheduled run is
// SKIPPED (not overlapped) while another operation holds the cross-instance
// lock, and that the next scheduled run completes + verifies + goes off-site.
//
// Usage: node schedule-test.mjs <apiBase> <evidenceDir> <pgPort>
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [API, EV, PGPORT] = process.argv.slice(2);
const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const fail = (m) => { console.error(`✗ ${m}`); writeFileSync(`${EV}/schedule.json`, JSON.stringify({ ...out, error: m }, null, 2)); process.exit(1); };
const ok = (m) => console.log(`  ✓ ${m}`);
const tok = (await (await fetch(`${API}/auth/login-v2`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ company: 'tempworks', email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) })).json()).accessToken;
const get = async (p) => { const r = await (await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${tok}` } })).json(); return r.data ?? r; };
const sql = (q) => execFileSync('/usr/lib/postgresql/18/bin/psql', ['-h', '127.0.0.1', '-p', PGPORT, '-U', 'tempworks_app', '-d', 'tempworks', '-tAX', '-c', q],
  { env: { ...process.env, PGPASSWORD: env.APP_DB_PASSWORD }, encoding: 'utf8' }).trim();

const s0 = await get('/backup/schedule');
out.config = { active: s0.active, cron: s0.cron, timezone: s0.timezone, kind: s0.kind, nextRun: s0.nextRun, staleHours: s0.staleHours, retentionCount: s0.retentionCount };
if (!s0.active) fail('schedule not active');
ok(`schedule ACTIVE: cron "${s0.cron}" (${s0.timezone}), kind ${s0.kind}, next run ${s0.nextRun}`);

// 1) Hold the advisory lock across the next tick → the scheduled run must be SKIPPED.
const msToNextMinute = 60_000 - (Date.now() % 60_000);
const holdSecs = Math.ceil(msToNextMinute / 1000) + 20;
const holder = spawn('/usr/lib/postgresql/18/bin/psql', ['-h', '127.0.0.1', '-p', PGPORT, '-U', 'tempworks_app', '-d', 'tempworks', '-c',
  `SELECT pg_advisory_lock(7243008153); SELECT pg_sleep(${holdSecs});`], { env: { ...process.env, PGPASSWORD: env.APP_DB_PASSWORD }, stdio: 'ignore' });
console.log(`  · holding the backup lock for ${holdSecs}s across the next scheduled tick…`);
await sleep(msToNextMinute + 12_000);
const s1 = await get('/backup/schedule');
out.whileLocked = s1.lastRun;
if (s1.lastRun?.outcome !== 'SKIPPED_BUSY') fail(`expected SKIPPED_BUSY while locked, got ${JSON.stringify(s1.lastRun)}`);
const audited = Number(sql(`SELECT count(*) FROM audit_logs WHERE action='BACKUP_SCHEDULE_SKIPPED'`));
if (audited < 1) fail('skip was not audited');
ok(`tick while another operation held the lock → SKIPPED_BUSY (no overlap), audited (${audited} entr${audited === 1 ? 'y' : 'ies'})`);
await new Promise((r) => holder.on('close', r));

// 2) Next tick with the lock free → completes, auto-verifies, goes off-site.
let s2;
for (let i = 0; i < 150; i++) {
  s2 = await get('/backup/schedule');
  if (s2.lastRun && !['SKIPPED_BUSY', 'STARTED'].includes(s2.lastRun.outcome)) break;
  await sleep(1000);
}
out.nextRun = s2.lastRun;
if (s2.lastRun?.outcome !== 'COMPLETED') fail(`scheduled run did not complete: ${JSON.stringify(s2.lastRun)}`);
const b = await get(`/backup/${s2.lastRun.backupId}`);
out.scheduledBackup = { id: b.id, status: b.status, kind: b.kind, verifyResult: b.verifyResult, offsiteStatus: b.offsiteStatus, notes: b.notes };
if (b.verifyResult !== 'VERIFIED' || b.offsiteStatus !== 'VERIFIED') fail(`scheduled backup not verified/off-site: ${JSON.stringify(out.scheduledBackup)}`);
ok(`next scheduled run: ${b.status} ${b.kind}, integrity ${b.verifyResult}, off-site ${b.offsiteStatus} (notes "${b.notes}")`);
const s3 = await get('/backup/schedule');
out.staleness = { stale: s3.stale, newestVerifiedAgeHours: s3.newestVerifiedAgeHours };
if (s3.stale) fail('status reports stale right after a verified backup');
ok(`staleness: not stale (newest verified backup ${(s3.newestVerifiedAgeHours * 60).toFixed(1)} min old, limit ${s3.staleHours} h)`);
writeFileSync(`${EV}/schedule.json`, JSON.stringify(out, null, 2));
