#!/usr/bin/env node
/**
 * Backend i18n catalog parity + lookup check.
 *
 * Two passes:
 *
 *   1. **Locale parity** — walk every JSON namespace under
 *      `backend/src/common/i18n/locales/en/` and confirm the same key tree
 *      exists in every other locale (ar/de/ru/sk/tr). Mirrors the frontend
 *      `i18n-check-keys.mjs` behaviour, including CLDR plural-suffix
 *      tolerance (`_zero`, `_two`, `_few`, `_many`).
 *
 *   2. **Source lookup parity** — scan every backend `.ts` file under
 *      `backend/src` for `tServer('<key>', ..., '<ns>')` literals and
 *      assert each `<key>` resolves to a string in the EN catalog of the
 *      matching namespace. Catches new code that forgets to add the
 *      catalog entry. Notification `titleKey` / `messageKey` literals on
 *      Prisma `.create` payloads are also checked against the
 *      `notifications` namespace.
 *
 * Run from repo root:
 *   node scripts/i18n-check-backend-keys.mjs
 *
 * Exits 1 on any missing key. Designed to be cheap enough for CI on every PR.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE   = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(HERE, '..');
const LOCALES_DIR = join(ROOT, 'backend', 'src', 'common', 'i18n', 'locales');
const SOURCE_DIR  = join(ROOT, 'backend', 'src');
const SOURCE_LOCALE = 'en';

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
  const raw = readFileSync(join(LOCALES_DIR, locale, file), 'utf8');
  return JSON.parse(raw);
}

function getNested(obj, path) {
  if (obj === null || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return typeof cur === 'string' ? cur : undefined;
}

// ── 1. Locale parity ─────────────────────────────────────────────────────────
const targets = readdirSync(LOCALES_DIR).filter((d) => d !== SOURCE_LOCALE);
const namespaces = readdirSync(join(LOCALES_DIR, SOURCE_LOCALE)).filter((f) => f.endsWith('.json'));

const parityReport = [];
let parityErrors = 0;

for (const ns of namespaces) {
  const sourceTree = loadNs(SOURCE_LOCALE, ns);
  const sourceKeys = normalizeKeys(flatten(sourceTree));
  for (const lc of targets) {
    let targetKeys;
    try {
      targetKeys = normalizeKeys(flatten(loadNs(lc, ns)));
    } catch (err) {
      parityReport.push(`✗ ${lc}/${ns}: ${err.message}`);
      parityErrors++;
      continue;
    }
    const missing = [...sourceKeys].filter((k) => !targetKeys.has(k));
    const extra   = [...targetKeys].filter((k) => !sourceKeys.has(k));
    if (missing.length === 0 && extra.length === 0) continue;
    if (missing.length) parityReport.push(`✗ ${lc}/${ns}: missing ${missing.length} keys → ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`);
    if (extra.length)   parityReport.push(`! ${lc}/${ns}: ${extra.length} extra keys not in EN → ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''}`);
    parityErrors += missing.length;
  }
}

// ── 2. Source-code lookup parity ─────────────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
function walkTs(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, files);
    else if (full.endsWith('.ts')) files.push(full);
  }
  return files;
}

const enCatalogs = Object.fromEntries(namespaces.map((f) => [f.replace(/\.json$/, ''), loadNs(SOURCE_LOCALE, f)]));

// `tServer('<key>', <params>, <locale>, '<ns>')` — namespace is the 4th
// argument. When omitted the runtime defaults to 'notifications'; the regex
// captures both forms.
const TSERVER_RE = /\btServer\(\s*['"`]([^'"`]+)['"`]\s*,[\s\S]*?(?:,\s*['"`](notifications|exports)['"`])?\s*\)/g;

// `titleKey: '<key>'` or `messageKey: '<key>'` literals on Prisma .create
// payloads — always under the `notifications` namespace.
const NOTIF_KEY_RE = /(titleKey|messageKey)\s*:\s*['"`]([^'"`]+)['"`]/g;

const tsFiles = walkTs(SOURCE_DIR);
const lookupErrors = [];

for (const file of tsFiles) {
  const text = readFileSync(file, 'utf8');

  // tServer literals
  TSERVER_RE.lastIndex = 0;
  let m;
  while ((m = TSERVER_RE.exec(text)) !== null) {
    const key = m[1];
    const ns  = m[2] ?? 'notifications';
    // Skip dynamic template-literal keys ('foo.columns.${key}'). These are
    // looked up via runtime closures (col, mcol, etc.) — the script
    // verifies the partial-key literals at the closure call sites would
    // need an AST walker, which is out of scope for this lightweight check.
    if (key.includes('${')) continue;
    if (!enCatalogs[ns]) {
      lookupErrors.push(`✗ ${file}: tServer namespace '${ns}' not found in catalog`);
      continue;
    }
    if (getNested(enCatalogs[ns], key) === undefined) {
      lookupErrors.push(`✗ ${file}: tServer('${key}', …, '${ns}') has no entry in EN catalog`);
    }
  }

  // notification key literals (only valid in producer files; cheap heuristic)
  if (file.includes('notifications.service.ts') || file.includes('documents.service.ts') || file.includes('finance.service.ts')) {
    NOTIF_KEY_RE.lastIndex = 0;
    while ((m = NOTIF_KEY_RE.exec(text)) !== null) {
      const key = m[2];
      // Skip the type-declaration site in notifications.service.ts:
      //   i18n?: { titleKey?: string; messageKey?: string; ... }
      if (/(titleKey|messageKey)\?:\s*string/.test(text.slice(Math.max(0, m.index - 20), m.index + 30))) continue;
      if (getNested(enCatalogs.notifications, key) === undefined) {
        lookupErrors.push(`✗ ${file}: ${m[1]}: '${key}' has no entry in notifications EN catalog`);
      }
    }
  }
}

// ── Output ───────────────────────────────────────────────────────────────────
let exitCode = 0;

if (parityReport.length === 0) {
  console.log(`✓ Backend locale parity: ${targets.length} locales × ${namespaces.length} namespaces match English.`);
} else {
  console.log('Backend locale parity issues:');
  console.log(parityReport.join('\n'));
  exitCode = 1;
}

if (lookupErrors.length === 0) {
  const tsCount = tsFiles.length;
  console.log(`✓ Backend tServer / notification keys: every literal in ${tsCount} .ts files resolves to an EN catalog entry.`);
} else {
  console.log('\nBackend lookup issues:');
  console.log(lookupErrors.slice(0, 50).join('\n'));
  if (lookupErrors.length > 50) console.log(`… and ${lookupErrors.length - 50} more.`);
  exitCode = 1;
}

process.exit(exitCode);
