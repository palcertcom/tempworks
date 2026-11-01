/**
 * Recon E — Reports SQL.
 *
 * Static analysis of `backend/src/reports/` to:
 *   - identify every raw SQL composition site,
 *   - propose a `tenantColumn` mapping per detected source,
 *   - estimate the per-source refactor cost,
 *   - emit the export-isolation requirements list.
 *
 * Read-only. No DB queries. No mutations.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { runRecon } from './lib/recon';

interface SourceHit {
  file: string;
  line: number;
  snippet: string;
  pattern: 'Prisma.raw' | '$queryRaw' | '$executeRaw' | '$queryRawUnsafe' | '$executeRawUnsafe';
}

const PATTERNS: Array<{ re: RegExp; label: SourceHit['pattern'] }> = [
  { re: /\bPrisma\.raw\b/,           label: 'Prisma.raw' },
  { re: /\$queryRawUnsafe\b/,        label: '$queryRawUnsafe' },
  { re: /\$executeRawUnsafe\b/,      label: '$executeRawUnsafe' },
  { re: /\$queryRaw\b/,              label: '$queryRaw' },
  { re: /\$executeRaw\b/,            label: '$executeRaw' },
];

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as any);
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      await walk(p, out);
    } else if (/\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

async function findHits(): Promise<SourceHit[]> {
  const root = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'reports');
  const exists = await fs.stat(root).then(() => true).catch(() => false);
  if (!exists) return [];
  const files = await walk(root);
  const hits: SourceHit[] = [];
  for (const file of files) {
    const src = await fs.readFile(file, 'utf8').catch(() => '');
    if (!src) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { re, label } of PATTERNS) {
        if (re.test(lines[i])) {
          hits.push({
            file: path.relative(path.resolve(__dirname, '..', '..', '..', '..'), file),
            line: i + 1,
            snippet: lines[i].trim().slice(0, 220),
            pattern: label,
          });
          break;
        }
      }
    }
  }
  return hits;
}

/**
 * Best-effort detection of `SOURCE_DEFS`-style entries: looks for keys like
 * `rootTable:` or a `key:` followed by a table-style identifier.
 */
async function findSourceDefs(): Promise<{ file: string; declarationCount: number; hasTenantColumn: boolean }[]> {
  const root = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'reports');
  const exists = await fs.stat(root).then(() => true).catch(() => false);
  if (!exists) return [];
  const files = await walk(root);
  const out: { file: string; declarationCount: number; hasTenantColumn: boolean }[] = [];
  for (const file of files) {
    const src = await fs.readFile(file, 'utf8').catch(() => '');
    const decls = (src.match(/rootTable\s*:/g) ?? []).length;
    if (decls > 0 || /SOURCE_DEFS/.test(src)) {
      out.push({
        file: path.relative(path.resolve(__dirname, '..', '..', '..', '..'), file),
        declarationCount: decls,
        hasTenantColumn: /tenantColumn\s*:/.test(src),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  await runRecon('E-reports-sql', 'Recon E — Reports SQL', async ({ mode }) => {
    const metrics: { key: string; value: any; note?: string }[] = [];
    const hits = await findHits();
    const defs = await findSourceDefs();
    metrics.push({ key: 'reports.raw-sql-hits', value: hits.length });
    metrics.push({ key: 'reports.source-def-files', value: defs.length });
    metrics.push({ key: 'reports.source-defs.with-tenantColumn', value: defs.filter((d) => d.hasTenantColumn).length });

    const actions = [];
    let status: 'OK' | 'WARN' | 'BLOCKER' = 'OK';

    if (hits.length === 0 && defs.length === 0) {
      return {
        metrics, actions, status: 'OK',
        notes: ['No reports/ files matched static patterns. Verify the engine path.'],
      };
    }

    // Per-file action: declare tenantColumn (or accept raw-sql exception only with reason).
    for (const d of defs) {
      if (!d.hasTenantColumn) {
        status = 'BLOCKER';
        actions.push({
          kind: 'reports.missing-tenant-column',
          subject: { file: d.file, declarationCount: d.declarationCount },
          proposedDecision: 'add tenantColumn:<col>; reject at boot if missing',
          applied: false,
        });
      }
    }
    for (const h of hits) {
      actions.push({
        kind: 'reports.raw-sql',
        subject: h,
        proposedDecision: 'wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source',
        applied: false,
      });
      if (status === 'OK') status = 'WARN';
    }

    actions.push({
      kind: 'reports.export-isolation',
      subject: {
        requirement:
          'Excel/PDF/DOCX exports MUST reuse the same query builder; export entry-points cannot accept raw SQL.',
      },
      proposedDecision: 'route exports through `runReport` with the same tenantColumn enforcement',
      applied: false,
    });

    return {
      metrics, actions, status,
      notes: [
        'Static analysis only — no DB queries.',
        'BLOCKER status here is informational for Phase 2 planning; Phase 1 backfill itself is unaffected.',
        `apply-mode is a no-op for this recon (no DB writes); current mode = ${mode}.`,
      ],
    };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
