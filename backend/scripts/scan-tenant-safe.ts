/**
 * Phase 0 Prisma safety scanner.
 *
 * Reports — does NOT block — direct PrismaService usages outside the
 * approved allowlist. Used as a CI signal until Phase 2 cutover, when
 * the same script switches to fail-on-violation mode.
 *
 * Run:
 *   pnpm --filter backend exec ts-node scripts/scan-tenant-safe.ts
 *   pnpm --filter backend exec ts-node scripts/scan-tenant-safe.ts --strict   # exit 1 on findings
 *
 * Bypass single line with:  // @tenant-reviewed: <reason>
 *
 * The allowlist below is intentionally conservative — every entry must
 * be defended in code review.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', 'src');

/** Files/folders allowed to import PrismaService directly. */
const ALLOWLIST: ReadonlyArray<string> = [
  'src/prisma/',
  'src/saas/prisma/',
  'src/saas/__validation__/',
];

const PRISMA_IMPORT_RE = /from\s+['"][^'"]*prisma\.service['"]/;
const PRISMA_DIRECT_USE_RE = /\bprisma\.[a-z][A-Za-z0-9_]*\.(?:findMany|findUnique|findFirst|create|createMany|update|updateMany|delete|deleteMany|upsert|aggregate|count|groupBy|\$queryRaw|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe)\b/;
const REVIEWED_RE = /\/\/\s*@tenant-reviewed:?/;

interface Finding {
  file: string;
  line: number;
  text: string;
  kind: 'IMPORT' | 'USAGE';
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      yield* walk(full);
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
      yield full;
    }
  }
}

function isAllowlisted(rel: string): boolean {
  const slash = rel.replace(/\\/g, '/');
  return ALLOWLIST.some((p) => slash.includes(p));
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const findings: Finding[] = [];

  for await (const file of walk(ROOT)) {
    const rel = path.relative(path.resolve(__dirname, '..'), file);
    const allow = isAllowlisted(rel);
    const content = await fs.readFile(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (REVIEWED_RE.test(line)) continue;
      if (!allow && PRISMA_IMPORT_RE.test(line)) {
        findings.push({ file: rel, line: i + 1, text: line.trim(), kind: 'IMPORT' });
      }
      if (!allow && PRISMA_DIRECT_USE_RE.test(line)) {
        findings.push({ file: rel, line: i + 1, text: line.trim(), kind: 'USAGE' });
      }
    }
  }

  if (findings.length === 0) {
    console.log('scan-tenant-safe: 0 findings.');
    return;
  }

  console.log(`scan-tenant-safe: ${findings.length} finding(s).`);
  for (const f of findings) {
    console.log(`  ${f.kind.padEnd(5)} ${f.file}:${f.line}  ${f.text}`);
  }
  console.log(
    `\nTotal: ${findings.length}. Allowlist: ${ALLOWLIST.join(', ')}.\n` +
      `Bypass a specific line by appending "// @tenant-reviewed: <reason>".`,
  );

  if (strict) {
    console.error('\nFAIL (strict mode).');
    process.exit(1);
  }
  // Non-strict (Phase 0): report only.
  console.log('Phase 0: scanner is in REPORT-ONLY mode. Pass --strict to enforce.');
}

main().catch((e) => { console.error(e); process.exit(2); });
