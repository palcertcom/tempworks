#!/usr/bin/env node
/**
 * Hardcoded JSX literal scanner.
 *
 * Heuristically flags suspicious English text inside JSX in source files
 * under `src/app/`. False positives are inevitable — this is a guidance
 * tool, not a rigid lint.
 *
 * Skips:
 *   - the i18n/ directory
 *   - imports, comments, type literals
 *   - strings already inside `t(...)` or `Trans` components
 *   - strings shorter than 3 characters
 *   - strings that are obviously not user-visible (URLs, css class lists,
 *     all-uppercase enum codes, paths starting with /)
 *
 * Run:
 *   node scripts/i18n-check-literals.mjs [path]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCAN_ROOT = process.argv[2] ?? join(ROOT, 'src', 'app');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'i18n']);
const SKIP_NEEDLE = ['/* eslint-disable i18n */'];

// Match `>Some text<` patterns inside JSX, ignoring expression-only text.
const JSX_TEXT_RE = /(?<![\\\w])>([^<>{}\n][^<>{}\n]{2,})</g;

function looksUserVisible(s) {
  const t = s.trim();
  if (!t) return false;
  if (t.length < 3) return false;
  if (/^[A-Z_]+$/.test(t)) return false;        // enum codes
  if (/^[\w-]+\/[\w/-]*/.test(t)) return false; // paths
  if (/^https?:\/\//.test(t)) return false;     // URLs
  if (!/[A-Za-z]/.test(t)) return false;        // pure punctuation/digits
  if (/^[a-z][a-z0-9-]*$/i.test(t) && !t.includes(' ')) return false; // single tokens, likely IDs
  // TS-signature false positives
  if (/^= /.test(t)) return false;              // assignment/comparison: "= from && t"
  if (/ && /.test(t)) return false;             // JS logical operators in expressions
  if (/\? ['"]/.test(t)) return false;          // ternary with string literal: "0 ? 'cls' : ..."
  if (/\bas Record\b/.test(t)) return false;    // TypeScript cast: "[c.key]) as Record"
  if (/^\(e: React/.test(t)) return false;      // event handler type signature
  if (/^& [A-Z]/.test(t)) return false;         // TS intersection type: "& VariantProps"
  if (/^Number\(/.test(t)) return false;         // JS Number() call expression
  return true;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) files.push(full);
  }
  return files;
}

const offenders = [];
for (const file of walk(SCAN_ROOT)) {
  const text = readFileSync(file, 'utf8');
  if (SKIP_NEEDLE.some((n) => text.includes(n))) continue;
  let match;
  JSX_TEXT_RE.lastIndex = 0;
  while ((match = JSX_TEXT_RE.exec(text)) !== null) {
    const literal = match[1];
    if (!looksUserVisible(literal)) continue;
    // Skip lines that are comments or already wrapped in t()
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd   = text.indexOf('\n', match.index);
    const line      = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (line.includes('t(') || line.includes('<Trans')) continue;
    if (line.trim().startsWith('//')) continue;
    const lineNum = text.slice(0, match.index).split('\n').length;
    offenders.push({
      file: relative(ROOT, file),
      line: lineNum,
      text: literal.trim(),
    });
  }
}

if (offenders.length === 0) {
  console.log('✓ No suspicious hardcoded JSX literals found.');
  process.exit(0);
}

console.log(`Found ${offenders.length} suspicious hardcoded JSX literal(s):\n`);
for (const o of offenders.slice(0, 100)) {
  console.log(`  ${o.file}:${o.line}  →  "${o.text}"`);
}
if (offenders.length > 100) {
  console.log(`  … and ${offenders.length - 100} more.`);
}
console.log('\nThis is a heuristic check. False positives are expected — wrap genuine');
console.log('user-visible strings in t(...) / use the i18n namespace, or add a');
console.log('"/* eslint-disable i18n */" comment to silence the file.');

// Don't fail the build by default; treat as advisory unless STRICT=1.
process.exit(process.env.STRICT === '1' ? 1 : 0);
