#!/usr/bin/env node
/**
 * Error-message placement check.
 *
 * Locks in the rules from the "errors at the TOP" refactor:
 *
 *   1. sonner Toaster is configured for `top-center` so transient
 *      errors don't sink below the fold.
 *   2. The shared <ErrorBanner> component exists, declares
 *      role="alert", and aria-live="assertive".
 *   3. The high-impact public pages migrated to <ErrorBanner> still
 *      import it and don't regress to the old `text-red-600 bg-red-50
 *      border border-red-200 rounded-md p-3` ad-hoc div pattern.
 *   4. Every locale carries the `banner.title / banner.retry /
 *      banner.dismiss` keys.
 *
 * Exit 1 on any violation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// ── 1. Toaster position ──────────────────────────────────────────────────────
{
  const src = read('src/app/components/ui/sonner.tsx');
  if (!/position\s*=\s*["']top-center["']/.test(src)) {
    fail('sonner.tsx: <Toaster> is not configured for top-center');
  } else {
    ok('sonner.tsx: <Toaster> position="top-center"');
  }
}

// ── 2. ErrorBanner component ─────────────────────────────────────────────────
{
  const src = read('src/app/components/ui/error-banner.tsx');
  if (!/role="alert"/.test(src)) fail('error-banner.tsx: missing role="alert"');
  if (!/aria-live="assertive"/.test(src)) fail('error-banner.tsx: missing aria-live="assertive"');
  if (!/export function ErrorBanner/.test(src)) fail('error-banner.tsx: ErrorBanner not exported');
  if (problems === 0) ok('error-banner.tsx: role/aria-live/export all present');
}

// ── 3. Migrated pages still use ErrorBanner + no stale ad-hoc divs ───────────
const migrated = [
  'src/app/pages/public/LoginPage.tsx',
  'src/app/pages/public/ResetPasswordPage.tsx',
  'src/app/pages/public/ActivationPage.tsx',
  'src/app/pages/public/JobListings.tsx',
  'src/app/pages/pipelines/WorkflowsPage.tsx',
];
for (const rel of migrated) {
  const src = read(rel);
  if (!/import\s+\{\s*ErrorBanner\s*\}/.test(src)) {
    fail(`${rel}: missing ErrorBanner import`);
    continue;
  }
  if (!/<ErrorBanner\b/.test(src)) {
    fail(`${rel}: ErrorBanner imported but never used`);
    continue;
  }
  // Old ad-hoc pattern must not reappear on these pages.
  if (/text-red-600 bg-red-50 border border-red-200 rounded-md p-3/.test(src)) {
    fail(`${rel}: still uses the old "text-red-600 bg-red-50 ..." ad-hoc error div`);
    continue;
  }
  ok(`${rel}: uses ErrorBanner`);
}

// ── 4. Locale coverage ───────────────────────────────────────────────────────
const localesDir = resolve(ROOT, 'src/i18n/locales');
const locales = readdirSync(localesDir).filter((d) => d !== 'pseudo');
for (const loc of locales) {
  let json;
  try {
    json = JSON.parse(read(join('src/i18n/locales', loc, 'errors.json')));
  } catch {
    fail(`locale ${loc}: errors.json missing or invalid`);
    continue;
  }
  const b = json.banner ?? {};
  const missing = ['title', 'retry', 'dismiss'].filter((k) => typeof b[k] !== 'string' || !b[k].trim());
  if (missing.length) {
    fail(`locale ${loc}: errors.banner missing ${missing.join(', ')}`);
  } else {
    ok(`locale ${loc}: errors.banner.{title,retry,dismiss} present`);
  }
}

if (problems > 0) {
  console.log(`\n${problems} error-placement issue(s) found.`);
  process.exit(1);
}
console.log('\nAll error-placement checks passed.');
