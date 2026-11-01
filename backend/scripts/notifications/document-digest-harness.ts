/**
 * DocumentDigestCron smoke harness (live-scan model).
 *
 * The digest is built from a LIVE scan of documents that are currently
 * expired / expiring-soon / rejected, scoped to each recipient's tenant
 * — not from notification rows. This harness stubs PrismaService /
 * EmailService / NotificationsService / SchedulerRegistry and drives
 * `DocumentDigestCron.runOnce()` against synthetic data.
 *
 * Run:
 *   npx ts-node backend/scripts/notifications/document-digest-harness.ts
 *
 * No database needed. Exits 0 when all cases pass.
 */
/* eslint-disable no-console */
import { DocumentDigestCron } from '../../src/notifications/document-digest.cron';

const DAY = 24 * 60 * 60 * 1000;

interface Doc {
  id: string;
  docId: string | null;
  name: string;
  expiryDate: Date | null;
  status: string;
  entityType: 'EMPLOYEE' | 'APPLICANT';
  entityId: string;
  tenantId: string | null;
  documentType: { name: string };
}
interface Person { id: string; firstName: string; lastName: string; tenantId: string | null; agencyName?: string; }
interface User {
  id: string; email: string; firstName: string; lastName: string;
  status: string; roleName: string; tenantId: string | null;
}
interface Tenant { id: string; name: string; }

interface Fixture {
  users: User[];
  documents: Doc[];
  employees: Person[];
  applicants: Person[];
  tenants: Tenant[];
  optedOut?: Set<string>;
}

interface SentEmail { to: string; name: string; rows: any[]; tenantLabel: string | null; }

const DOC_NOTIFY_ROLES = ['System Admin', 'HR Manager', 'Compliance Officer'];

function isAlert(d: Doc, now: number, fwd: number): boolean {
  if (d.status === 'REJECTED' || d.status === 'EXPIRED') return true;
  if (d.expiryDate) {
    const t = d.expiryDate.getTime();
    if (t < now) return true;
    if (t > now && t <= fwd) return true;
  }
  return false;
}

