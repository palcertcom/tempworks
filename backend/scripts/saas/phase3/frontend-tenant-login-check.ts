/**
 * Phase 3.14 — Frontend tenant-login source-level check.
 *
 * The frontend lives outside the backend tsconfig so we cannot
 * actually mount the React tree here. Instead we lock the migration
 * via source-level assertions on the LoginPage + auth API client +
 * runtime API simulation against the backend Phase 3.13 contract.
 *
 *  1.  LoginPage contains a Company field
 *  2.  Company field is required (`required` attribute on the input)
 *  3.  authApi.login routes to /auth/login-v2 when company is provided
 *  4.  Payload contains { company, email, password }
 *  5.  company and email normalized (trim + lowercase) before send
 *  6.  last company stored in localStorage (LAST_COMPANY_KEY)
 *  7.  password is NOT stored (no localStorage/sessionStorage write)
 *  8.  generic auth error shown for 401 (LoginPage uses single key)
 *  9.  legacy /auth/login fallback retained when company is empty
 * 10.  token/session handling unchanged (setTokens still called)
 * 11.  no user-facing error leaks tenant/email existence (single key)
 * 12.  Phase 3.13 backend tenant-aware-login still works against fixture
 * 13.  Phase 3.12 controller wiring intact
 * 14.  Phase 3.11 grant/revoke wiring intact
 * 15.  Phase 3.10 cleanup harness wiring intact
 * 16.  Phase 3.9 drop-agency-is-system wiring intact
 * 17.  cumulative regression chain outputs present
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const LOGIN_PAGE_PATH = path.resolve(REPO_ROOT, 'src', 'app', 'pages', 'public', 'LoginPage.tsx');
const API_CLIENT_PATH = path.resolve(REPO_ROOT, 'src', 'app', 'services', 'api.ts');

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
async function exists(p: string): Promise<boolean> { return fs.stat(p).then(() => true).catch(() => false); }

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  const loginSrc = await fs.readFile(LOGIN_PAGE_PATH, 'utf8');
  const apiSrc   = await fs.readFile(API_CLIENT_PATH, 'utf8');

  // 1
  out.push({ name: '1. LoginPage contains a Company field',
    ok: /id="company"/.test(loginSrc) && /companyLabel/.test(loginSrc),
    detail: 'company input present' });

  // 2 — required attribute on the company input
  const companyBlockMatch = loginSrc.match(/<Input[\s\S]+?id="company"[\s\S]+?\/>/);
  const companyRequired = !!companyBlockMatch && /\brequired\b/.test(companyBlockMatch[0]);
  out.push({ name: '2. Company field is required',
    ok: companyRequired, detail: companyRequired ? 'required' : 'not required' });

  // 3 — API client routes to /auth/login-v2 when company is provided
  const routesV2 = /\/auth\/login-v2/.test(apiSrc) && /normalizedCompany\s*\?\s*'\/auth\/login-v2'\s*:\s*'\/auth\/login'/.test(apiSrc);
  out.push({ name: '3. authApi.login routes to /auth/login-v2 when company provided',
    ok: routesV2, detail: routesV2 ? 'conditional path' : 'missing' });

  // 4 — Payload contains company, email, password
  const payloadShape = /\{\s*company:\s*normalizedCompany,\s*email:\s*normalizedEmail,\s*password\s*\}/.test(apiSrc);
  out.push({ name: '4. Payload contains { company, email, password }',
    ok: payloadShape, detail: payloadShape ? 'shape ok' : 'shape mismatch' });

  // 5 — normalize trim + lowercase
  const normalizes = /email\.trim\(\)\.toLowerCase\(\)/.test(apiSrc) && /company\s*\?\?\s*''\)\.trim\(\)\.toLowerCase\(\)/.test(apiSrc);
  out.push({ name: '5. company and email normalized (trim + lowercase)',
    ok: normalizes, detail: normalizes ? 'normalized' : 'missing' });

  // 6 — last company stored in localStorage
  const persists = /localStorage\.setItem\(LAST_COMPANY_KEY/.test(apiSrc) && /getLastCompany/.test(apiSrc);
  out.push({ name: '6. last company stored in localStorage (LAST_COMPANY_KEY)',
    ok: persists, detail: persists ? 'persisted' : 'missing' });

  // 7 — password NOT stored
  const apiNoPasswordStore = !/(localStorage|sessionStorage)\.setItem\([^)]*password/i.test(apiSrc);
  const loginNoPasswordStore = !/(localStorage|sessionStorage)\.setItem\([^)]*password/i.test(loginSrc);
  out.push({ name: '7. password is NOT stored (api + LoginPage)',
    ok: apiNoPasswordStore && loginNoPasswordStore,
    detail: apiNoPasswordStore && loginNoPasswordStore ? 'no password storage' : 'leak' });

  // 8 — single generic auth error key
  // LoginPage now sets `message = t('login.loginFailed')` for any caught error.
  const genericError = /const message = t\('login\.loginFailed'\);/.test(loginSrc);
  out.push({ name: '8. generic auth error shown for any 401',
    ok: genericError, detail: genericError ? 'generic only' : 'specific errors leak' });

  // 9 — legacy /auth/login fallback when company empty
  const legacyFallback = /'\/auth\/login'/.test(apiSrc) && /normalizedCompany\s*\?\s*'\/auth\/login-v2'\s*:\s*'\/auth\/login'/.test(apiSrc);
  out.push({ name: '9. legacy /auth/login fallback when company is empty',
    ok: legacyFallback, detail: legacyFallback ? 'present' : 'missing' });

  // 10 — token/session handling unchanged: setTokens called
  const setTokensIntact = /setTokens\(data\.accessToken,\s*data\.refreshToken\)/.test(apiSrc);
  out.push({ name: '10. token/session handling unchanged (setTokens called)',
    ok: setTokensIntact, detail: setTokensIntact ? 'unchanged' : 'changed' });

  // 11 — no user-facing error leaks tenant/email existence (no specific keys)
  const leaksKeys = /(login\.companyNotFound|login\.tenantNotFound|login\.emailNotFound|login\.invalidEmail|login\.invalidCompany)/.test(loginSrc);
  out.push({ name: '11. no user-facing error leaks tenant/email existence',
    ok: !leaksKeys, detail: leaksKeys ? 'leak keys present' : 'generic only' });

  // 12 — backend Phase 3.13 contract still resolves the seeded user.
  // Reuse the same fixture pattern but quickly: insert tenant + agency +
  // user + bcrypt hash, simulate the API client payload as { company,
  // email, password }, and verify the tenant resolution + user lookup
  // return the expected user.
  const c = pgClient(url); await c.connect();
  let backendOk = false;
  try {
    const t1 = '00000000-0000-0000-0000-0000003140TT';
    const a1 = '00000000-0000-0000-0000-0000003140AA';
    const u1 = '00000000-0000-0000-0000-0000003140UU';
    await c.query(`DELETE FROM users WHERE id = $1`, [u1]);
    await c.query(`DELETE FROM agencies WHERE id = $1`, [a1]);
    await c.query(`DELETE FROM tenants WHERE id = $1`, [t1]);
    await c.query(`INSERT INTO tenants (id, slug, name, status, region, "createdAt", "updatedAt")
      VALUES ($1, 'p314-tenant', 'P314', 'ACTIVE', 'eu', now(), now())`, [t1]);
    await c.query(`INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "tenantId", "createdAt", "updatedAt")
      VALUES ($1, 'P314 A', 'XX', 'C', 'a@p314.test', '0', $2, now(), now())`, [a1, t1]);
    const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
    await c.query(`INSERT INTO users (id, email, "passwordHash", "firstName","lastName","roleId","agencyId",status,"createdAt","updatedAt")
      VALUES ($1, 'p314-fe@e.com', 'irrelevant', 'A','B', $2, $3, 'ACTIVE', now(), now())`,
      [u1, ro.rows[0].id, a1]);
    // Simulate the API client's exact normalization step then resolve.
    const company = '  P314-Tenant '.trim().toLowerCase();
    const email   = 'P314-FE@E.COM'.trim().toLowerCase();
    const tenant = await c.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = $1 OR "customDomain" = $1 LIMIT 1`, [company]);
    const user = await c.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN agencies a ON a.id = u."agencyId"
        WHERE lower(u.email) = $1 AND u."deletedAt" IS NULL AND a."tenantId" = $2`,
      [email, tenant.rows[0]?.id]);
    backendOk = user.rows[0]?.id === u1;
    // Cleanup
    await c.query(`DELETE FROM users WHERE id = $1`, [u1]);
    await c.query(`DELETE FROM agencies WHERE id = $1`, [a1]);
    await c.query(`DELETE FROM tenants WHERE id = $1`, [t1]);
  } finally { await c.end(); }
  out.push({ name: '12. backend Phase 3.13 contract resolves a fresh tenant/user pair',
    ok: backendOk, detail: backendOk ? 'resolved' : 'mismatch' });

  // 13-17 — wiring + sentinel outputs
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '13. Phase 3.12 controller wiring intact',
    ok: /saas:phase312-platform-admin-controller/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '14. Phase 3.11 grant/revoke wiring intact',
    ok: /saas:phase311-platform-admin-grant-revoke/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '15. Phase 3.10 cleanup harness wiring intact',
    ok: /saas:phase310-platform-admin-cleanup-audit-log/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '16. Phase 3.9 drop-agency-is-system wiring intact',
    ok: /saas:phase390-drop-agency-is-system/.test(pkg), detail: 'pkg.json' });
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'tenant-aware-login.json'], ['phase3', 'platform-admin-controller.json'],
    ['phase3', 'platform-admin-grant-revoke.json'], ['phase3', 'drop-agency-is-system.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '17. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'frontend-tenant-login-check.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.14 — frontend tenant-login source-level check`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'frontend-tenant-login-check.md'), md);
  console.log(`[frontend-tenant-login-check] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
