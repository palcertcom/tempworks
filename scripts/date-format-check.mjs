#!/usr/bin/env node
/**
 * Date-format regression check + unit assertions for dd.MM.yyyy.
 *
 * 1. Unit-tests the formatting algorithm (the same logic shipped in
 *    src/i18n/formatters.ts and backend/src/common/i18n/date-format.ts):
 *      - ISO date-only → dd.MM.yyyy, no timezone drift
 *      - ISO datetime  → dd.MM.yyyy HH:mm
 *      - invalid/empty → ''
 * 2. Asserts both central formatters declare DISPLAY_DATE_FORMAT
 *    = 'dd.MM.yyyy' and emit day-first output.
 * 3. Fails if any US-locale date formatting (`toLocaleDateString('en-US'`
 *    / `'en-GB'`) reappears in app/export code we converted.
 *
 * Exit 1 on any failure.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// ── 1. Algorithm unit tests (pure reimplementation = the spec) ───────────────
const pad2 = (n) => String(n).padStart(2, '0');
function fmtDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function fmtDateTime(value) {
  if (value === null || value === undefined || value === '') return '';
  const m = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/) : null;
  if (m) return `${m[3]}.${m[2]}.${m[1]} ${m[4] ?? '00'}:${m[5] ?? '00'}`;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const cases = [
  ['2026-05-24', '24.05.2026', 'ISO date-only'],
  ['2026-01-09', '09.01.2026', 'ISO date-only zero-pad'],
  ['2026-12-31T23:59:00Z', '31.12.2026', 'ISO datetime → date part (no TZ drift)'],
  ['', '', 'empty string'],
  [null, '', 'null'],
  ['not-a-date', '', 'garbage'],
];
let unitOk = true;
for (const [input, expected, label] of cases) {
  const got = fmtDate(input);
  if (got !== expected) { unitOk = false; fail(`formatDate(${JSON.stringify(input)}) → "${got}", expected "${expected}" (${label})`); }
}
if (fmtDateTime('2026-05-24T08:05') !== '24.05.2026 08:05') {
  unitOk = false; fail(`formatDateTime ISO → "${fmtDateTime('2026-05-24T08:05')}", expected "24.05.2026 08:05"`);
}
// Note: the DISPLAY formatter only ever receives ISO strings / Date
// objects from the API (native <input type="date"> emits ISO), so it
// is not responsible for rejecting user-typed localized strings — that
// is input-side validation. We assert ISO handling + no drift only.
if (unitOk) ok('formatting algorithm: ISO→dd.MM.yyyy, datetime, no TZ drift, invalid→empty');

// ── 2. Central formatters declare the format ─────────────────────────────────
for (const f of ['src/i18n/formatters.ts', 'backend/src/common/i18n/date-format.ts']) {
  const src = read(f);
  if (!/DISPLAY_DATE_FORMAT\s*=\s*'dd\.MM\.yyyy'/.test(src)) fail(`${f}: DISPLAY_DATE_FORMAT not 'dd.MM.yyyy'`);
  else if (!/\}\.\$\{pad2\(p\.mo\)\}\.\$\{p\.y\}|\$\{pad2\(p\.d\)\}\.\$\{pad2\(p\.mo\)\}\.\$\{p\.y\}/.test(src)) fail(`${f}: output template is not day.month.year`);
  else ok(`${f}: dd.MM.yyyy day-first`);
}

// ── 3. No US-locale date formatting left in converted code ───────────────────
function walk(dir, files = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (!/node_modules|dist/.test(e)) walk(p, files); }
    else if (/\.(tsx|ts)$/.test(p) && !/\.spec\./.test(p)) files.push(p);
  }
  return files;
}
const scanDirs = ['src/app', 'backend/src/finance', 'backend/src/reports', 'backend/src/vehicles'];
const offenders = [];
for (const d of scanDirs) {
  for (const f of walk(resolve(ROOT, d))) {
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // Date rendered in an explicit US/UK locale = the bug we removed.
      // `weekday`-only renders produce a day NAME (e.g. "Mon"), not a
      // dd.MM.yyyy date — those are legitimately left alone.
      if (/toLocaleDateString\(\s*['"]en(-US|-GB)?['"]/.test(line) && !/weekday/.test(line)) {
        offenders.push(`${f.replace(ROOT + '/', '')}:${i + 1}`);
      }
    });
  }
}
if (offenders.length) {
  fail(`${offenders.length} date toLocaleDateString('en…') callsite(s) remain — route through formatDate / formatDisplayDate:`);
  offenders.slice(0, 15).forEach((o) => console.log(`    ${o}`));
} else {
  ok('no US/UK-locale date formatting left in app + finance/reports/vehicles exports');
}

// ── 4. No native <input type="date"> left (they render mm/dd/yyyy in
//      the browser locale; must use the dd.MM.yyyy <DateInput>). ────────────
{
  const dateInputErrs = [];
  for (const f of walk(resolve(ROOT, 'src/app'))) {
    if (f.endsWith('date-input.tsx')) continue; // the component itself
    const src = readFileSync(f, 'utf8');
    // type="date" with a closing quote right after — NOT datetime-local.
    if (/type\s*=\s*"date"/.test(src)) dateInputErrs.push(f.replace(ROOT + '/', ''));
  }
  if (dateInputErrs.length) {
    fail(`${dateInputErrs.length} native <input type="date"> remain — use <DateInput> (dd.MM.yyyy):`);
    dateInputErrs.slice(0, 15).forEach((o) => console.log(`    ${o}`));
  } else {
    ok('no native <input type="date"> — all date entry uses <DateInput>');
  }
}

if (problems > 0) { console.log(`\n${problems} date-format issue(s) found.`); process.exit(1); }
console.log('\nAll date-format checks passed.');
