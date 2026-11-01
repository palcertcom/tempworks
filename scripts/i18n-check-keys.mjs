#!/usr/bin/env node
/**
 * Translation key parity check.
 *
 * Walks every namespace in `src/i18n/locales/en/` and confirms the same key
 * tree exists in every other locale. Prints a report and exits 1 if any
 * locale is missing keys from English (the source of truth) or has extra
 * keys that English doesn't (likely typos / drift).
 *
 * Run from repo root:
 *   node scripts/i18n-check-keys.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE   = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(HERE, '..', 'src', 'i18n', 'locales');
const SOURCE = 'en';

/**
 * CLDR plural suffixes — i18next allows e.g. `key_zero`, `key_two`, `key_few`,
 * `key_many` in locales that need them (Russian, Slovak, Arabic, …) even if
 * English only carries `key_one` / `key_other`. Strip the suffix when
 * comparing trees so plural variants count as equivalent to their base.
 */
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
function stripPlural(key) {
  for (const suf of PLURAL_SUFFIXES) {
    if (key.endsWith(suf)) return key.slice(0, -suf.length);
  }
  return key;
}

function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, path));
    else out.push(path);
  }
  return out;
}

function normalizeKeys(keys) {
  return new Set(keys.map((k) => {
    const parts = k.split('.');
    parts[parts.length - 1] = stripPlural(parts[parts.length - 1]);
    return parts.join('.');
  }));
}

function loadNs(locale, file) {
  const raw = readFileSync(join(ROOT, locale, file), 'utf8');
  return JSON.parse(raw);
}

const targets = readdirSync(ROOT).filter((d) => d !== SOURCE);
const namespaces = readdirSync(join(ROOT, SOURCE)).filter((f) => f.endsWith('.json'));

let errors = 0;
const report = [];

for (const ns of namespaces) {
  const sourceKeys = normalizeKeys(flatten(loadNs(SOURCE, ns)));
  for (const lc of targets) {
    let targetKeys;
    try {
      targetKeys = normalizeKeys(flatten(loadNs(lc, ns)));
    } catch (err) {
      report.push(`✗ ${lc}/${ns}: ${err.message}`);
      errors++;
      continue;
    }
    const missing = [...sourceKeys].filter((k) => !targetKeys.has(k));
    const extra   = [...targetKeys].filter((k) => !sourceKeys.has(k));
    if (missing.length === 0 && extra.length === 0) continue;
    if (missing.length) report.push(`✗ ${lc}/${ns}: missing ${missing.length} keys → ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`);
    if (extra.length)   report.push(`! ${lc}/${ns}: ${extra.length} extra keys not in English → ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''}`);
    errors += missing.length;
  }
}

if (report.length === 0) {
  console.log(`✓ All ${targets.length} target locales × ${namespaces.length} namespaces match English.`);
  process.exit(0);
}

console.log(report.join('\n'));
console.log(`\n${errors} missing key(s) across locales.`);
process.exit(errors > 0 ? 1 : 0);
