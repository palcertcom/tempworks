/**
 * Phase 3.15 — Tenant Management Module harness.
 *
 *  1.  SUPER can create tenant (service-level happy path)
 *  2.  slug uniqueness enforced (duplicate rejected)
 *  3.  customDomain uniqueness enforced (duplicate rejected)
 *  4.  OPERATOR cannot delete tenant (controller route requires SUPER)
 *  5.  SUPPORT is read-only (service rejects update with READ_ONLY)
 *  6.  non-platform user is forbidden by the guard
 *  7.  soft-delete works (status=INACTIVE + branding.deletedAt)
 *  8.  restore works (status returns to ACTIVE, deletedAt cleared)
 *  9.  archive/deactivate works (status=SUSPENDED + branding.archivedAt)
 * 10.  sidebar visibility respects PlatformAdmin level
 * 11.  i18n keys exist in every supported locale
 * 12.  RTL renders correctly (Arabic strings present, sidebar uses logical props)
 * 13.  audit rows emitted (platform_audit_logs gains a row per mutation)
 * 14.  tenant isolation preserved (existing tenant rows unaffected)
 * 15.  logo + branding fields round-trip through the service
 * 16.  pagination/search/filter work
 * 17.  deleted tenants hidden by default (includeDeleted=false)
 * 18.  duplicate slug rejected at update time
 * 19.  duplicate domain rejected at update time
 * 20.  cumulative regression chain wiring intact
 *
 * @tenant-reviewed: phase315-tenant-management-module
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { TenantsService } from '../../../src/tenants/tenants.service';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const LOCALES_DIR = path.resolve(REPO_ROOT, 'src', 'i18n', 'locales');
const TENANTS_DIR = path.resolve(BACKEND_ROOT, 'src', 'tenants');
const SIDEBAR_PATH = path.resolve(REPO_ROOT, 'src', 'app', 'components', 'layout', 'Sidebar.tsx');

const SEED = '00000000-0000-0000-0000-0000031500';
const ID = {
  uSuper:    `${SEED}U1`,
  uOperator: `${SEED}U2`,
  uSupport:  `${SEED}U3`,
  uPlain:    `${SEED}U4`,
};
const SLUG_A = 'p315-tenant-a';
const SLUG_B = 'p315-tenant-b';
const DOMAIN_A = 'a.p315.example';
const DOMAIN_B = 'b.p315.example';

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

async function exists(p: string): Promise<boolean> { return fs.stat(p).then(() => true).catch(() => false); }

async function seed(c: Client) {
  // Clean tenants from previous runs.
  await c.query(`DELETE FROM tenants WHERE slug LIKE 'p315-%'`);
  await c.query(`DELETE FROM platform_audit_logs WHERE reason = 'tenant-mgmt-ui'`).catch(() => undefined);

  // Ensure a system role + agency exist so we can attach test users.
  const role = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const agency = await c.query<{ id: string }>(`SELECT id FROM agencies LIMIT 1`);
  const roleId = role.rows[0]?.id;
  const agencyId = agency.rows[0]?.id;
  if (!roleId || !agencyId) throw new Error('No roles or agencies seeded; harness needs a baseline DB');

  await c.query(`DELETE FROM platform_admins WHERE "userId" IN ($1,$2,$3,$4)`,
    [ID.uSuper, ID.uOperator, ID.uSupport, ID.uPlain]);
  await c.query(`DELETE FROM users WHERE id IN ($1,$2,$3,$4)`,
    [ID.uSuper, ID.uOperator, ID.uSupport, ID.uPlain]);

  for (const [uid, email] of [
    [ID.uSuper,    'p315-super@x'],
    [ID.uOperator, 'p315-op@x'],
    [ID.uSupport,  'p315-sup@x'],
    [ID.uPlain,    'p315-plain@x'],
  ]) {
    await c.query(`INSERT INTO users (id, email, "passwordHash", "firstName","lastName","roleId","agencyId",status,"createdAt","updatedAt")
      VALUES ($1, $2, 'x', 'A', 'B', $3, $4, 'ACTIVE', now(), now())`, [uid, email, roleId, agencyId]);
  }

  await c.query(`INSERT INTO platform_admins ("userId", level, "grantedAt") VALUES
    ($1, 'SUPER', now()), ($2, 'OPERATOR', now()), ($3, 'SUPPORT', now())`,
    [ID.uSuper, ID.uOperator, ID.uSupport]);
}

async function cleanup(c: Client) {
  await c.query(`DELETE FROM tenants WHERE slug LIKE 'p315-%'`);
  await c.query(`DELETE FROM platform_admins WHERE "userId" IN ($1,$2,$3,$4)`,
    [ID.uSuper, ID.uOperator, ID.uSupport, ID.uPlain]);
  await c.query(`DELETE FROM users WHERE id IN ($1,$2,$3,$4)`,
    [ID.uSuper, ID.uOperator, ID.uSupport, ID.uPlain]);
  await c.query(`DELETE FROM platform_audit_logs WHERE reason = 'tenant-mgmt-ui'`).catch(() => undefined);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  const c = pgClient(url); await c.connect();
  try {
    const preTenantCount = (await c.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tenants WHERE slug NOT LIKE 'p315-%'`)).rows[0]?.n;

    await seed(c);

    const prisma = new PrismaService();
    await prisma.$connect();
    const tenants = new TenantsService(prisma);

    // 1 — SUPER can create.
    let createdA: any;
    try {
      createdA = await tenants.create({
        name: 'P315 Tenant A', slug: SLUG_A, customDomain: DOMAIN_A,
        primaryColor: '#112233', timezone: 'Europe/Berlin', locale: 'en',
        contactEmail: 'a@p315.example', logoUrl: 'https://p315.example/a.png',
      } as any, ID.uSuper);
      out.push({ name: '1. SUPER can create tenant', ok: !!createdA?.id, detail: `id=${createdA?.id}` });
    } catch (err: any) {
      out.push({ name: '1. SUPER can create tenant', ok: false, detail: err?.message ?? String(err) });
    }

    // 2 — slug uniqueness.
    let dupSlugOk = false;
    try {
      await tenants.create({ name: 'dup', slug: SLUG_A } as any, ID.uSuper);
    } catch (err: any) {
      dupSlugOk = err?.response?.code === 'TENANT.SLUG_TAKEN' || /SLUG_TAKEN/.test(String(err?.message ?? err));
    }
    out.push({ name: '2. duplicate slug rejected on create', ok: dupSlugOk, detail: dupSlugOk ? 'TENANT.SLUG_TAKEN' : 'no conflict raised' });

    // 3 — customDomain uniqueness.
    let dupDomOk = false;
    try {
      await tenants.create({ name: 'dup-dom', slug: 'p315-dup-dom', customDomain: DOMAIN_A } as any, ID.uSuper);
    } catch (err: any) {
      dupDomOk = err?.response?.code === 'TENANT.DOMAIN_TAKEN' || /DOMAIN_TAKEN/.test(String(err?.message ?? err));
    }
    out.push({ name: '3. duplicate customDomain rejected on create', ok: dupDomOk, detail: dupDomOk ? 'TENANT.DOMAIN_TAKEN' : 'no conflict raised' });

    // create a second tenant for isolation / pagination checks.
    const createdB = await tenants.create({
      name: 'P315 Tenant B', slug: SLUG_B, customDomain: DOMAIN_B,
    } as any, ID.uSuper);

    // 4 — OPERATOR cannot delete (route-level RBAC). We confirm via
    //     controller decorator metadata on the handler.
    const controllerSrc = await fs.readFile(path.join(TENANTS_DIR, 'tenants.controller.ts'), 'utf8');
    const deleteIsSuper = /@Delete\(':id'\)[\s\S]+?@RequireTenantLevel\('SUPER'\)/.test(controllerSrc);
    out.push({ name: '4. DELETE /tenants/:id requires SUPER level', ok: deleteIsSuper, detail: deleteIsSuper ? 'decorator present' : 'missing' });

    // 5 — SUPPORT is read-only at service layer.
    let supportRoOk = false;
    try {
      await tenants.update(createdA.id, { name: 'new-name' } as any, ID.uSupport, 'SUPPORT');
    } catch (err: any) {
      supportRoOk = err?.response?.code === 'TENANT.READ_ONLY' || /READ_ONLY/.test(String(err?.message ?? err));
    }
    out.push({ name: '5. SUPPORT cannot update (READ_ONLY)', ok: supportRoOk, detail: supportRoOk ? 'TENANT.READ_ONLY' : 'no error raised' });

    // 6 — non-platform user forbidden by guard. We assert against the
    //     guard file (no Nest mount here): the guard requires a
    //     PlatformAdmin row and throws otherwise.
    const guardSrc = await fs.readFile(path.join(TENANTS_DIR, 'platform-tenant.guard.ts'), 'utf8');
    const nonPaForbidden = /TENANT\.NOT_PLATFORM_ADMIN/.test(guardSrc) && /platformAdmin\.findUnique/.test(guardSrc);
    out.push({ name: '6. non-PlatformAdmin user forbidden by guard', ok: nonPaForbidden, detail: 'guard asserts row + level' });

    // 7 — soft-delete.
    const deleted = await tenants.softDelete(createdA.id, ID.uSuper, { force: true });
    const softOk = deleted.status === 'INACTIVE' && !!deleted.deletedAt;
    out.push({ name: '7. soft-delete sets status=INACTIVE + deletedAt', ok: softOk, detail: `status=${deleted.status} deletedAt=${!!deleted.deletedAt}` });

    // 8 — restore.
    const restored = await tenants.restore(createdA.id, ID.uSuper);
    const restoreOk = restored.status === 'ACTIVE' && restored.deletedAt === null;
    out.push({ name: '8. restore clears deletedAt + sets ACTIVE', ok: restoreOk, detail: `status=${restored.status} deletedAt=${restored.deletedAt}` });

    // 9 — archive/deactivate.
    const archived = await tenants.archive(createdA.id, ID.uSuper);
    const archOk = archived.status === 'SUSPENDED' && !!archived.archivedAt;
    out.push({ name: '9. archive sets status=SUSPENDED + archivedAt', ok: archOk, detail: `status=${archived.status}` });
    await tenants.activate(createdA.id, ID.uSuper);

    // 10 — sidebar visibility respects PlatformAdmin level.
    const sidebarSrc = await fs.readFile(SIDEBAR_PATH, 'utf8');
    const sidebarGate =
      /platformAdminLevel\?\s*:\s*'SUPPORT'\s*\|\s*'OPERATOR'\s*\|\s*'SUPER'/.test(sidebarSrc) &&
      /labelKey:\s*'tenants'/.test(sidebarSrc) &&
      /PA_RANK\[viewerPaLevel\]\s*>=\s*PA_RANK\[item\.platformAdminLevel\]/.test(sidebarSrc);
    out.push({ name: '10. sidebar gates Tenants entry by PlatformAdmin level', ok: sidebarGate, detail: sidebarGate ? 'PA_RANK + level field' : 'gate missing' });

    // 11 — i18n keys exist in every supported locale (en, ar, de, ru, sk, tr).
    //      Pseudo is materialized at runtime from English; we still check
    //      its file if present to ensure consistency.
    const locales = ['en', 'ar', 'de', 'ru', 'sk', 'tr'];
    const missing: string[] = [];
    for (const l of locales) {
      const pj = JSON.parse(await fs.readFile(path.join(LOCALES_DIR, l, 'pages.json'), 'utf8'));
      if (!pj.tenants || !pj.tenants.list || !pj.tenants.list.title) missing.push(l);
      const nj = JSON.parse(await fs.readFile(path.join(LOCALES_DIR, l, 'nav.json'), 'utf8'));
      if (!nj.tenants) missing.push(`${l}:nav`);
    }
    out.push({ name: '11. i18n keys exist in en/ar/de/ru/sk/tr (+pseudo derived)', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(',')}` : 'all locales OK' });

    // 12 — RTL/Arabic: ensure Arabic strings are present in the page bundle
    //      AND that the list/form pages use logical CSS (me-/ms-/ps-/end-) rather
    //      than hard-coded directional classes like mr-/ml-.
    const arPages = JSON.parse(await fs.readFile(path.join(LOCALES_DIR, 'ar', 'pages.json'), 'utf8'));
    const arabicPresent = typeof arPages.tenants?.list?.title === 'string' && /[؀-ۿ]/.test(arPages.tenants.list.title);
    const listSrc = await fs.readFile(path.resolve(REPO_ROOT, 'src/app/pages/tenants/TenantsList.tsx'), 'utf8');
    const logicalCss = /me-\d|ms-\d|ps-\d|pe-\d|end-/.test(listSrc) && !/\bml-\d|\bmr-\d|\bleft-3\b/.test(listSrc);
    out.push({ name: '12. RTL ready (Arabic strings + logical CSS)', ok: arabicPresent && logicalCss, detail: `arabic=${arabicPresent} logical=${logicalCss}` });

    // 13 — audit rows emitted.
    const auditRows = await c.query<{ n: string; action: string }>(
      `SELECT COUNT(*)::text AS n, action FROM platform_audit_logs
        WHERE "tenantId" IN ($1, $2) GROUP BY action`,
      [createdA.id, createdB.id],
    ).catch(() => ({ rows: [] as { n: string; action: string }[] }));
    const distinctActions = new Set(auditRows.rows.map((r) => r.action));
    const auditOk = ['TENANT_CREATED', 'TENANT_DELETED', 'TENANT_RESTORED', 'TENANT_ARCHIVED', 'TENANT_STATUS_CHANGED']
      .every((a) => distinctActions.has(a));
    out.push({ name: '13. audit rows emitted for major mutations', ok: auditOk, detail: `actions=${[...distinctActions].join('|')}` });

    // 14 — tenant isolation preserved: pre-existing non-p315 tenants still present.
    const postTenantCount = (await c.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tenants WHERE slug NOT LIKE 'p315-%'`)).rows[0]?.n;
    out.push({ name: '14. existing tenant rows unaffected', ok: preTenantCount === postTenantCount, detail: `pre=${preTenantCount} post=${postTenantCount}` });

    // 15 — branding/logo round-trip.
    const fetched = await tenants.findOne(createdA.id);
    const brandingOk =
      fetched.primaryColor === '#112233' &&
      fetched.logoUrl === 'https://p315.example/a.png' &&
      fetched.timezone === 'Europe/Berlin' &&
      fetched.locale === 'en';
    out.push({ name: '15. branding (logo/color/timezone/locale) round-trips', ok: brandingOk, detail: JSON.stringify({ pc: fetched.primaryColor, lg: fetched.logoUrl }) });

    // 16 — pagination/search/filter.
    const listed = await tenants.list({ search: 'p315', page: 1, limit: 10 });
    const search = await tenants.list({ search: 'tenant-b' });
    const filterStatus = await tenants.list({ status: 'ACTIVE' });
    const paginatedOk =
      listed.data.length >= 2 && listed.meta.totalPages >= 1 &&
      search.data.some((r) => r.slug === SLUG_B) &&
      filterStatus.data.every((r) => r.status === 'ACTIVE');
    out.push({ name: '16. pagination/search/filter work', ok: paginatedOk, detail: `listed=${listed.data.length} search=${search.data.length}` });

    // 17 — deleted hidden by default.
    await tenants.softDelete(createdB.id, ID.uSuper, { force: true });
    const defaultList = await tenants.list({});
    const includeList = await tenants.list({ includeDeleted: true });
    const hiddenOk = !defaultList.data.find((r) => r.id === createdB.id) && !!includeList.data.find((r) => r.id === createdB.id);
    out.push({ name: '17. deleted tenants hidden unless includeDeleted=true', ok: hiddenOk, detail: hiddenOk ? 'filter active' : 'leak' });

    // 18 — duplicate slug rejected on update.
    let updDupSlug = false;
    try { await tenants.update(createdA.id, { slug: SLUG_B } as any, ID.uSuper, 'SUPER'); }
    catch (err: any) { updDupSlug = err?.response?.code === 'TENANT.SLUG_TAKEN' || /SLUG_TAKEN/.test(String(err?.message ?? err)); }
    out.push({ name: '18. duplicate slug rejected on update', ok: updDupSlug, detail: updDupSlug ? 'TENANT.SLUG_TAKEN' : 'no conflict' });

    // 19 — duplicate customDomain rejected on update.
    let updDupDom = false;
    try { await tenants.update(createdA.id, { customDomain: DOMAIN_B } as any, ID.uSuper, 'SUPER'); }
    catch (err: any) { updDupDom = err?.response?.code === 'TENANT.DOMAIN_TAKEN' || /DOMAIN_TAKEN/.test(String(err?.message ?? err)); }
    out.push({ name: '19. duplicate customDomain rejected on update', ok: updDupDom, detail: updDupDom ? 'TENANT.DOMAIN_TAKEN' : 'no conflict' });

    // 20 — cumulative regression chain wiring intact.
    const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
    const chainOk = [
      'saas:phase314-frontend-tenant-login-check',
      'saas:phase313-tenant-aware-login',
      'saas:phase312-platform-admin-controller',
      'saas:phase311-platform-admin-grant-revoke',
      'saas:phase390-drop-agency-is-system',
    ].every((s) => pkg.includes(s));
    out.push({ name: '20. cumulative regression chain wiring intact', ok: chainOk, detail: chainOk ? 'all scripts present' : 'missing' });

    await prisma.$disconnect();
  } finally {
    await cleanup(c).catch(() => undefined);
    await c.end().catch(() => undefined);
  }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'tenant-management-module.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.15 — Tenant Management Module harness`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'tenant-management-module.md'), md);
  console.log(`[tenant-management-module] ${passed}/${total} PASS`);
  // Ensure the sentinel exists even when the runner does not fail-fast.
  await exists(path.join(PHASE3_REPORTS, 'tenant-management-module.json'));
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
