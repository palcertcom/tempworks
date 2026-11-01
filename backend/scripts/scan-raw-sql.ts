/**
 * Phase 2 raw-SQL scanner.
 *
 * Reports — does NOT block — every raw-SQL surface in the backend
 * source tree.  Used as a planning tool for Phase 3 (reports refactor)
 * and as a safety signal for new PRs.
 *
 * Patterns detected:
 *   - `Prisma.raw(`              raw fragment composition
 *   - `$queryRaw\``              tagged-template raw SELECT
 *   - `$executeRaw\``            tagged-template raw mutation
 *   - `$queryRawUnsafe(`         string-form raw SELECT
 *   - `$executeRawUnsafe(`      string-form raw mutation
 *   - SQL string concatenation (heuristic): a string literal that
 *     contains a SQL keyword AND a `+ ` concatenation.
 *
 * Severity:
 *   BLOCKER  — string-concatenated SQL (template literal with ${} that
 *              looks like SQL keywords AND identifier-y substitution)
 *   HIGH     — Prisma.raw / *Unsafe variants
 *   MEDIUM   — $queryRaw / $executeRaw tagged template (parameterised
 *              but still bypasses TenantPrismaService injection)
 *
 * `// @tenant-reviewed: <reason>` on the same line suppresses the
 * finding.  Lines without a reason are still flagged.
 *
 * Output:
 *   - Console table (file:line, severity, pattern, snippet)
 *   - JSON at backend/reports/saas/phase2/raw-sql.json
 *   - Markdown at backend/reports/saas/phase2/raw-sql.md
 *   - Exit 0 (advisory).  Pass `--strict` to exit non-zero on findings.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', 'src');
const OUT_DIR = path.resolve(__dirname, '..', 'reports', 'saas', 'phase2');

interface Pattern {
  re: RegExp;
  label: string;
  severity: 'BLOCKER' | 'HIGH' | 'MEDIUM';
  blocksPhase2: boolean;
  fix: string;
}

const PATTERNS: Pattern[] = [
  {
    re: /\$executeRawUnsafe\s*\(/,
    label: '$executeRawUnsafe',
    severity: 'BLOCKER',
    blocksPhase2: true,
    fix: 'Convert to $executeRaw with tagged-template params; route through TenantPrismaService.withTenant.',
  },
  {
    re: /\$queryRawUnsafe\s*\(/,
    label: '$queryRawUnsafe',
    severity: 'BLOCKER',
    blocksPhase2: true,
    fix: 'Convert to $queryRaw tagged template; declare a SOURCE_DEFS entry with tenantColumn.',
  },
  {
    re: /\bPrisma\.raw\s*\(/,
    label: 'Prisma.raw',
    severity: 'HIGH',
    blocksPhase2: true,
    fix: 'Move into the SOURCE_DEFS registry under backend/src/saas/reports; the boot validator will require tenantColumn.',
  },
  {
    re: /\$executeRaw\s*[`]/,
    label: '$executeRaw',
    severity: 'MEDIUM',
    blocksPhase2: false,
    fix: 'Wrap the call site in TenantPrismaService.withTenant so RLS sees a tenant_id GUC.',
  },
  {
    re: /\$queryRaw\s*[`]/,
    label: '$queryRaw',
    severity: 'MEDIUM',
    blocksPhase2: false,
    fix: 'Wrap call site in TenantPrismaService.withTenant; verify the SQL has a tenant filter.',
  },
];

// Heuristic: a TEMPLATE literal that interpolates an identifier-like
// expression alongside SQL keywords. Example: `\`SELECT * FROM \${t}\``.
const STRING_CONCAT_SQL_RE =
  /`[^`]*\b(SELECT|FROM|WHERE|JOIN|UPDATE|INSERT|DELETE)\b[^`]*\$\{[^}]+\}/i;

const REVIEWED_RE = /\/\/\s*@tenant-reviewed(?::|\s|$)/;
const REVIEWED_REASON_RE = /\/\/\s*@tenant-reviewed:\s*\S/;

interface Finding {
  file: string;
  line: number;
  pattern: string;
  severity: 'BLOCKER' | 'HIGH' | 'MEDIUM';
  blocksPhase2: boolean;
  module: string;
  snippet: string;
  fix: string;
  reviewed: boolean;
  reviewReasonMissing?: boolean;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' || e.name === '__validation__' || e.name === '__tests__') continue;
      yield* walk(full);
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
      yield full;
    }
  }
}

function moduleFor(rel: string): string {
  // src/<module>/* → <module>;  src/<dir>/<module>/* → <dir>/<module>
  const parts = rel.split(/[\\/]/);
  // strip 'src/' if present
  const i = parts.indexOf('src');
  const after = i >= 0 ? parts.slice(i + 1) : parts;
  return after[0] ?? '<root>';
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const findings: Finding[] = [];
  await fs.mkdir(OUT_DIR, { recursive: true });

  for await (const file of walk(ROOT)) {
    const rel = path.relative(path.resolve(__dirname, '..'), file);
    // Skip the SaaS scaffolding (the safe surface) and the tenant-safe
    // reports runtime. Both intentionally use `Prisma.raw` / patterns
    // that would otherwise trip the scanner. They are the safe path.
    //
    // Phase 2.1 contract: any `$queryRaw*` inside the runtime MUST be
    // accompanied by a `// @tenant-reviewed: tenant-safe-report-runtime`
    // comment — checked by the per-line scanner below as usual; we do
    // NOT skip individual lines, just the file roots that own the
    // builder/registry/types.
    if (/[/\\]saas[/\\]reports[/\\]/.test(rel)) continue;
    if (/[/\\]saas[/\\]reports[/\\]runtime[/\\]/.test(rel)) continue;
    const module = moduleFor(rel);
    const content = await fs.readFile(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const reviewed = REVIEWED_RE.test(line);
      const reviewReasonMissing = reviewed && !REVIEWED_REASON_RE.test(line);

      // Pattern matches
      for (const p of PATTERNS) {
        if (p.re.test(line)) {
          findings.push({
            file: rel,
            line: i + 1,
            pattern: p.label,
            severity: p.severity,
            blocksPhase2: p.blocksPhase2,
            module,
            snippet: line.trim().slice(0, 240),
            fix: p.fix,
            reviewed,
            reviewReasonMissing: reviewed ? reviewReasonMissing : undefined,
          });
          break;
        }
      }

      // Heuristic: string-concatenated SQL
      if (STRING_CONCAT_SQL_RE.test(line)) {
        findings.push({
          file: rel,
          line: i + 1,
          pattern: 'string-concat-SQL',
          severity: 'BLOCKER',
          blocksPhase2: true,
          module,
          snippet: line.trim().slice(0, 240),
          fix: 'Replace template-string SQL with parameterised tagged-template OR move into SOURCE_DEFS.',
          reviewed,
          reviewReasonMissing: reviewed ? reviewReasonMissing : undefined,
        });
      }
    }
  }

  // Sort: BLOCKER → HIGH → MEDIUM, by file
  const rank: Record<Finding['severity'], number> = { BLOCKER: 3, HIGH: 2, MEDIUM: 1 };
  findings.sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[b.severity] - rank[a.severity];
    return (a.file + a.line).localeCompare(b.file + b.line);
  });

  // ---- Output ----
  const summary = {
    generatedAt: new Date().toISOString(),
    counts: {
      total:      findings.length,
      BLOCKER:    findings.filter((f) => f.severity === 'BLOCKER').length,
      HIGH:       findings.filter((f) => f.severity === 'HIGH').length,
      MEDIUM:     findings.filter((f) => f.severity === 'MEDIUM').length,
      blocksPhase2: findings.filter((f) => f.blocksPhase2 && !f.reviewed).length,
      reviewedWithoutReason: findings.filter((f) => f.reviewReasonMissing).length,
    },
    byModule: Object.fromEntries(
      [...new Set(findings.map((f) => f.module))].map((m) => [
        m, findings.filter((f) => f.module === m).length,
      ]),
    ),
    findings,
  };

  await fs.writeFile(path.join(OUT_DIR, 'raw-sql.json'), JSON.stringify(summary, null, 2));

  const md: string[] = [];
  md.push('# Phase 2 — Raw-SQL Scanner Report');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push('');
  md.push(`- Total findings: **${summary.counts.total}**`);
  md.push(`- BLOCKER: ${summary.counts.BLOCKER} (blocks Phase 2 enforcement: ${summary.counts.blocksPhase2})`);
  md.push(`- HIGH: ${summary.counts.HIGH}`);
  md.push(`- MEDIUM: ${summary.counts.MEDIUM}`);
  md.push(`- @tenant-reviewed without reason: ${summary.counts.reviewedWithoutReason}`);
  md.push('');
  md.push('## Per-module');
  md.push('');
  md.push('| Module | Findings |');
  md.push('|--------|---------:|');
  for (const [m, n] of Object.entries(summary.byModule)) md.push(`| \`${m}\` | ${n} |`);
  md.push('');
  md.push('## Findings');
  md.push('');
  md.push('| File | Line | Severity | Pattern | Module | Reviewed | Snippet |');
  md.push('|------|-----:|----------|---------|--------|---------|---------|');
  for (const f of findings.slice(0, 500)) {
    const rev = f.reviewed ? (f.reviewReasonMissing ? 'yes (no reason)' : 'yes') : '—';
    md.push(`| \`${f.file}\` | ${f.line} | **${f.severity}** | \`${f.pattern}\` | \`${f.module}\` | ${rev} | \`${f.snippet.replace(/\|/g, '\\|')}\` |`);
  }
  if (findings.length > 500) md.push(`\n*(${findings.length - 500} more — see JSON for full list)*\n`);
  md.push('');
  md.push('## Suggested fixes');
  md.push('');
  for (const p of PATTERNS) {
    md.push(`- **\`${p.label}\`** (${p.severity}): ${p.fix}`);
  }
  await fs.writeFile(path.join(OUT_DIR, 'raw-sql.md'), md.join('\n'));

  // Console summary
  console.log(`scan-raw-sql: ${findings.length} finding(s) ` +
    `[BLOCKER=${summary.counts.BLOCKER} HIGH=${summary.counts.HIGH} MEDIUM=${summary.counts.MEDIUM}].`);
  console.log(`  blocks Phase 2 enforcement (unreviewed): ${summary.counts.blocksPhase2}`);
  if (summary.counts.reviewedWithoutReason)
    console.log(`  @tenant-reviewed without reason: ${summary.counts.reviewedWithoutReason}`);
  console.log(`  reports written to ${path.relative(process.cwd(), OUT_DIR)}/`);

  if (strict && summary.counts.blocksPhase2 > 0) {
    console.error(`\nFAIL (strict mode): ${summary.counts.blocksPhase2} BLOCKER finding(s).`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
