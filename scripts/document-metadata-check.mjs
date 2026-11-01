#!/usr/bin/env node
/**
 * Document-type metadata requirement regression check.
 *
 * Locks in:
 *  1. The centralized rule set exists on both sides (backend + frontend
 *     mirror) and Passport requires issueDate + expiryDate.
 *  2. Backend create() AND update() enforce it via assertDocumentMetadata
 *     (so a crafted API payload can't bypass the form).
 *  3. The Upload + Edit forms consume getRequiredDocumentMetadataFields.
 *  4. The validation messages are seeded in every locale.
 *  5. Document Explorer still renders expiry via doc.expiryDate + formatDate
 *     (guards the display fix from regressing to a wrong field name).
 *
 * Static (no DB / no jest). Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// 1. Centralized rules on both sides.
for (const [label, rel] of [
  ['backend', 'backend/src/documents/document-metadata-rules.ts'],
  ['frontend', 'src/app/utils/documentMetadataRules.ts'],
]) {
  const src = read(rel);
  if (!/DOCUMENT_TYPE_METADATA_REQUIREMENTS/.test(src)) {
    fail(`${rel}: missing DOCUMENT_TYPE_METADATA_REQUIREMENTS`);
  } else if (!/PASSPORT:\s*\[[^\]]*'issueDate'[^\]]*'expiryDate'/.test(src)) {
    fail(`${rel}: PASSPORT must require issueDate + expiryDate`);
  } else {
    ok(`${label} rules: Passport requires issueDate + expiryDate`);
  }
}

// 2. Backend create() + update() enforce it.
{
  const src = read('backend/src/documents/documents.service.ts');
  if (!/assertDocumentMetadata/.test(src)) {
    fail('documents.service.ts: does not call assertDocumentMetadata');
  } else {
    for (const fn of ['async create(', 'async update(']) {
      const i = src.indexOf(fn);
      const slice = i === -1 ? '' : src.slice(i, i + 1600);
      if (!slice.includes('assertDocumentMetadata')) {
        fail(`documents.service.ts: ${fn}…) does not enforce assertDocumentMetadata`);
      } else {
        ok(`documents.service.ts ${fn}…) enforces required metadata`);
      }
    }
  }
}

// 3. Forms consume the helper.
for (const rel of [
  'src/app/pages/documents/DocumentUpload.tsx',
  'src/app/pages/documents/EditDocument.tsx',
]) {
  const src = read(rel);
  if (!/getRequiredDocumentMetadataFields/.test(src) || !/requiredFields/.test(src)) {
    fail(`${rel}: not wired to getRequiredDocumentMetadataFields/requiredFields`);
  } else {
    ok(`${rel.split('/').pop()}: enforces per-type required metadata`);
  }
}

// 4. Locale messages.
for (const loc of ['en', 'ar', 'de', 'ru', 'sk', 'tr']) {
  const j = JSON.parse(read(`src/i18n/locales/${loc}/errors.json`));
  const v = j?.validation ?? {};
  const missing = ['ISSUE_DATE_REQUIRED', 'EXPIRY_DATE_REQUIRED', 'DOCUMENT_NUMBER_REQUIRED'].filter((k) => typeof v[k] !== 'string');
  if (missing.length) fail(`locale ${loc}: errors.validation missing ${missing.join(', ')}`);
  else ok(`locale ${loc}: date-required validation messages present`);
}

// 5. Explorer display guard.
{
  const src = read('src/app/pages/documents/EmployeeDocumentExplorer.tsx');
  if (!/doc\.expiryDate\s*\?\s*formatDate\(doc\.expiryDate\)/.test(src)) {
    fail('EmployeeDocumentExplorer.tsx: expiry cell must render doc.expiryDate via formatDate');
  } else {
    ok('EmployeeDocumentExplorer.tsx: expiry renders doc.expiryDate via formatDate');
  }
}

if (problems > 0) { console.log(`\n${problems} document-metadata issue(s) found.`); process.exit(1); }
console.log('\nAll document-metadata checks passed.');
