#!/usr/bin/env node
/**
 * Codemod: swap native `<input type="date">` / `<Input type="date">`
 * for the dd.MM.yyyy <DateInput> drop-in.
 *
 * DateInput keeps the exact native contract — `value` is ISO
 * `yyyy-MM-dd`, `onChange` fires `{ target: { value } }` — so the only
 * edits needed are:
 *   • rename the tag  (input|Input) → DateInput
 *   • delete the `type="date"` attribute
 *   • add the import
 *
 * Does NOT touch `type="datetime-local"` (DateInput is date-only).
 *
 * Idempotent. Run from repo root: node scripts/codemod-date-input.mjs
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
    else if (/\.tsx$/.test(p)) files.push(p);
  }
  return files;
}

// Find each `<input ... type="date" ... >` (or <Input ...>) opening tag
// and rewrite it. We locate the tag start, find its matching `>`
// (respecting `{...}` JSX expression braces and quotes), and operate on
// that slice only.
function findTagEnd(s, start) {
  let i = start;
  let depthBrace = 0;
  let quote = null;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === '>' && depthBrace === 0) return i;
    i++;
  }
  return -1;
}

let totalEdits = 0;
const touched = [];

for (const file of walk(SRC)) {
  let src = readFileSync(file, 'utf8');
  let edits = 0;
  let changed = true;

  while (changed) {
    changed = false;
    for (const tag of ['<input', '<Input']) {
      let idx = src.indexOf(tag);
      while (idx !== -1) {
        // Char after tag must be whitespace/newline (so `<input` not `<inputX`).
        const after = src[idx + tag.length];
        if (!/\s/.test(after)) { idx = src.indexOf(tag, idx + 1); continue; }
        const end = findTagEnd(src, idx);
        if (end === -1) { idx = src.indexOf(tag, idx + 1); continue; }
        let tagText = src.slice(idx, end + 1);

        // Only date (not datetime-local), and the type must be a literal.
        if (!/type\s*=\s*"date"/.test(tagText)) { idx = src.indexOf(tag, idx + 1); continue; }

        // Rewrite: drop type="date", rename tag → DateInput.
        let newTag = tagText
          .replace(/\s*type\s*=\s*"date"/, '')
          .replace(/^<input\b/, '<DateInput')
          .replace(/^<Input\b/, '<DateInput');

        src = src.slice(0, idx) + newTag + src.slice(end + 1);
        edits++;
        changed = true;
        idx = src.indexOf(tag); // restart scan for this tag
      }
    }
  }

  if (edits > 0) {
    if (!/import\s*\{[^}]*\bDateInput\b[^}]*\}\s*from\s*['"][^'"]*ui\/date-input['"]/.test(src)) {
      const rel = relative(dirname(file), join(ROOT, 'src', 'app', 'components', 'ui', 'date-input')).replace(/\\/g, '/');
      const importPath = rel.startsWith('.') ? rel : './' + rel;
      // Insert after the last import STATEMENT (handles multi-line imports).
      const lines = src.split('\n');
      let end = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!/^import\s/.test(lines[i])) continue;
        if (lines[i].includes(' from ') || /;\s*$/.test(lines[i])) end = i;
        else { let j = i; while (j < lines.length && !/^\s*\}\s*from\s/.test(lines[j])) j++; end = (j < lines.length ? j : i); i = end; }
      }
      lines.splice(end + 1, 0, `import { DateInput } from '${importPath}';`);
      src = lines.join('\n');
    }
    writeFileSync(file, src);
    totalEdits += edits;
    touched.push(`${relative(ROOT, file)} (+${edits})`);
  }
}

console.log(`Swapped ${totalEdits} native date input(s) across ${touched.length} file(s):`);
for (const t of touched) console.log(`  ${t}`);
