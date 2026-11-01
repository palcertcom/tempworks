/**
 * Audit G — Reports SQL.
 *
 * Reports the registered report sources defined in `backend/src/reports`
 * and which ones lack a tenant-filter declaration. The check is static
 * (file-grep), not DB-driven — Phase 1 hasn't refactored the engine yet.
 */
import { AuditFinding, AuditMetric, AuditReport, writeReport } from './lib/audit';
import path from 'path';
import { promises as fs } from 'fs';

interface SourceInfo {
  file: string;
  declarationsFound: number;
  rawSqlOccurrences: number;
  hasTenantColumnHint: boolean;
}

async function scanFiles(root: string): Promise<SourceInfo[]> {
  const result: SourceInfo[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as any);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
        await walk(full);
        continue;
      }
      if (!/\.ts$/.test(e.name)) continue;
      const src = await fs.readFile(full, 'utf8').catch(() => '');
      if (!src) continue;
      // Heuristic: does this file likely contain SOURCE_DEFS or raw SQL composition?
      const sourceDefMatches = src.match(/SOURCE_DEFS|rootTable\s*:|sourceKey\s*:/g);
      const rawSql = src.match(/Prisma\.raw\b|\$queryRaw\b|\$executeRaw\b|\$queryRawUnsafe\b|\$executeRawUnsafe\b/g);
      if ((sourceDefMatches && sourceDefMatches.length) || (rawSql && rawSql.length)) {
        result.push({
          file: path.relative(path.resolve(root, '..', '..'), full),
          declarationsFound: sourceDefMatches?.length ?? 0,
          rawSqlOccurrences: rawSql?.length ?? 0,
          hasTenantColumnHint: /tenantColumn\s*:/.test(src),
        });
      }
    }
  }
  await walk(root);
  return result;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const m: AuditMetric[] = [];
  const f: AuditFinding[] = [];

  const reportsRoot = path.resolve(__dirname, '..', '..', '..', 'src', 'reports');
  const exists = await fs.stat(reportsRoot).then(() => true).catch(() => false);

  if (!exists) {
    f.push({
      severity: 'INFO',
      rule: 'reports.module-absent',
      message: `Reports module path ${reportsRoot} not found in this checkout.`,
    });
  } else {
    const found = await scanFiles(reportsRoot);
    m.push({ key: 'reports.scanned-files', value: found.length });
    const totalSourceDefs = found.reduce((s, x) => s + x.declarationsFound, 0);
    const totalRaw = found.reduce((s, x) => s + x.rawSqlOccurrences, 0);
    const withTenantHint = found.filter((x) => x.hasTenantColumnHint).length;
    m.push({ key: 'reports.source-decl-occurrences', value: totalSourceDefs });
    m.push({ key: 'reports.raw-sql-occurrences', value: totalRaw });
    m.push({ key: 'reports.files-with-tenantColumn', value: withTenantHint });

    if (totalRaw > 0 && withTenantHint === 0) {
      f.push({
        severity: 'BLOCKER',
        rule: 'reports.raw-sql-without-tenant-column',
        message: `Found ${totalRaw} raw-SQL occurrences but no source declares \`tenantColumn\`. Phase 3 reports refactor (ADR-007) MUST land before Phase 2 enforcement.`,
        detail: found,
      });
    } else if (totalRaw > 0) {
      f.push({
        severity: 'WARN',
        rule: 'reports.raw-sql-present',
        message: `${totalRaw} raw-SQL occurrences across ${found.length} files. Each must be reviewed against ADR-007.`,
      });
    }
    if (found.length === 0) {
      f.push({
        severity: 'INFO',
        rule: 'reports.no-static-matches',
        message: 'No files in reports/ matched the static heuristic. Verify the engine path.',
      });
    } else {
      f.push({
        severity: 'INFO',
        rule: 'reports.files-listed',
        message: `Scanned ${found.length} files.`,
        detail: found,
      });
    }
  }

  // Aggregate exports patterns
  const exportPaths = ['exceljs', 'pdfkit', 'docx'];
  const importHits: Record<string, number> = {};
  const allTs = await scanFiles(path.resolve(__dirname, '..', '..', '..', 'src'));
  for (const lib of exportPaths) importHits[lib] = 0;
  // The scanFiles above only captures files with sourceDefs/rawSql — not enough for export libs.
  // Lightweight grep instead:
  const srcRoot = path.resolve(__dirname, '..', '..', '..', 'src');
  async function grep(dir: string, term: string): Promise<number> {
    let n = 0;
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as any);
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
        n += await grep(p, term);
      } else if (/\.ts$/.test(e.name)) {
        const s = await fs.readFile(p, 'utf8').catch(() => '');
        if (s.includes(term)) n++;
      }
    }
    return n;
  }
  for (const lib of exportPaths) importHits[lib] = await grep(srcRoot, `'${lib}'`).catch(() => 0);
  for (const [k, v] of Object.entries(importHits)) m.push({ key: `exports.${k}.files`, value: v });

  const outDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  const report: AuditReport = {
    slug: '07-reports-sql',
    title: 'Audit G — Reports SQL',
    startedAt,
    durationMs: Date.now() - t0,
    status: f.find((x) => x.severity === 'BLOCKER') ? 'BLOCKER'
          : f.find((x) => x.severity === 'WARN')    ? 'WARN'
          : f.find((x) => x.severity === 'INFO')    ? 'INFO'
          : 'OK',
    metrics: m,
    findings: f,
    notes: [
      'This audit is static (no DB queries). It estimates the Phase 3 reports-engine refactor.',
      'Phase 1 does NOT touch the reports module.',
    ],
  };
  await writeReport(report, outDir);
  // eslint-disable-next-line no-console
  console.log(`[${report.status.padEnd(7)}] ${report.slug.padEnd(28)} ${f.length} finding(s)  ${report.durationMs}ms`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
