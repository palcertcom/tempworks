/**
 * Phase 3.17 — Multi-tenant login via TenantMembership harness.
 *
 *  1.  schema check: TenantMembership model is reachable from Prisma
 *  2.  one user × two tenants → loginV2 succeeds for tenant A
 *  3.  same user × tenant B → loginV2 succeeds for tenant B
 *  4.  wrong tenant slug for the same email → generic 401
 *  5.  user without membership in tenant → generic 401
 *  6.  JWT carries tenantId + membershipId for the active session
 *  7.  /auth/me returns memberships array including both tenants
 *  8.  switchTenant issues a new JWT bound to the target tenant
 *  9.  switchTenant rejects when no active membership
 * 10.  grantMembership creates an ACTIVE row (idempotent)
 * 11.  revokeMembership flips status=REMOVED and blocks subsequent login
 * 12.  legacy backfill: user with no membership but matching agency.tenantId
 *      gets a membership row auto-created on first loginV2
 * 13.  scan-annotations policy includes phase317-multi-tenant-login
 * 14.  cumulative regression chain wiring intact
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import * as bcrypt from 'bcryptjs';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuthService } from '../../../src/auth/auth.service';
import { TenantsService } from '../../../src/tenants/tenants.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuditLogService } from '../../../src/logs/audit-log.service';
import { EmailService } from '../../../src/email/email.service';
import { PlatformAdminAccessService } from '../../../src/saas/platform-admin/platform-admin-access.service';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');

const SEED = '00000000-0000-0000-0000-0000031700';
const ID = {
  tenantA: `${SEED}TA`,
  tenantB: `${SEED}TB`,
  tenantC: `${SEED}TC`, // legacy-only fallback path
  agencyA: `${SEED}AA`,
  agencyB: `${SEED}AB`,
  agencyC: `${SEED}AC`,
  userMulti: `${SEED}U1`,
  userSolo:  `${SEED}U2`,
};
const PASSWORD = 'p3-17-test-password';

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

async function seed(c: Client) {
  // Clean previous runs.
  await c.query(`DELETE FROM tenant_memberships WHERE "userId" IN ($1,$2)`, [ID.userMulti, ID.userSolo]).catch(() => undefined);
  await c.query(`DELETE FROM users WHERE id IN ($1,$2)`, [ID.userMulti, ID.userSolo]);
  await c.query(`DELETE FROM agencies WHERE id IN ($1,$2,$3)`, [ID.agencyA, ID.agencyB, ID.agencyC]);
  await c.query(`DELETE FROM tenants WHERE id IN ($1,$2,$3)`, [ID.tenantA, ID.tenantB, ID.tenantC]);

  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0]?.id;
  if (!roleId) throw new Error('no roles seeded — phase 3.17 harness needs a baseline DB');

  await c.query(`INSERT INTO tenants (id, slug, name, status, region, "createdAt", "updatedAt") VALUES
    ($1, 'p317-tenant-a', 'P317 Tenant A', 'ACTIVE', 'eu', now(), now()),
    ($2, 'p317-tenant-b', 'P317 Tenant B', 'ACTIVE', 'eu', now(), now()),
    ($3, 'p317-tenant-c', 'P317 Tenant C', 'ACTIVE', 'eu', now(), now())`,
    [ID.tenantA, ID.tenantB, ID.tenantC]);

  await c.query(`INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "tenantId", "createdAt", "updatedAt") VALUES
    ($1, 'P317 Agency A', 'XX', 'C', 'a@p317.test', '0', $4, now(), now()),
    ($2, 'P317 Agency B', 'XX', 'C', 'b@p317.test', '0', $5, now(), now()),
    ($3, 'P317 Agency C', 'XX', 'C', 'c@p317.test', '0', $6, now(), now())`,
    [ID.agencyA, ID.agencyB, ID.agencyC, ID.tenantA, ID.tenantB, ID.tenantC]);

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await c.query(`INSERT INTO users (id, email, "passwordHash", "firstName","lastName","roleId","agencyId",status,"createdAt","updatedAt") VALUES
    ($1, 'p317-multi@e.com', $3, 'Multi','User', $4, $5, 'ACTIVE', now(), now()),
    ($2, 'p317-solo@e.com',  $3, 'Solo','User',  $4, $6, 'ACTIVE', now(), now())`,
    [ID.userMulti, ID.userSolo, passwordHash, roleId, ID.agencyA, ID.agencyC]);

  // Multi user gets explicit memberships in A and B. Solo user has no
  // membership row — case 12 exercises the legacy auto-backfill path.
  await c.query(`INSERT INTO tenant_memberships (id, "userId", "tenantId", status, "createdAt", "updatedAt", "joinedAt") VALUES
    (gen_random_uuid(), $1, $2, 'ACTIVE', now(), now(), now()),
    (gen_random_uuid(), $1, $3, 'ACTIVE', now(), now(), now())`,
    [ID.userMulti, ID.tenantA, ID.tenantB]);
}

async function cleanup(c: Client) {
  await c.query(`DELETE FROM tenant_memberships WHERE "userId" IN ($1,$2)`, [ID.userMulti, ID.userSolo]).catch(() => undefined);
  await c.query(`DELETE FROM users    WHERE id IN ($1,$2)`,         [ID.userMulti, ID.userSolo]).catch(() => undefined);
  await c.query(`DELETE FROM agencies WHERE id IN ($1,$2,$3)`,      [ID.agencyA, ID.agencyB, ID.agencyC]).catch(() => undefined);
  await c.query(`DELETE FROM tenants  WHERE id IN ($1,$2,$3)`,      [ID.tenantA, ID.tenantB, ID.tenantC]).catch(() => undefined);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  const c = pgClient(url); await c.connect();
  try {
    await seed(c);

    const prisma = new PrismaService();
    await prisma.$connect();

    const jwt = new JwtService({});
    const config = new ConfigService();
    const audit = { log: async () => undefined } as unknown as AuditLogService;
    const email = { sendApplicationConfirmation: async () => undefined } as unknown as EmailService;
    const platformAccess = new PlatformAdminAccessService(prisma);
    const auth = new AuthService(prisma, jwt, config, audit, email, platformAccess);
    const tenants = new TenantsService(prisma);

    // 1 — schema reachable
    let schemaOk = false;
    try {
      await (prisma as any).tenantMembership.findFirst({ select: { id: true } });
      schemaOk = true;
    } catch (err: any) { schemaOk = false; }
    out.push({ name: '1. TenantMembership reachable via Prisma', ok: schemaOk, detail: schemaOk ? 'ok' : 'model missing' });

    // 2 — loginV2 succeeds for tenant A
    let resA: any = null;
    try {
      resA = await auth.loginV2({ company: 'p317-tenant-a', email: 'p317-multi@e.com', password: PASSWORD });
    } catch (err: any) { resA = { error: err?.response?.code ?? err?.message ?? String(err) }; }
    out.push({ name: '2. loginV2 succeeds for tenant A', ok: !!resA?.accessToken, detail: resA?.accessToken ? 'token issued' : (resA?.error ?? 'no token') });

    // 3 — loginV2 succeeds for tenant B
    let resB: any = null;
    try {
      resB = await auth.loginV2({ company: 'p317-tenant-b', email: 'p317-multi@e.com', password: PASSWORD });
    } catch (err: any) { resB = { error: err?.response?.code ?? err?.message ?? String(err) }; }
    out.push({ name: '3. loginV2 succeeds for tenant B', ok: !!resB?.accessToken, detail: resB?.accessToken ? 'token issued' : (resB?.error ?? 'no token') });

    // 4 — wrong tenant slug → 401
    let bogus = false;
    try {
      await auth.loginV2({ company: 'no-such-tenant', email: 'p317-multi@e.com', password: PASSWORD });
    } catch (err: any) { bogus = err?.response?.code === 'AUTH.INVALID_CREDENTIALS'; }
    out.push({ name: '4. wrong tenant slug → generic 401', ok: bogus, detail: bogus ? 'AUTH.INVALID_CREDENTIALS' : 'no error' });

    // 5 — user without membership in tenant C (no membership for multi-user there)
    let noMember = false;
    try {
      await auth.loginV2({ company: 'p317-tenant-c', email: 'p317-multi@e.com', password: PASSWORD });
    } catch (err: any) { noMember = err?.response?.code === 'AUTH.INVALID_CREDENTIALS'; }
    out.push({ name: '5. user without membership → generic 401', ok: noMember, detail: noMember ? 'AUTH.INVALID_CREDENTIALS' : 'no error' });

    // 6 — JWT carries tenantId + membershipId
    const decodedA: any = resA?.accessToken ? jwt.decode(resA.accessToken) : null;
    const jwtOk = decodedA?.tenantId === ID.tenantA && typeof decodedA?.membershipId === 'string';
    out.push({ name: '6. JWT carries tenantId + membershipId', ok: jwtOk, detail: jwtOk ? `tenantId=${decodedA.tenantId}` : `payload=${JSON.stringify(decodedA)}` });

    // 7 — /auth/me memberships array contains both tenants
    let memOk = false;
    try {
      const me = await auth.getMe(ID.userMulti);
      const set = new Set((me as any).memberships?.map((m: any) => m.tenantId));
      memOk = set.has(ID.tenantA) && set.has(ID.tenantB);
    } catch { memOk = false; }
    out.push({ name: '7. /auth/me lists both tenant memberships', ok: memOk, detail: memOk ? 'A+B present' : 'missing' });

    // 8 — switchTenant issues a new JWT for B (assuming session for A)
    let switchOk = false;
    try {
      const sw = await auth.switchTenant(ID.userMulti, ID.tenantB);
      const decoded: any = jwt.decode(sw.accessToken);
      switchOk = decoded?.tenantId === ID.tenantB;
    } catch { switchOk = false; }
    out.push({ name: '8. switchTenant issues a tenant-B-bound JWT', ok: switchOk, detail: switchOk ? 'rebound' : 'failed' });

    // 9 — switchTenant rejects when no membership
    let switchRejectOk = false;
    try {
      await auth.switchTenant(ID.userMulti, ID.tenantC);
    } catch (err: any) {
      switchRejectOk = err?.response?.code === 'AUTH.TENANT_MEMBERSHIP_REQUIRED';
    }
    out.push({ name: '9. switchTenant rejects without membership', ok: switchRejectOk, detail: switchRejectOk ? 'AUTH.TENANT_MEMBERSHIP_REQUIRED' : 'no error' });

    // 10 — grantMembership creates ACTIVE row
    let granted: any;
    try {
      granted = await tenants.grantMembership(ID.tenantC, ID.userMulti, ID.userMulti);
    } catch (err: any) { granted = { error: err?.response?.code ?? err?.message ?? String(err) }; }
    const grantOk = granted?.status === 'ACTIVE';
    out.push({ name: '10. grantMembership creates ACTIVE row', ok: grantOk, detail: grantOk ? granted.id : (granted?.error ?? 'fail') });

    // 11 — revokeMembership flips to REMOVED and blocks login
    let revokeOk = false;
    try {
      await tenants.revokeMembership(ID.tenantC, ID.userMulti, /* actor */ ID.userSolo);
      const row = await c.query<{ status: string }>(
        `SELECT status FROM tenant_memberships WHERE "userId"=$1 AND "tenantId"=$2`,
        [ID.userMulti, ID.tenantC],
      );
      revokeOk = row.rows[0]?.status === 'REMOVED';
    } catch { revokeOk = false; }
    if (revokeOk) {
      try {
        await auth.loginV2({ company: 'p317-tenant-c', email: 'p317-multi@e.com', password: PASSWORD });
        revokeOk = false;
      } catch (err: any) {
        revokeOk = err?.response?.code === 'AUTH.INVALID_CREDENTIALS';
      }
    }
    out.push({ name: '11. revokeMembership blocks subsequent login', ok: revokeOk, detail: revokeOk ? 'REMOVED + 401' : 'still allowed' });

    // 12 — legacy backfill on first loginV2 (solo user has agency.tenantId=C but no membership row)
    let backfillOk = false;
    try {
      const res = await auth.loginV2({ company: 'p317-tenant-c', email: 'p317-solo@e.com', password: PASSWORD });
      const decoded: any = jwt.decode(res.accessToken);
      const row = await c.query<{ status: string }>(
        `SELECT status FROM tenant_memberships WHERE "userId"=$1 AND "tenantId"=$2`,
        [ID.userSolo, ID.tenantC],
      );
      backfillOk = !!res.accessToken && row.rows[0]?.status === 'ACTIVE' && decoded?.tenantId === ID.tenantC;
    } catch { backfillOk = false; }
    out.push({ name: '12. legacy backfill on first loginV2', ok: backfillOk, detail: backfillOk ? 'membership auto-created' : 'no row' });

    // 13 — scanner policy includes phase317-multi-tenant-login
    const scanSrc = await fs.readFile(path.join(BACKEND_ROOT, 'scripts', 'scan-annotations.ts'), 'utf8');
    out.push({ name: '13. scan-annotations policy includes phase317', ok: /phase317-multi-tenant-login/.test(scanSrc), detail: 'policy edit' });

    // 14 — cumulative regression chain wiring intact
    const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
    const chainOk = [
      'saas:phase315-tenant-management-module',
      'saas:phase314-frontend-tenant-login-check',
      'saas:phase313-tenant-aware-login',
      'saas:phase312-platform-admin-controller',
      'saas:phase311-platform-admin-grant-revoke',
    ].every((s) => pkg.includes(s));
    out.push({ name: '14. cumulative regression chain wiring intact', ok: chainOk, detail: chainOk ? 'present' : 'missing' });

    await prisma.$disconnect();
  } finally {
    await cleanup(c).catch(() => undefined);
    await c.end().catch(() => undefined);
  }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'multi-tenant-login.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.17 — Multi-tenant login via TenantMembership harness`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'multi-tenant-login.md'), md);
  console.log(`[multi-tenant-login] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
