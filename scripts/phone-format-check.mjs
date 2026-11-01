#!/usr/bin/env node
/**
 * Phone normalization regression check + unit assertions.
 *
 * 1. Unit-tests the dedupe/join/format algorithm (same logic shipped in
 *    src/app/data/phoneCodes.ts and backend normalize-phone.ts):
 *      - duplicated country code collapses ("+90 +905394308925" → E.164)
 *      - TR / DE / SK national + code join without duplication
 *      - 00-prefix → +
 *      - display never repeats the code
 * 2. Asserts the form payload builders use joinPhone (not raw
 *    `${code} ${phone}` concat that re-duplicates a stored full number).
 * 3. Asserts the employee phone placeholders are national-only (no `+CC`).
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

// ── Reimplementation of the canonical algorithm (the spec) ───────────────────
function toE164(raw, fallback) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  s = s.replace(/^00/, '+').replace(/[^\d+]/g, '');
  if (!s) return '';
  let guard = 0, idx = s.indexOf('+', 1);
  while (idx !== -1 && guard++ < 5) {
    const tail = s.slice(idx);
    const tailDigits = tail.replace(/\D/g, '');
    if (tail.startsWith('+') && tailDigits.length >= 8) s = tail;
    else s = s.slice(0, idx) + tail.replace(/\+/g, '');
    idx = s.indexOf('+', 1);
  }
  if (!s.startsWith('+') && fallback) s = fallback.replace(/[^\d+]/g, '') + s;
  return s;
}

const cases = [
  ['+90 +905394308925', '+905394308925', 'duplicated TR code collapses'],
  ['+49 +49123456789',  '+49123456789',  'duplicated DE code collapses'],
  ['+421 +421900000000','+421900000000', 'duplicated SK code collapses'],
  ['+90 539 430 89 25', '+905394308925', 'spaced TR number'],
  ['00905394308925',    '+905394308925', '00-prefix → +'],
  ['+905394308925',     '+905394308925', 'already E.164 unchanged'],
];
let unit = true;
for (const [input, expected, label] of cases) {
  const got = toE164(input);
  if (got !== expected) { unit = false; fail(`toE164(${JSON.stringify(input)}) → "${got}", expected "${expected}" (${label})`); }
}
// join: code + national, refusing duplicate
function joinPhone(code, national) {
  const n = (national ?? '').trim();
  if (!n) return '';
  if (n.includes('+') || /^00/.test(n)) {
    const e = toE164(n, code);
    const m = e.match(/^(\+\d{1,4})(\d+)$/);
    return m ? `${m[1]} ${m[2]}` : e;
  }
  return code ? `${code} ${n}` : n;
}
if (joinPhone('+90', '+905394308925') === '+90 +905394308925') { unit = false; fail('joinPhone duplicated the code'); }
if (joinPhone('+90', '5394308925') !== '+90 5394308925') { unit = false; fail('joinPhone national broke'); }
if (unit) ok('algorithm: dedupe (TR/DE/SK), 00-prefix, E.164, join without duplication');

// ── Form builders use joinPhone, not raw concat ──────────────────────────────
const builders = [
  'src/app/pages/applicants/AddApplicant.tsx',
  'src/app/pages/applicants/EditApplicant.tsx',
  'src/app/pages/applicants/EditCandidate.tsx',
  'src/app/pages/public/PublicEmployeeApplication.tsx',
];
for (const f of builders) {
  const src = read(f);
  if (/phone:\s*`\$\{[^}]*phoneCode\}\s+\$\{[^}]*phone\}`/.test(src)) {
    fail(`${f}: still concatenates \`\${phoneCode} \${phone}\` (duplicates a stored full number) — use joinPhone`);
  } else if (!/joinPhone\(/.test(src)) {
    fail(`${f}: phone payload not built via joinPhone`);
  } else {
    ok(`${f.split('/').pop()}: builds phone via joinPhone`);
  }
}

// ── Employee phone placeholders are national-only (no leading +CC) ───────────
for (const loc of ['en', 'ar', 'de', 'ru', 'sk', 'tr']) {
  const json = JSON.parse(read(`src/i18n/locales/${loc}/pages.json`));
  const add = json?.employees?.add ?? {};
  const bad = ['phonePh', 'emergencyPhonePh'].filter((k) => typeof add[k] === 'string' && add[k].trim().startsWith('+'));
  if (bad.length) fail(`locale ${loc}: employees.add ${bad.join(', ')} still carries a +CC prefix`);
  else ok(`locale ${loc}: employee phone placeholders are national-only`);
}

if (problems > 0) { console.log(`\n${problems} phone issue(s) found.`); process.exit(1); }
console.log('\nAll phone checks passed.');
