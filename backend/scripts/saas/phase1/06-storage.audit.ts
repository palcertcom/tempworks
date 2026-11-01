/**
 * Audit F — Storage paths.
 */
import { runAudit, tableExists, columnExists, AuditFinding, AuditMetric } from './lib/audit';
import path from 'path';

async function main(): Promise<void> {
  const outDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await runAudit('06-storage', 'Audit F — Storage', outDir, async (ctx) => {
    const m: AuditMetric[] = [];
    const f: AuditFinding[] = [];
    const c = ctx.client;

    if (!(await tableExists(c, 'documents'))) {
      f.push({ severity: 'INFO', rule: 'documents.absent', message: 'Documents table not present.' });
      return { metrics: m, findings: f };
    }
    const total = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM documents`)).rows[0].n;
    m.push({ key: 'documents.total', value: total });

    const hasUrl = await columnExists(c, 'documents', 'storageUrl');
    const hasKey = await columnExists(c, 'documents', 'storageKey');

    if (hasKey) {
      const kPresent = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM documents WHERE "storageKey" IS NOT NULL AND "storageKey" <> ''`,
      )).rows[0].n;
      m.push({ key: 'documents.with-storageKey', value: kPresent });
    }
    if (hasUrl) {
      const uPresent = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM documents WHERE "storageUrl" IS NOT NULL AND "storageUrl" <> ''`,
      )).rows[0].n;
      m.push({ key: 'documents.with-storageUrl', value: uPresent });
    }

    const missing = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM documents
        WHERE COALESCE("storageKey", '') = '' AND COALESCE("storageUrl", '') = ''`,
    )).rows[0].n;
    m.push({ key: 'documents.missing-storage', value: missing });
    if (missing > 0) {
      f.push({
        severity: 'WARN',
        rule: 'storage.missing-pointer',
        message: `${missing} documents have neither storageKey nor storageUrl. Investigate; rekey-skip on Phase 3.`,
      });
    }

    if (hasUrl) {
      // Local paths (legacy /uploads)
      const local = await c.query<{ n: number; sample: string }>(
        `SELECT count(*)::int n, MIN("storageUrl") sample FROM documents
          WHERE "storageUrl" LIKE '/uploads/%' OR "storageUrl" LIKE 'file:%'`,
      );
      m.push({ key: 'documents.legacy-local', value: local.rows[0]?.n ?? 0 });
      if ((local.rows[0]?.n ?? 0) > 0) {
        f.push({
          severity: 'WARN',
          rule: 'storage.local-path',
          message: `${local.rows[0].n} documents reference a legacy local /uploads path (sample: ${local.rows[0].sample}).`,
        });
      }
      // Public Spaces URLs (no signed token)
      const pub = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM documents
          WHERE "storageUrl" LIKE 'http%://%digitaloceanspaces.com%'
            AND "storageUrl" NOT LIKE '%X-Amz-Signature%'`,
      )).rows[0].n;
      m.push({ key: 'documents.public-spaces', value: pub });
      if (pub > 0) {
        f.push({
          severity: 'WARN',
          rule: 'storage.public-spaces',
          message: `${pub} documents stored as public-readable Spaces URLs (no signature). Will be rekeyed to tenants/<tenantId>/... in Phase 3.`,
        });
      }
      // Pattern detection: keys NOT prefixed with tenants/
      if (hasKey) {
        const notTenantPrefixed = (await c.query<{ n: number }>(
          `SELECT count(*)::int n FROM documents
            WHERE "storageKey" IS NOT NULL AND "storageKey" NOT LIKE 'tenants/%'`,
        )).rows[0].n;
        m.push({ key: 'documents.not-tenant-prefixed', value: notTenantPrefixed });
        if (notTenantPrefixed > 0) {
          f.push({
            severity: 'INFO',
            rule: 'storage.not-tenant-prefixed',
            message: `${notTenantPrefixed} documents have storageKey not under tenants/<tenantId>/...; required rekey count.`,
          });
        }
      }
    }

    // Other entities that hold their own asset URLs
    for (const [tbl, col] of [
      ['users', 'photoUrl'],
      ['employees', 'photoUrl'],
      ['applicants', 'photoUrl'],
      ['agencies', 'logoUrl'],
    ] as const) {
      if (await tableExists(c, tbl) && await columnExists(c, tbl, col)) {
        const n = (await c.query<{ n: number }>(
          `SELECT count(*)::int n FROM "${tbl}" WHERE "${col}" IS NOT NULL`,
        )).rows[0].n;
        m.push({ key: `${tbl}.${col}.set`, value: n });
      }
    }

    return {
      metrics: m,
      findings: f,
      notes: [
        'Phase 1 does NOT migrate any object. The audit just sizes the Phase 3 rekey + ACL flip job.',
        'Per ADR-006, frontend cutover precedes ACL flip.',
      ],
    };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
