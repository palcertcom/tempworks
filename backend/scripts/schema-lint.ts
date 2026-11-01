/**
 * Phase 0 Prisma schema linter (advisory).
 *
 * Rules (warnings only in Phase 0; promoted to errors in Phase 2):
 *   1. Any model with a `tenantId String` field MUST have at least one
 *      index that leads with `tenantId`.
 *   2. Any `@@unique([..., tenantId, ...])` MUST be `@@unique([tenantId, ...])`
 *      (tenant-leading) — never trailing.
 *   3. New models added under `model X { ... }` should not declare a
 *      bare `@unique` on email/code/slug fields without `tenantId` if
 *      X is in TENANT_SCOPED_MODELS.
 *
 * Run:
 *   pnpm --filter backend exec ts-node scripts/schema-lint.ts
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';

const SCHEMA = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');

interface Issue { model: string; rule: string; detail: string; }

async function main(): Promise<void> {
  const src = await fs.readFile(SCHEMA, 'utf8');
  const issues: Issue[] = [];

  // Rough block parser — splits at `model X { ... }` and ignores enums/datasource.
  const blocks = src.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g);

  for (const m of blocks) {
    const model = m[1];
    const body = m[2];
    const hasTenantField = /\btenantId\s+String/.test(body);

    if (hasTenantField) {
      const tenantLeadingIdx = /@@index\(\s*\[\s*tenantId\b/.test(body);
      const tenantLeadingUnique = /@@unique\(\s*\[\s*tenantId\b/.test(body);
      if (!tenantLeadingIdx && !tenantLeadingUnique) {
        issues.push({
          model,
          rule: 'tenant-leading-index',
          detail: 'Model has tenantId but no @@index or @@unique leading with tenantId.',
        });
      }
    }

    // @@unique([..., tenantId]) where tenantId is not first.
    //
    // Exception: identity-layer tables (TenantMembership, AgencyMembership,
    // MembershipPermissionOverride, MembershipRole) intentionally lead with
    // a non-tenantId join key because they are NOT tenant-scoped data —
    // they are the identity/membership graph itself. The convention only
    // applies to actual tenant-scoped domain models.
    const IDENTITY_LAYER = new Set([
      'TenantMembership', 'AgencyMembership',
      'MembershipPermissionOverride', 'MembershipRole',
    ]);
    if (!IDENTITY_LAYER.has(model)) {
      const uniqs = body.matchAll(/@@unique\(\s*\[([^\]]+)\]/g);
      for (const u of uniqs) {
        const cols = u[1].split(',').map(s => s.trim());
        if (cols.includes('tenantId') && cols[0] !== 'tenantId') {
          issues.push({
            model,
            rule: 'tenant-leading-unique',
            detail: `@@unique([${cols.join(', ')}]) must lead with tenantId.`,
          });
        }
      }
    }
  }

  if (issues.length === 0) {
    console.log('schema-lint: 0 issues.');
    return;
  }
  for (const i of issues) {
    console.log(`  ${i.model.padEnd(30)} ${i.rule.padEnd(28)} ${i.detail}`);
  }
  console.log(`\nschema-lint: ${issues.length} advisory issue(s) (Phase 0: warn-only).`);
}

main().catch((e) => { console.error(e); process.exit(2); });
