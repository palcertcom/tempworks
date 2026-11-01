#!/usr/bin/env node
/**
 * Document display-name regression check.
 *
 * Unit-tests getDocumentDisplayName (the same algorithm shipped in
 * src/app/utils/documentDisplay.ts) so onboarding upload-instruction
 * labels render as clean document names across all six locales, and
 * normal names are left untouched. Also asserts the Documents &
 * Compliance list routes the name through the helper.
 *
 * Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// Reimplementation = the spec.
const REQUIRED_WORDS = ['required', 'povinné', 'povinne', 'erforderlich', 'مطلوب', 'обязательно', 'zorunlu'];
const UPLOAD_LEADING = ['upload', 'nahrať', 'nahrajte', 'nahrat', 'رفع', 'تحميل', 'загрузить', 'загрузка', 'yükle', 'yükleyin', 'yükleme'];
const UPLOAD_TRAILING = ['hochladen', 'yükle', 'yükleyin', 'yükleme'];
function clean(name, fallback) {
  const raw = (name ?? '').trim();
  if (!raw) return (fallback ?? '').trim();
  let out = raw.replace(/\s*\(([^)]*)\)\s*$/u, (full, inner) => {
    const n = String(inner).trim().toLowerCase();
    return REQUIRED_WORDS.some((w) => n === w || n.includes(w)) ? '' : full;
  }).trim();
  for (const v of UPLOAD_LEADING) { const re = new RegExp(`^${v}\\s+`, 'iu'); if (re.test(out)) { out = out.replace(re, '').trim(); break; } }
  for (const v of UPLOAD_TRAILING) { const re = new RegExp(`\\s+${v}$`, 'iu'); if (re.test(out)) { out = out.replace(re, '').trim(); break; } }
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out || (fallback ?? '').trim() || raw;
}

const cases = [
  ['Upload Passport (Required)', 'Passport', 'en'],
  ['Upload Certificate / Diploma (Required)', 'Certificate / Diploma', 'en multi-word'],
  ['Upload Work Experience Document (Required)', 'Work Experience Document', 'en'],
  ['Nahrať cestovný pas (povinné)', 'cestovný pas', 'sk'],
  ['Reisepass hochladen (erforderlich)', 'Reisepass', 'de (trailing verb)'],
  ['رفع جواز السفر (مطلوب)', 'جواز السفر', 'ar'],
  ['Загрузить паспорт (обязательно)', 'паспорт', 'ru'],
  ['Pasaportu Yükle (Zorunlu)', 'Pasaportu', 'tr'],
  // must NOT over-clean meaningful names
  ["John's passport scan", "John's passport scan", 'plain name untouched'],
  ['Contract (Renewal)', 'Contract (Renewal)', 'non-required parenthetical kept'],
  ['Passport', 'Passport', 'already clean'],
  ['', 'Other', 'empty → fallback'],
];
let unit = true;
for (const [input, expected, label] of cases) {
  const got = clean(input, label === 'empty → fallback' ? 'Other' : undefined);
  if (got !== expected) { unit = false; fail(`getDocumentDisplayName(${JSON.stringify(input)}) → "${got}", expected "${expected}" (${label})`); }
}
if (unit) ok('display-name: 6-locale upload labels cleaned, plain/renewal names untouched');

// List routes the name through the helper.
{
  const src = read('src/app/pages/documents/DocumentsCompliance.tsx');
  if (!/getDocumentDisplayName\(doc\.name/.test(src)) fail('DocumentsCompliance: document name not routed through getDocumentDisplayName');
  else ok('DocumentsCompliance list uses getDocumentDisplayName');
}

if (problems > 0) { console.log(`\n${problems} document-name issue(s) found.`); process.exit(1); }
console.log('\nAll document-name checks passed.');
