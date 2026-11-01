/**
 * Phase 2 — Runtime Refactor Inventory.
 *
 * Static analysis of `backend/src/<module>/*.ts` that produces a
 * machine-readable inventory of every backend module:
 *   - file count
 *   - direct Prisma usage count
 *   - raw-SQL pattern count (any of Prisma.raw / $queryRaw* / $executeRaw*)
 *   - background-job hooks (`@Cron`, `setInterval`, BullMQ queue.add)
 *   - export hits (exceljs / pdfkit / docx imports)
 *   - tenant-leak heuristic risk tier (P0..P3)
 *
 * Output:
 *   backend/reports/saas/phase2/runtime-inventory.json
 *   backend/reports/saas/phase2/runtime-inventory.md
 *
 * The risk classification is intentionally conservative. The
 * accompanying `SAAS_PHASE2_RUNTIME_REFACTOR_INVENTORY.md` document
 * uses these counts plus human judgement to assign the final order.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..', 'src');
const OUT_DIR  = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

const PATTERNS = {
  prismaCall: /\bprisma\.[a-z][A-Za-z0-9_]*\.(?:findMany|findUnique|findFirst|create|createMany|update|updateMany|delete|deleteMany|upsert|aggregate|count|groupBy)\b/g,
  rawSql:     /(\bPrisma\.raw\s*\(|\$queryRawUnsafe\s*\(|\$executeRawUnsafe\s*\(|\$queryRaw\s*[`]|\$executeRaw\s*[`])/g,
  cron:       /@Cron\s*\(/g,
  setInterval:/\bsetInterval\s*\(/g,
  queueAdd:   /\.\s*add\s*\(\s*['"][^'"]+['"]/g,   // queue.add('foo', ...)
  excelImport:/from\s+['"]exceljs['"]/g,
  pdfImport:  /from\s+['"]pdfkit['"]/g,
  docxImport: /from\s+['"]docx['"]/g,
  agencyFilter:/where\s*:\s*\{[^}]*agencyId\s*:/g,
};

interface ModuleStats {
  module: string;
  files: number;
  loc: number;
  prismaCalls: number;
  rawSqlHits: number;
  cronHooks: number;
  setIntervals: number;
  queueAdds: number;
  exportHits: number;
  agencyFilterUsages: number;
  /** P0/P1/P2/P3/global-only — heuristic; reviewed by human in MD doc. */
  tier: 'P0' | 'P1' | 'P2' | 'P3' | 'global';
}

async function* walk(dir: string): AsyncGenerator<string> {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__validation__' || e.name === '__tests__') continue;
      yield* walk(full);
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
      yield full;
    }
  }
}

function moduleFor(rel: string): string {
  const parts = rel.split(/[\\/]/);
  // SaaS-internal modules grouped under `saas`
  if (parts[0] === 'saas') return 'saas';
  return parts[0] ?? '<root>';
}

function classify(s: ModuleStats): ModuleStats['tier'] {
  // Heuristics:
  //   global-only — utility modules with no Prisma calls and no cron
  //   P0          — raw SQL OR scheduler that scans all data
  //   P1          — many Prisma calls (>= 30) AND no agency-scope filter usage
  //   P2          — 5..29 Prisma calls
  //   P3          — < 5 Prisma calls
  if (s.module === 'common' || s.module === 'i18n' || s.module === 'saas' || s.module === 'health') {
    return 'global';
  }
  if (s.rawSqlHits > 0) return 'P0';
  if (s.setIntervals > 0 && s.module === 'notifications') return 'P0';
  if (s.prismaCalls >= 30 && s.agencyFilterUsages === 0) return 'P1';
  if (s.prismaCalls >= 5)  return 'P2';
  return 'P3';
}

