/**
 * Recon B — Agency → Tenant Projection.
 *
 * Computes the projected Tenant + Default-Agency layout for every customer
 * agency. Validates slug rules; flags reserved-slug and duplicate-slug
 * conflicts. Emits a per-agency mapping that the dry-run backfill consumes.
 *
 * Read-only by default. `--apply` only writes to `saas_reconciliation_queue`.
 */
import { runRecon, tableExists, columnExists, ReconAction } from './lib/recon';

const RESERVED_SLUGS = new Set([
  'api','app','admin','auth','www','root','system','support','ops','status','billing',
  'platform','tempworks','public','internal','dev','staging','test','sandbox',
  'help','docs','mail','smtp','ftp','db','pgadmin','pg','postgres','redis',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(16).padStart(6, '0').slice(0, 6);
}

async function main(): Promise<void> {
  await runRecon('B-agency-tenant-projection', 'Recon B — Agency → Tenant Projection', async ({ c, mode }) => {
    const metrics: { key: string; value: any; note?: string }[] = [];
    const actions: ReconAction[] = [];
    const notes: string[] = [];
    let status: 'OK' | 'WARN' | 'BLOCKER' = 'OK';

    if (!(await tableExists(c, 'agencies'))) {
      return { metrics, actions, status: 'BLOCKER', notes: ['agencies table not found'] };
    }
    const sysCol = await columnExists(c, 'agencies', 'isSystem');

    const all = await c.query<{ id: string; name: string; isSystem: boolean | null }>(
      `SELECT id::text, name, ${sysCol ? '"isSystem"' : 'false AS "isSystem"'} FROM agencies ORDER BY "createdAt" NULLS LAST, id`,
    );
    metrics.push({ key: 'agencies.total', value: all.rowCount ?? 0 });

    const customer = all.rows.filter((r) => !r.isSystem);
    metrics.push({ key: 'agencies.customer', value: customer.length });
    metrics.push({ key: 'agencies.system',   value: all.rows.length - customer.length });

    // 1. Generate slug candidates and detect conflicts
    const usedSlugs = new Set<string>();
    const projection: Array<{
      agencyId: string;
      name: string;
      tenantId: string;        // reuses agency.id
      proposedSlug: string;
      slugConflicts: string[];
      defaultAgencyId: string;
    }> = [];
    for (const a of customer) {
      const base = slugify(a.name) || `tenant-${shortHash(a.id)}`;
      let slug = base;
      const conflicts: string[] = [];
      if (!SLUG_RE.test(slug)) {
        conflicts.push('regex');
        slug = `t-${shortHash(a.id)}`;
      }
      if (RESERVED_SLUGS.has(slug)) {
        conflicts.push('reserved');
        slug = `${base}-co`;
      }
      if (usedSlugs.has(slug)) {
        conflicts.push('duplicate');
        slug = `${base}-${shortHash(a.id)}`;
      }
      usedSlugs.add(slug);
      projection.push({
        agencyId: a.id,
        name: a.name,
        tenantId: a.id,                      // reuse
        proposedSlug: slug,
        slugConflicts: conflicts,
        // The actual UUID for the new Default Agency is computed by the
        // backfill script at runtime; we record a placeholder here.
        defaultAgencyId: '<assigned-at-backfill>',
      });
      if (conflicts.length) {
        if (status === 'OK') status = 'WARN';
        actions.push({
          kind: 'agency.slug-conflict',
          subject: { agencyId: a.id, name: a.name, baseSlug: base, finalSlug: slug, conflicts },
          proposedDecision: `use slug "${slug}" (manual override allowed via queue.subject.slug)`,
          applied: false,
        });
      }
    }
    metrics.push({ key: 'projection.tenants', value: projection.length });
    actions.push({
      kind: 'projection.summary',
      subject: { sample: projection.slice(0, 10), totalTenants: projection.length },
      proposedDecision: 'apply-as-is',
      applied: false,
    });

    // 2. Detect agencies that already have a tenantId set (idempotency)
    if (await columnExists(c, 'agencies', 'tenantId')) {
      const already = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM agencies WHERE "tenantId" IS NOT NULL`,
      )).rows[0].n;
      metrics.push({ key: 'agencies.already-tenant-mapped', value: already });
      if (already > 0) {
        actions.push({
          kind: 'projection.already-mapped',
          subject: { count: already },
          proposedDecision: 'skip (idempotent)',
          applied: false,
        });
      }
    }

    // 3. Write proposals to queue
    if (mode === 'apply' && (await tableExists(c, 'saas_reconciliation_queue'))) {
      for (const p of projection) {
        await c.query(
          `INSERT INTO saas_reconciliation_queue (kind, subject, decision)
                VALUES ($1, $2::jsonb, 'pending')`,
          [
            'projection.tenant-mapping',
            JSON.stringify({
              agencyId: p.agencyId,
              name: p.name,
              proposedSlug: p.proposedSlug,
              slugConflicts: p.slugConflicts,
            }),
          ],
        );
      }
      for (const a of actions) a.applied = true;
    }

    notes.push(
      'Tenant.id reuses Agency.id (ADR-003).',
      'Default Agency UUID is freshly generated at backfill time and recorded in agency_split_progress.',
      `Reserved-slug list size: ${RESERVED_SLUGS.size}. Update by editing this file + Phase 0 reserved-slugs constant.`,
    );

    return { metrics, actions, notes, status };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