function buildStubs(fix: Fixture) {
  const sent: SentEmail[] = [];
  const now = Date.now();
  const fwd = now + 60 * DAY;

  const prisma: any = {
    user: {
      findMany: async (q: any) => {
        const w = q.where ?? {};
        let list = fix.users;
        if (w.id) list = list.filter(u => u.id === w.id);
        if (w.status) list = list.filter(u => u.status === w.status);
        if (w.role?.name?.in) list = list.filter(u => w.role.name.in.includes(u.roleName));
        return list.map(u => ({
          id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName,
          preferredLanguage: 'en',
          role: { name: u.roleName },
          agency: { name: 'Agency', tenantId: u.tenantId },
        }));
      },
    },
    document: {
      // Global scan — no tenant filter (the cron resolves tenant via
      // the owning entity afterwards).
      findMany: async (_q: any) =>
        fix.documents.filter(d => isAlert(d, now, fwd)).map(d => ({ ...d })),
    },
    employee: {
      findMany: async (q: any) => {
        const ids: string[] = q.where.id.in;
        return fix.employees.filter(e => ids.includes(e.id))
          .map(e => ({ ...e, agency: { name: e.agencyName ?? 'Agency', tenantId: e.tenantId } }));
      },
    },
    applicant: {
      findMany: async (q: any) => {
        const ids: string[] = q.where.id.in;
        return fix.applicants.filter(a => ids.includes(a.id))
          .map(a => ({ ...a, agency: { name: a.agencyName ?? 'Agency', tenantId: a.tenantId } }));
      },
    },
    tenant: {
      findMany: async (q: any) => {
        const ids: string[] = q.where.id.in;
        return fix.tenants.filter(t => ids.includes(t.id));
      },
    },
  };

  const email: any = {
    sendDocumentDigestEmail: async (to: string, name: string, rows: any[], tenantLabel: string | null) => {
      if (!rows.length) throw new Error('digest must not send with zero rows');
      sent.push({ to, name, rows, tenantLabel });
    },
  };

  const notifications: any = {
    wantsChannel: async (userId: string, _event: string, channel: string) => {
      if (channel !== 'email') return true;
      return !(fix.optedOut?.has(userId) ?? false);
    },
  };

  const scheduler: any = { deleteCronJob: () => undefined, addCronJob: () => undefined };

  return { prisma, email, notifications, scheduler, sent };
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

function baseFixture(): Fixture {
  const now = Date.now();
  const expired   = new Date(now - 5 * DAY);
  const expiring  = new Date(now + 10 * DAY);
  const future    = new Date(now + 200 * DAY);
  return {
    users: [
      // Super Admin = platform authority with NO single tenant — reproduces
      // the production case (agency.tenantId null) where Send Me used to skip.
      { id: 'u1', email: 'sa@root.com', firstName: 'Super', lastName: 'Admin',   status: 'ACTIVE', roleName: 'System Admin',        tenantId: null },
      { id: 'u2', email: 'hr@t1.com',  firstName: 'Helen', lastName: 'Reed',    status: 'ACTIVE', roleName: 'HR Manager',          tenantId: 't1' },
      { id: 'u3', email: 'rec@t1.com', firstName: 'Rita',  lastName: 'Cruz',    status: 'ACTIVE', roleName: 'Recruiter',           tenantId: 't1' },
      { id: 'u4', email: 'co@t2.com',  firstName: 'Carl',  lastName: 'Ortiz',   status: 'ACTIVE', roleName: 'Compliance Officer',  tenantId: 't2' },
    ],
    // Documents carry tenantId=null (denorm not backfilled) — the cron
    // must resolve tenant from the owning employee/applicant.
    documents: [
      { id: 'd1', docId: 'DOC1', name: 'visa.pdf',        expiryDate: expired,  status: 'VERIFIED', entityType: 'EMPLOYEE',  entityId: 'e1', tenantId: null, documentType: { name: 'Visa' } },
      { id: 'd2', docId: 'DOC2', name: 'work_permit.pdf', expiryDate: expiring, status: 'VERIFIED', entityType: 'APPLICANT', entityId: 'a1', tenantId: null, documentType: { name: 'Work Permit' } },
      { id: 'd3', docId: 'DOC3', name: 'trc.pdf',         expiryDate: future,   status: 'REJECTED', entityType: 'EMPLOYEE',  entityId: 'e2', tenantId: null, documentType: { name: 'Temporary Residence Card' } },
      { id: 'd4', docId: 'DOC4', name: 'passport.pdf',    expiryDate: expired,  status: 'VERIFIED', entityType: 'EMPLOYEE',  entityId: 'e3', tenantId: null, documentType: { name: 'Passport' } },
      { id: 'd5', docId: 'DOC5', name: 'license.pdf',     expiryDate: future,   status: 'VERIFIED', entityType: 'EMPLOYEE',  entityId: 'e4', tenantId: null, documentType: { name: 'License' } },
    ],
    employees: [
      { id: 'e1', firstName: 'John', lastName: 'Smith', tenantId: 't1' },
      { id: 'e2', firstName: 'Anna', lastName: 'Novak', tenantId: 't1' },
      { id: 'e3', firstName: 'Bob',  lastName: 'Lee',   tenantId: 't2' },
      { id: 'e4', firstName: 'Jane', lastName: 'Doe',   tenantId: 't1' },
    ],
    applicants: [
      { id: 'a1', firstName: 'Sara', lastName: 'Ali', tenantId: 't1' },
    ],
    tenants: [
      { id: 't1', name: 'Tempworks' },
      { id: 't2', name: 'Other Tenant' },
    ],
  };
}

async function main() {
  console.log('document-digest harness (live-scan)');

  // ── Case 1: Send All ──────────────────────────────────────────────────────
  {
    const fix = baseFixture();
    const { prisma, email, notifications, scheduler, sent } = buildStubs(fix);
    const cron = new DocumentDigestCron(prisma, email, notifications, scheduler);
    const res = await cron.runOnce();
    const u1 = sent.find(s => s.to === 'sa@root.com');
    const u2 = sent.find(s => s.to === 'hr@t1.com');
    const u3 = sent.find(s => s.to === 'rec@t1.com');
    const u4 = sent.find(s => s.to === 'co@t2.com');
    check('all: System Admin (platform) emailed', !!u1);
    check('all: HR Manager emailed', !!u2);
    check('all: Recruiter NOT emailed (not a notify role)', !u3);
    check('all: Compliance Officer (t2) emailed', !!u4);
    check('all: platform recipient sees all 4 alert docs', u1?.rows.length === 4, `got ${u1?.rows.length}`);
    check('all: t1 recipient sees 3 alert docs (entity-tenant, null doc.tenantId)', u2?.rows.length === 3, `got ${u2?.rows.length}`);
    check('all: far-future doc d5 excluded', !u2?.rows.some((r: any) => r.documentName === 'license.pdf'));
    check('all: emailsSent=3', res.emailsSent === 3, `got ${res.emailsSent}`);
  }

  // ── Case 2: tenant isolation ──────────────────────────────────────────────
  {
    const fix = baseFixture();
    const { prisma, email, notifications, scheduler, sent } = buildStubs(fix);
    const cron = new DocumentDigestCron(prisma, email, notifications, scheduler);
    await cron.runOnce();
    const u4 = sent.find(s => s.to === 'co@t2.com')!;
    check('isolation: t2 recipient sees only d4', u4.rows.length === 1 && u4.rows[0].documentName === 'passport.pdf', `got ${u4.rows.length}`);
    check('isolation: t2 recipient sees NO t1 docs', !u4.rows.some((r: any) => ['visa.pdf','work_permit.pdf','trc.pdf'].includes(r.documentName)));
    check('isolation: subject tenant = recipient home tenant', u4.tenantLabel === 'Other Tenant', `got ${u4.tenantLabel}`);
  }

  // ── Case 3: reason derivation + person resolution ─────────────────────────
  {
    const fix = baseFixture();
    const { prisma, email, notifications, scheduler, sent } = buildStubs(fix);
    const cron = new DocumentDigestCron(prisma, email, notifications, scheduler);
    await cron.runOnce({ onlyUserId: 'u1' });
    const u1 = sent.find(s => s.to === 'sa@root.com')!;
    const visa = u1.rows.find((r: any) => r.documentName === 'visa.pdf');
    const wp   = u1.rows.find((r: any) => r.documentName === 'work_permit.pdf');
    const trc  = u1.rows.find((r: any) => r.documentName === 'trc.pdf');
    check('reason: expired', visa?.reason === 'Expired', `got ${visa?.reason}`);
    check('reason: expiring soon', wp?.reason === 'Expiring soon', `got ${wp?.reason}`);
    check('reason: rejected', trc?.reason === 'Rejected', `got ${trc?.reason}`);
    check('person: employee name', visa?.personName === 'John Smith' && visa?.personType === 'Employee', `got ${visa?.personName}/${visa?.personType}`);
    check('person: applicant name', wp?.personName === 'Sara Ali' && wp?.personType === 'Applicant', `got ${wp?.personName}/${wp?.personType}`);
    check('fields: document type populated', visa?.documentType === 'Visa' && wp?.documentType === 'Work Permit');
    check('fields: expiry date formatted / no dashes', !!visa?.expiryDate && visa?.documentName !== '—');
    // Deep links: document → /dashboard/documents/<id>; person →
    // /dashboard/employees|applicants/<id>.
    check('link: document path set', visa?.documentPath === '/dashboard/documents/d1', `got ${visa?.documentPath}`);
    check('link: employee person path set', visa?.personPath === '/dashboard/employees/e1', `got ${visa?.personPath}`);
    check('link: applicant person path set', wp?.personPath === '/dashboard/applicants/a1', `got ${wp?.personPath}`);
  }

  // ── Case 4: Send Me scopes to the caller ──────────────────────────────────
  {
    const fix = baseFixture();
    const { prisma, email, notifications, scheduler, sent } = buildStubs(fix);
    const cron = new DocumentDigestCron(prisma, email, notifications, scheduler);
    // Platform super (null tenant): Send Me reaches them and shows all
    // alert docs — the production "recipients:0" bug is gone.
    const res = await cron.runOnce({ onlyUserId: 'u1' });
    check('send-me: only caller emailed', sent.length === 1 && sent[0].to === 'sa@root.com', `sent=${sent.length}`);
    check('send-me: platform caller sees all alert docs (4) — not empty', sent[0]?.rows.length === 4, `got ${sent[0]?.rows.length}`);
    check('send-me: emailsSent=1', res.emailsSent === 1);
  }

  // ── Case 4b: Send Me for a tenant-scoped (non-platform) user ──────────────
  {
    const fix = baseFixture();
    const { prisma, email, notifications, scheduler, sent } = buildStubs(fix);
    const cron = new DocumentDigestCron(prisma, email, notifications, scheduler);
    const res = await cron.runOnce({ onlyUserId: 'u2' }); // HR Manager, tenant t1
    check('send-me(t1): only u2 emailed', sent.length === 1 && sent[0].to === 'hr@t1.com', `sent=${sent.length}`);
    check('send-me(t1): sees only t1 docs (3) via entity-tenant', sent[0]?.rows.length === 3, `got ${sent[0]?.rows.length}`);
    check('send-me(t1): no t2 passport leaked', !sent[0]?.rows.some((r: any) => r.documentName === 'passport.pdf'));
    check('send-me(t1): emailsSent=1', res.emailsSent === 1);
  }

  // ── Case 5: no compliance docs → no email ─────────────────────────────────
  {
    const fix = baseFixture();
    // Make every t1 doc healthy (far future, verified) so nothing alerts.
    for (const d of fix.documents) { d.status = 'VERIFIED'; d.expiryDate = new Date(Date.now() + 300 * DAY); }
    const { prisma, email, notifications, scheduler, sent } = buildStubs(fix);
    const cron = new DocumentDigestCron(prisma, email, notifications, scheduler);
    const res = await cron.runOnce({ onlyUserId: 'u1' });
    check('empty: no email sent', sent.length === 0);
    check('empty: emailsSent=0', res.emailsSent === 0);
    check('empty: recipients=0', res.recipients === 0);
  }

  // ── Case 6: opt-out recipient skipped ─────────────────────────────────────
  {
    const fix = baseFixture();
    fix.optedOut = new Set(['u1']);
    const { prisma, email, notifications, scheduler, sent } = buildStubs(fix);
    const cron = new DocumentDigestCron(prisma, email, notifications, scheduler);
    const res = await cron.runOnce({ onlyUserId: 'u1' });
    check('opt-out: no email', sent.length === 0);
    check('opt-out: skippedNoOptIn counted', res.skippedNoOptIn === 1, `got ${res.skippedNoOptIn}`);
  }

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
