/**
 * Phase 2 — Reports validator (static).
 *
 * Reads `backend/src/reports/reports.service.ts`, extracts the
 * `SOURCE_DEFS` block, and emits a per-source readiness report:
 *
 *   - source key
 *   - primaryTable / primaryAlias
 *   - softDelete flag
 *   - join count
 *   - join-tenant-equality count (heuristic; same regex the dormant
 *     scaffolding uses)
 *   - status: READY / NEEDS_DECISION / BLOCKED
 *   - proposed tenantColumn (heuristic from `agencyId`/`tenantId` columns)
 *
 * No DB connection. No mutation.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';

const REPORTS_TS = path.resolve(__dirname, '..', '..', '..', 'src', 'reports', 'reports.service.ts');
const OUT_DIR    = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

const TENANT_EQ_RE =
  /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*"?(?:tenant_id|tenantId)"?\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*"?(?:tenant_id|tenantId)"?\b/;

interface SourceFinding {
  key: string;
  label: string;
  primaryTable: string;
  primaryAlias: string;
  softDelete: boolean;
  joinCount: number;
  joinsWithTenantEquality: number;
  fieldCount: number;
  hasAgencyIdField: boolean;
  hasTenantIdField: boolean;
  proposedTenantColumn: string | null;
  proposedAgencyColumn: string | null;
  status: 'READY' | 'NEEDS_DECISION' | 'BLOCKED';
  notes: string[];
}

function parseSources(src: string): SourceFinding[] {
  // Find `const SOURCE_DEFS: Record<string, SourceDef> = {` and the matching `};`
  const start = src.indexOf('const SOURCE_DEFS');
  if (start < 0) throw new Error('SOURCE_DEFS not found');
  const open  = src.indexOf('{', start);
  // Walk braces to find matching close.
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('SOURCE_DEFS close brace not found');
  const body = src.slice(open + 1, end);

  // Split into per-source blocks. Each begins with `<key>: {` at depth 1.
  const findings: SourceFinding[] = [];
  let depthScan = 0;
  let i = 0;
  let blockStart = -1;
  let key: string | null = null;
  while (i < body.length) {
    const ch = body[i];
    if (depthScan === 0) {
      const m = body.slice(i).match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\{/);
      if (m) {
        key = m[1];
        blockStart = i + m[0].length;
        depthScan = 1;
        i = blockStart;
        continue;
      }
    }
    if (ch === '{') depthScan++;
    else if (ch === '}') {
      depthScan--;
      if (depthScan === 0 && key) {
        const block = body.slice(blockStart, i);
        findings.push(analyseSourceBlock(key, block));
        key = null;
      }
    }
    i++;
  }
  return findings;
}

function analyseSourceBlock(key: string, block: string): SourceFinding {
  const label = (block.match(/label\s*:\s*['"]([^'"]+)['"]/) ?? [])[1] ?? key;
  const primaryTable = (block.match(/primaryTable\s*:\s*['"]([^'"]+)['"]/) ?? [])[1] ?? '<unknown>';
  const primaryAlias = (block.match(/primaryAlias\s*:\s*['"]([^'"]+)['"]/) ?? [])[1] ?? '<unknown>';
  const softDelete   = /softDelete\s*:\s*true/.test(block);

  // Joins
  const joinClauses = [...block.matchAll(/on\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const joinCount = joinClauses.length;
  const joinsWithTenantEquality = joinClauses.filter((c) => TENANT_EQ_RE.test(c)).length;

  // Fields
  const fieldNames = [...block.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\{[^}]*alias\s*:/gm)].map((m) => m[1]);
  const fieldCount = fieldNames.length;
  const hasAgencyIdField = /\bdbCol\s*:\s*['"]agencyId['"]/.test(block);
  const hasTenantIdField = /\bdbCol\s*:\s*['"]tenantId['"]/.test(block);

  // Heuristic proposals
  const proposedTenantColumn = hasTenantIdField ? 'tenantId'
    : (primaryTable === 'agencies' ? 'tenantId' /* via Phase 1 column */ : 'tenantId');
  const proposedAgencyColumn = hasAgencyIdField ? 'agencyId' : null;

  const notes: string[] = [];
  let status: SourceFinding['status'] = 'READY';

  if (joinCount > 0 && joinsWithTenantEquality < joinCount) {
    status = 'BLOCKED';
    notes.push(`${joinCount - joinsWithTenantEquality} join(s) lack tenant_id equality.`);
  }
  if (!hasAgencyIdField && !hasTenantIdField) {
    if (status === 'READY') status = 'NEEDS_DECISION';
    notes.push('No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.');
  }
  if (joinCount === 0 && (hasAgencyIdField || hasTenantIdField)) {
    notes.push('Single-table source — engine adds tenant filter in WHERE; no join changes needed.');
  }

  return {
    key, label, primaryTable, primaryAlias, softDelete,
    joinCount, joinsWithTenantEquality, fieldCount,
    hasAgencyIdField, hasTenantIdField,
    proposedTenantColumn, proposedAgencyColumn,
    status, notes,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const src = await fs.readFile(REPORTS_TS, 'utf8');
  const findings = parseSources(src);

  const counts = {
    total:           findings.length,
    READY:           findings.filter((f) => f.status === 'READY').length,
    NEEDS_DECISION:  findings.filter((f) => f.status === 'NEEDS_DECISION').length,
    BLOCKED:         findings.filter((f) => f.status === 'BLOCKED').length,
  };

  const json = { generatedAt: new Date().toISOString(), counts, findings };
  await fs.writeFile(path.join(OUT_DIR, 'reports-source-validation.json'), JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# Phase 2 — Reports Source Validation (machine output)');
  md.push('');
  md.push(`Generated: ${json.generatedAt}`);
  md.push('');
  md.push(`- Total sources scanned: **${counts.total}**`);
  md.push(`- READY: ${counts.READY}`);
  md.push(`- NEEDS_DECISION: ${counts.NEEDS_DECISION}`);
  md.push(`- BLOCKED: ${counts.BLOCKED}`);
  md.push('');
  md.push('## Per-source');
  md.push('');
  md.push('| Source | Primary | Joins | Joins w/ tenant=tenant | Fields | tenantId? | agencyId? | Status | Proposed tenantColumn | Proposed agencyColumn |');
  md.push('|--------|---------|------:|-----------------------:|-------:|-----------|-----------|--------|-----------------------|-----------------------|');
  for (const f of findings) {
    md.push(`| \`${f.key}\` | \`${f.primaryTable}\` (${f.primaryAlias}) | ${f.joinCount} | ${f.joinsWithTenantEquality} | ${f.fieldCount} | ${f.hasTenantIdField ? 'yes' : 'no'} | ${f.hasAgencyIdField ? 'yes' : 'no'} | **${f.status}** | \`${f.proposedTenantColumn ?? '—'}\` | \`${f.proposedAgencyColumn ?? '—'}\` |`);
  }
  md.push('');
  md.push('## Notes per source');
  md.push('');
  for (const f of findings) {
    if (!f.notes.length) continue;
    md.push(`- **\`${f.key}\`**`);
    for (const n of f.notes) md.push(`  - ${n}`);
  }
  await fs.writeFile(path.join(OUT_DIR, 'reports-source-validation.md'), md.join('\n'));

  console.log(`reports-source-validation: ${counts.total} sources ` +
    `[READY=${counts.READY} NEEDS_DECISION=${counts.NEEDS_DECISION} BLOCKED=${counts.BLOCKED}]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