async function main(): Promise<void> {
  const stats = new Map<string, ModuleStats>();
  for await (const file of walk(SRC_ROOT)) {
    const rel = path.relative(path.resolve(__dirname, '..', '..', '..'), file);
    const module = moduleFor(rel.replace(/^src[\\/]/, ''));
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    const cur = stats.get(module) ?? {
      module, files: 0, loc: 0, prismaCalls: 0, rawSqlHits: 0,
      cronHooks: 0, setIntervals: 0, queueAdds: 0, exportHits: 0,
      agencyFilterUsages: 0, tier: 'P3' as const,
    };
    cur.files += 1;
    cur.loc += content.split('\n').length;
    cur.prismaCalls += (content.match(PATTERNS.prismaCall) ?? []).length;
    cur.rawSqlHits += (content.match(PATTERNS.rawSql) ?? []).length;
    cur.cronHooks += (content.match(PATTERNS.cron) ?? []).length;
    cur.setIntervals += (content.match(PATTERNS.setInterval) ?? []).length;
    cur.queueAdds += (content.match(PATTERNS.queueAdd) ?? []).length;
    cur.exportHits += (content.match(PATTERNS.excelImport) ?? []).length
                    + (content.match(PATTERNS.pdfImport) ?? []).length
                    + (content.match(PATTERNS.docxImport) ?? []).length;
    cur.agencyFilterUsages += (content.match(PATTERNS.agencyFilter) ?? []).length;
    stats.set(module, cur);
  }
  for (const s of stats.values()) s.tier = classify(s);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const sorted = [...stats.values()].sort((a, b) => {
    const rank = { P0: 4, P1: 3, P2: 2, P3: 1, global: 0 } as const;
    if (rank[a.tier] !== rank[b.tier]) return rank[b.tier] - rank[a.tier];
    return b.prismaCalls - a.prismaCalls;
  });

  const totals = {
    modules: sorted.length,
    files: sorted.reduce((s, x) => s + x.files, 0),
    prismaCalls: sorted.reduce((s, x) => s + x.prismaCalls, 0),
    rawSqlHits: sorted.reduce((s, x) => s + x.rawSqlHits, 0),
    P0: sorted.filter((s) => s.tier === 'P0').length,
    P1: sorted.filter((s) => s.tier === 'P1').length,
    P2: sorted.filter((s) => s.tier === 'P2').length,
    P3: sorted.filter((s) => s.tier === 'P3').length,
    global: sorted.filter((s) => s.tier === 'global').length,
  };

  const json = { generatedAt: new Date().toISOString(), totals, modules: sorted };
  await fs.writeFile(path.join(OUT_DIR, 'runtime-inventory.json'), JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# Phase 2 — Runtime Refactor Inventory (machine output)');
  md.push('');
  md.push(`Generated: ${json.generatedAt}`);
  md.push('');
  md.push('## Totals');
  md.push('');
  md.push('| Metric | Value |');
  md.push('|--------|------:|');
  for (const [k, v] of Object.entries(totals)) md.push(`| ${k} | ${v} |`);
  md.push('');
  md.push('## Per-module (sorted by tier, then prismaCalls)');
  md.push('');
  md.push('| Module | Tier | Files | LOC | Prisma calls | Raw SQL | Cron | setInterval | queue.add | Export libs | agencyId-filter usages |');
  md.push('|--------|------|------:|----:|-------------:|--------:|-----:|------------:|----------:|------------:|-----------------------:|');
  for (const s of sorted) {
    md.push(`| \`${s.module}\` | **${s.tier}** | ${s.files} | ${s.loc} | ${s.prismaCalls} | ${s.rawSqlHits} | ${s.cronHooks} | ${s.setIntervals} | ${s.queueAdds} | ${s.exportHits} | ${s.agencyFilterUsages} |`);
  }
  await fs.writeFile(path.join(OUT_DIR, 'runtime-inventory.md'), md.join('\n'));

  console.log(`runtime-inventory: ${totals.modules} modules; ` +
    `P0=${totals.P0} P1=${totals.P1} P2=${totals.P2} P3=${totals.P3} global=${totals.global}`);
  console.log(`Reports written to ${path.relative(process.cwd(), OUT_DIR)}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
