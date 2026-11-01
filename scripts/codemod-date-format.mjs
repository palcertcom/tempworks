#!/usr/bin/env node
/**
 * Codemod: route user-facing date rendering through the central
 * formatDate / formatDateTime helpers (which now emit dd.MM.yyyy).
 *
 * Rewrites, with balanced-paren matching:
 *   new Date(EXPR).toLocaleDateString(...)   → formatDate(EXPR)
 *   new Date(EXPR).toLocaleString(...)        → formatDateTime(EXPR)
 *   IDENT.toLocaleDateString(...)             → formatDate(IDENT)
 *   IDENT.toLocaleString(...)                 → formatDateTime(IDENT)
 *
 * Skips (left untouched):
 *   • any call whose options contain `weekday`  (renders a day NAME,
 *     not a date — e.g. AttendanceSheet day labels)
 *   • toLocaleTimeString (time-only)
 *   • toLocaleString() with no args on a number (rare; the regex
 *     requires a `new Date(`/identifier receiver so numbers are safe)
 *
 * Adds the needed import to any file it touched.
 *
 * Run from repo root:  node scripts/codemod-date-format.mjs
 * Idempotent.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'app');

function walk(dir, files = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(tsx|ts)$/.test(p)) files.push(p);
  }
  return files;
}

// Find the matching close paren for an open paren at index `open`.
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

let totalEdits = 0;
const touched = [];

for (const file of walk(SRC)) {
  let src = readFileSync(file, 'utf8');
  let edits = 0;

  // Repeatedly scan for `.toLocaleDateString(` / `.toLocaleString(`
  // receivers and rewrite. We re-scan from scratch each pass because
  // indices shift after a replacement.
  const methods = [
    { name: 'toLocaleDateString', helper: 'formatDate' },
    { name: 'toLocaleString', helper: 'formatDateTime' },
  ];

  let changedThisPass = true;
  while (changedThisPass) {
    changedThisPass = false;
    for (const { name, helper } of methods) {
      const marker = `.${name}(`;
      let idx = src.indexOf(marker);
      while (idx !== -1) {
        // Locate the receiver expression ending right before `.<name>`.
        // Two shapes: `new Date(...)` or a bare identifier/member chain.
        const before = src.slice(0, idx);

        // args of the toLocale call
        const argOpen = idx + marker.length - 1;
        const argClose = matchParen(src, argOpen);
        if (argClose === -1) { idx = src.indexOf(marker, idx + 1); continue; }
        const args = src.slice(argOpen + 1, argClose);

        // Skip weekday-name renders and explicit time-only renders.
        if (/weekday/.test(args)) { idx = src.indexOf(marker, idx + 1); continue; }

        // Determine the receiver.
        let recStart = -1;
        let receiverExpr = null;

        const newDateMatch = before.match(/new\s+Date\s*\($/);
        if (before.match(/\)\s*$/)) {
          // Receiver ends with ) — walk back to its matching open and
          // check whether it's a `new Date(...)`.
          const closeParen = before.length - 1;
          // find matching open paren
          let depth = 0, openIdx = -1;
          for (let i = closeParen; i >= 0; i--) {
            if (src[i] === ')') depth++;
            else if (src[i] === '(') { depth--; if (depth === 0) { openIdx = i; break; } }
          }
          if (openIdx !== -1) {
            const head = src.slice(0, openIdx);
            const nd = head.match(/new\s+Date\s*$/);
            if (nd) {
              recStart = head.length - nd[0].length;
              receiverExpr = src.slice(openIdx + 1, closeParen); // inside new Date(...)
            }
          }
        }

        if (recStart === -1) {
          // Bare identifier / member chain like `d` or `a.b.c`.
          const m = before.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/);
          if (m) {
            recStart = before.length - m[0].length;
            receiverExpr = m[1];
          }
        }

        if (recStart === -1 || receiverExpr == null) {
          idx = src.indexOf(marker, idx + 1);
          continue;
        }

        const replacement = `${helper}(${receiverExpr.trim()})`;
        src = src.slice(0, recStart) + replacement + src.slice(argClose + 1);
        edits++;
        changedThisPass = true;
        // restart scan for this method
        idx = src.indexOf(marker);
      }
    }
  }

  if (edits > 0) {
    // Ensure import of the helpers used.
    const used = [];
    if (/\bformatDate\(/.test(src)) used.push('formatDate');
    if (/\bformatDateTime\(/.test(src)) used.push('formatDateTime');

    // Compute relative path to src/i18n/formatters
    const rel = relative(dirname(file), join(ROOT, 'src', 'i18n', 'formatters')).replace(/\\/g, '/');
    const importPath = rel.startsWith('.') ? rel : './' + rel;

    const existing = src.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*i18n\/formatters['"]\s*;/);
    if (existing) {
      const names = new Set(existing[1].split(',').map(s => s.trim()).filter(Boolean));
      for (const u of used) names.add(u);
      const rebuilt = `import { ${[...names].join(', ')} } from '${existing[0].match(/from\s*['"]([^'"]+)['"]/)[1]}';`;
      src = src.replace(existing[0], rebuilt);
    } else {
      // Insert a new import after the last top-level import STATEMENT.
      // A statement can span multiple lines (`import {\n ... \n} from`)
      // so we must advance to the line that actually closes it before
      // inserting — otherwise the new import lands INSIDE the brace
      // block and breaks the parse.
      const lines = src.split('\n');
      let lastImportEnd = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!/^import\s/.test(lines[i])) continue;
        if (lines[i].includes(' from ') || /;\s*$/.test(lines[i])) {
          lastImportEnd = i; // single-line import
        } else {
          // multi-line: walk to the closing `} from '...'`
          let j = i;
          while (j < lines.length && !/^\s*\}\s*from\s/.test(lines[j])) j++;
          lastImportEnd = j < lines.length ? j : i;
          i = lastImportEnd;
        }
      }
      const imp = `import { ${used.join(', ')} } from '${importPath}';`;
      lines.splice(lastImportEnd + 1, 0, imp);
      src = lines.join('\n');
    }

    writeFileSync(file, src);
    totalEdits += edits;
    touched.push(`${relative(ROOT, file)} (+${edits})`);
  }
}

console.log(`Rewrote ${totalEdits} callsite(s) across ${touched.length} file(s):`);
for (const t of touched) console.log(`  ${t}`);
