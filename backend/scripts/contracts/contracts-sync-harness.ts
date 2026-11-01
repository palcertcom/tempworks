/**
 * ContractsService smoke harness.
 *
 * Stubs PrismaService + PilotPrismaAccessor and exercises the pieces
 * that carry real logic:
 *   - status derivation (UPCOMING / ACTIVE / ENDED)
 *   - list ordering (chronological, oldest first)
 *   - isContractDocumentType (configured ids, else default name match)
 *   - syncFromDocument: employee-only gate, type gate, create vs update
 *     by documentId, Issue→start / Expiry→end mapping, and the
 *     employee contract-date refresh.
 *
 * Run:
 *   npx ts-node backend/scripts/contracts/contracts-sync-harness.ts
 *
 * No DB needed. Exits 0 when all cases pass.
 */
/* eslint-disable no-console */
import { ContractsService } from '../../src/contracts/contracts.service';
import { decodeUploadFilename } from '../../src/common/storage/multer.config';

const DAY = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

interface Contract {
  id: string; employeeId: string; startDate: Date; endDate: Date | null;
  contractType: string; status: string; documentId: string | null;
  source: string; deletedAt: Date | null; createdAt: Date; tenantId?: string | null;
}
interface Doc {
  id: string; documentTypeId: string; entityType: string; entityId: string;
  issueDate: Date | null; expiryDate: Date | null; tenantId: string | null; deletedAt: Date | null;
}
interface Fixture {
  contracts: Contract[];
  documents: Doc[];
  documentTypes: Array<{ id: string; name: string }>;
  settingValue?: string | null;     // system_settings contracts.documentTypeIds
  employees: Array<{ id: string; contractStartDate: Date | null; contractEndDate: Date | null; status?: string }>;
}

function makeService(fix: Fixture) {
  let seq = 100;
  const prisma: any = {
    employee: {
      findFirst: async (q: any) => fix.employees.find(e => e.id === q.where.id) ?? null,
      findUnique: async (q: any) => fix.employees.find(e => e.id === q.where.id) ?? null,
      findMany: async (q: any) => {
        const now = Date.now();
        return fix.employees.filter(e => {
          if (q.where?.status?.not && e.status === q.where.status.not) return false;
          if (q.where?.contractEndDate?.not === null && e.contractEndDate == null) return false;
          if (q.where?.contractEndDate?.lt && !(e.contractEndDate && e.contractEndDate.getTime() < now)) return false;
          return true;
        }).map(e => ({ id: e.id }));
      },
      update: async (q: any) => {
        const e = fix.employees.find(x => x.id === q.where.id);
        if (e) {
          if ('contractStartDate' in q.data) e.contractStartDate = q.data.contractStartDate;
          if ('contractEndDate' in q.data) e.contractEndDate = q.data.contractEndDate;
          if ('status' in q.data) e.status = q.data.status;
        }
        return e;
      },
    },
    employmentContract: {
      findMany: async (q: any) => {
        let rows = fix.contracts.filter(c => c.employeeId === q.where.employeeId && c.deletedAt == null);
        // emulate orderBy startDate asc
        rows = rows.slice().sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
        return rows.map(r => ({ ...r, document: null, createdBy: null }));
      },
      findFirst: async (q: any) => {
        let rows = fix.contracts.filter(c => c.deletedAt == null);
        if (q.where.employeeId) rows = rows.filter(c => c.employeeId === q.where.employeeId);
        if (q.where.documentId) rows = rows.filter(c => c.documentId === q.where.documentId);
        if (q.orderBy) rows = rows.slice().sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
        return rows[0] ?? null;
      },
      create: async (q: any) => {
        const row: Contract = {
          id: `c${seq++}`, deletedAt: null, createdAt: new Date(),
          contractType: 'Full-time', status: 'ACTIVE', documentId: null, source: 'MANUAL',
          ...q.data,
        };
        fix.contracts.push(row);
        return { ...row, document: null, createdBy: null };
      },
      update: async (q: any) => {
        const row = fix.contracts.find(c => c.id === q.where.id)!;
        Object.assign(row, q.data);
        return { ...row, document: null, createdBy: null };
      },
    },
    documentType: {
      findUnique: async (q: any) => fix.documentTypes.find(d => d.id === q.where.id) ?? null,
    },
    document: {
      findUnique: async (q: any) => fix.documents.find(d => d.id === q.where.id) ?? null,
    },
    systemSetting: {
      findUnique: async (_q: any) => (fix.settingValue != null ? { value: fix.settingValue } : null),
    },
    auditLog: { create: async () => undefined },
  };
  // Pilot inactive → legacy behaviour (scope.tenantWhere()/tenantData() = {}).
  const pilot: any = {
    client: () => prisma,
    pilotReason: () => ({ active: false, reason: 'harness: pilot off' }),
  };
  const svc = new ContractsService(prisma, pilot);
  return { svc, prisma };
}

async function main() {
  console.log('contracts-sync harness');
  const now = Date.now();

  // ── status derivation via list() ─────────────────────────────────────────
  {
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null }],
      documents: [], documentTypes: [],
      contracts: [
        { id: 'c1', employeeId: 'e1', startDate: new Date(now - 400 * DAY), endDate: new Date(now - 40 * DAY), contractType: 'Fixed', status: 'ACTIVE', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
        { id: 'c2', employeeId: 'e1', startDate: new Date(now - 30 * DAY), endDate: new Date(now + 300 * DAY), contractType: 'Full-time', status: 'ACTIVE', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
        { id: 'c3', employeeId: 'e1', startDate: new Date(now + 400 * DAY), endDate: null, contractType: 'Full-time', status: 'ACTIVE', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
      ],
    };
    const { svc } = makeService(fix);
    const list = await svc.list('e1');
    check('list: chronological (oldest first)', list[0].id === 'c1' && list[1].id === 'c2' && list[2].id === 'c3');
    check('status: past end → ENDED', list[0].status === 'ENDED', list[0].status);
    check('status: spanning now → ACTIVE', list[1].status === 'ACTIVE', list[1].status);
    check('status: future start → UPCOMING', list[2].status === 'UPCOMING', list[2].status);
  }

  // ── isContractDocumentType: default name match ───────────────────────────
  {
    const fix: Fixture = {
      employees: [], contracts: [], documents: [],
      documentTypes: [
        { id: 'dt-emp', name: 'Employment Contract' },
        { id: 'dt-work', name: 'Work Contract' },
        { id: 'dt-pass', name: 'Passport' },
      ],
      settingValue: null,
    };
    const { svc } = makeService(fix);
    check('type(default): Employment Contract matches', await svc.isContractDocumentType('dt-emp'));
    check('type(default): Work Contract matches', await svc.isContractDocumentType('dt-work'));
    check('type(default): Passport does NOT match', !(await svc.isContractDocumentType('dt-pass')));
  }

  // ── isContractDocumentType: configured id list wins ──────────────────────
  {
    const fix: Fixture = {
      employees: [], contracts: [], documents: [],
      documentTypes: [
        { id: 'dt-emp', name: 'Employment Contract' },
        { id: 'dt-custom', name: 'Zmluva' }, // non-English name, configured explicitly
      ],
      settingValue: JSON.stringify(['dt-custom']),
    };
    const { svc } = makeService(fix);
    check('type(configured): configured id matches', await svc.isContractDocumentType('dt-custom'));
    check('type(configured): name-default no longer matches when ids set', !(await svc.isContractDocumentType('dt-emp')));
  }

  // ── syncFromDocument: create from an Employment Contract document ─────────
  {
    const issue = new Date(now - 10 * DAY);
    const expiry = new Date(now + 355 * DAY);
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null }],
      contracts: [],
      documentTypes: [{ id: 'dt-emp', name: 'Employment Contract' }],
      documents: [
        { id: 'doc1', documentTypeId: 'dt-emp', entityType: 'EMPLOYEE', entityId: 'e1', issueDate: issue, expiryDate: expiry, tenantId: 't1', deletedAt: null },
      ],
      settingValue: null,
    };
    const { svc } = makeService(fix);
    await svc.syncFromDocument('doc1', 'actor1');
    check('sync: created one contract', fix.contracts.length === 1);
    const c = fix.contracts[0];
    check('sync: start = issueDate', c?.startDate?.getTime() === issue.getTime());
    check('sync: end = expiryDate', c?.endDate?.getTime() === expiry.getTime());
    check('sync: source=DOCUMENT + documentId set', c?.source === 'DOCUMENT' && c?.documentId === 'doc1');
    check('sync: tenantId carried from doc', c?.tenantId === 't1');
    check('sync: employee contract dates refreshed', fix.employees[0].contractStartDate?.getTime() === issue.getTime() && fix.employees[0].contractEndDate?.getTime() === expiry.getTime());
  }

  // ── syncFromDocument: re-sync updates the SAME row (no duplicate) ─────────
  {
    const issue = new Date(now - 10 * DAY);
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null }],
      contracts: [],
      documentTypes: [{ id: 'dt-emp', name: 'Employment Contract' }],
      documents: [
        { id: 'doc1', documentTypeId: 'dt-emp', entityType: 'EMPLOYEE', entityId: 'e1', issueDate: issue, expiryDate: null, tenantId: 't1', deletedAt: null },
      ],
      settingValue: null,
    };
    const { svc } = makeService(fix);
    await svc.syncFromDocument('doc1', 'actor1');
    // operator later sets an expiry on the same doc
    fix.documents[0].expiryDate = new Date(now + 200 * DAY);
    await svc.syncFromDocument('doc1', 'actor1');
    check('resync: still one contract (updated, not duplicated)', fix.contracts.length === 1, `got ${fix.contracts.length}`);
    check('resync: end date updated', fix.contracts[0].endDate?.getTime() === fix.documents[0].expiryDate!.getTime());
  }

  // ── syncFromDocument gates: non-employee + non-contract type ─────────────
  {
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null }],
      contracts: [],
      documentTypes: [
        { id: 'dt-emp', name: 'Employment Contract' },
        { id: 'dt-pass', name: 'Passport' },
      ],
      documents: [
        { id: 'docA', documentTypeId: 'dt-emp', entityType: 'APPLICANT', entityId: 'a1', issueDate: new Date(), expiryDate: null, tenantId: 't1', deletedAt: null },
        { id: 'docP', documentTypeId: 'dt-pass', entityType: 'EMPLOYEE', entityId: 'e1', issueDate: new Date(), expiryDate: null, tenantId: 't1', deletedAt: null },
      ],
      settingValue: null,
    };
    const { svc } = makeService(fix);
    await svc.syncFromDocument('docA', 'actor1'); // applicant → skipped
    await svc.syncFromDocument('docP', 'actor1'); // passport → skipped
    check('gate: applicant contract doc skipped', fix.contracts.length === 0);
    check('gate: non-contract type skipped', fix.contracts.length === 0);
  }

  // ── auto status: future end date → stays ACTIVE ──────────────────────────
  {
    const future = new Date(now + 60 * DAY);
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null, status: 'ACTIVE' }],
      documents: [], documentTypes: [],
      contracts: [
        { id: 'c1', employeeId: 'e1', startDate: new Date(now - 30 * DAY), endDate: future, contractType: 'Full-time', status: 'ACTIVE', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
      ],
    };
    const { svc } = makeService(fix);
    const r = await svc.evaluateEmployeeStatusFromContracts('e1', 'actor1');
    check('status(future end): unchanged', r === 'unchanged' && fix.employees[0].status === 'ACTIVE', `${r}/${fix.employees[0].status}`);
  }

  // ── auto status: past end date → TERMINATED ──────────────────────────────
  {
    const past = new Date(now - 5 * DAY);
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null, status: 'ACTIVE' }],
      documents: [], documentTypes: [],
      contracts: [
        { id: 'c1', employeeId: 'e1', startDate: new Date(now - 400 * DAY), endDate: past, contractType: 'Fixed', status: 'ACTIVE', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
      ],
    };
    const { svc } = makeService(fix);
    const r = await svc.evaluateEmployeeStatusFromContracts('e1', 'actor1');
    check('status(past end): auto-terminated', r === 'terminated' && fix.employees[0].status === 'TERMINATED', `${r}/${fix.employees[0].status}`);
  }

  // ── auto status: open-ended → stays ACTIVE ───────────────────────────────
  {
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null, status: 'ACTIVE' }],
      documents: [], documentTypes: [],
      contracts: [
        { id: 'c1', employeeId: 'e1', startDate: new Date(now - 10 * DAY), endDate: null, contractType: 'Full-time', status: 'ACTIVE', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
      ],
    };
    const { svc } = makeService(fix);
    const r = await svc.evaluateEmployeeStatusFromContracts('e1', 'actor1');
    check('status(open-ended): unchanged', r === 'unchanged' && fix.employees[0].status === 'ACTIVE');
  }

  // ── auto status: later renewal (open) wins over earlier ended ────────────
  {
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null, status: 'ACTIVE' }],
      documents: [], documentTypes: [],
      contracts: [
        { id: 'c1', employeeId: 'e1', startDate: new Date(now - 400 * DAY), endDate: new Date(now - 5 * DAY), contractType: 'Fixed', status: 'ENDED', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
        { id: 'c2', employeeId: 'e1', startDate: new Date(now - 4 * DAY), endDate: null, contractType: 'Full-time', status: 'ACTIVE', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
      ],
    };
    const { svc } = makeService(fix);
    const r = await svc.evaluateEmployeeStatusFromContracts('e1', 'actor1');
    check('status(renewal wins): stays ACTIVE despite earlier ended contract', r === 'unchanged' && fix.employees[0].status === 'ACTIVE');
  }

  // ── auto status: no contracts → untouched ────────────────────────────────
  {
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null, status: 'ONBOARDING' }],
      documents: [], documentTypes: [], contracts: [],
    };
    const { svc } = makeService(fix);
    const r = await svc.evaluateEmployeeStatusFromContracts('e1', 'actor1');
    check('status(no contract): untouched', r === 'unchanged' && fix.employees[0].status === 'ONBOARDING');
  }

  // ── daily sweep: terminates the ended-contract employee only ─────────────
  {
    const fix: Fixture = {
      employees: [
        { id: 'e1', contractStartDate: null, contractEndDate: new Date(now - 5 * DAY), status: 'ACTIVE' },
        { id: 'e2', contractStartDate: null, contractEndDate: new Date(now + 30 * DAY), status: 'ACTIVE' },
      ],
      documents: [], documentTypes: [],
      contracts: [
        { id: 'c1', employeeId: 'e1', startDate: new Date(now - 400 * DAY), endDate: new Date(now - 5 * DAY), contractType: 'Fixed', status: 'ENDED', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
        { id: 'c2', employeeId: 'e2', startDate: new Date(now - 30 * DAY), endDate: new Date(now + 30 * DAY), contractType: 'Full-time', status: 'ACTIVE', documentId: null, source: 'MANUAL', deletedAt: null, createdAt: new Date() },
      ],
    };
    const { svc } = makeService(fix);
    const res = await svc.runStatusSweep();
    check('sweep: terminated exactly 1', res.terminated === 1, `${res.terminated}`);
    check('sweep: e1 terminated', fix.employees[0].status === 'TERMINATED');
    check('sweep: e2 (future end) stays ACTIVE', fix.employees[1].status === 'ACTIVE');
  }

  // ── closeCurrentContract: termination closes the open contract ───────────
  {
    const past = new Date(now - 3 * DAY);
    const fix: Fixture = {
      employees: [{ id: 'e1', contractStartDate: null, contractEndDate: null, status: 'ACTIVE' }],
      documents: [], documentTypes: [],
      contracts: [
        { id: 'c1', employeeId: 'e1', startDate: new Date(now - 200 * DAY), endDate: null, contractType: 'Full-time', status: 'ACTIVE', documentId: null, source: 'DOCUMENT', deletedAt: null, createdAt: new Date() },
      ],
    };
    const { svc } = makeService(fix);
    const r = await svc.closeCurrentContract('e1', past, 'actor1');
    check('close: reported closed', r.closed === true && r.contractId === 'c1');
    check('close: contract endDate set', fix.contracts[0].endDate?.getTime() === past.getTime());
    check('close: employee auto-terminated (past end)', fix.employees[0].status === 'TERMINATED');
  }

  // ── filename decode: recover UTF-8 mangled by multer latin1 ──────────────
  {
    // "Dohoda o skončení pracovného pomeru.pdf" as UTF-8 bytes read as latin1.
    const mangled = Buffer.from('Dohoda o skončení pracovného pomeru.pdf', 'utf8').toString('latin1');
    check('filename: recovers Slovak characters', decodeUploadFilename(mangled) === 'Dohoda o skončení pracovného pomeru.pdf', decodeUploadFilename(mangled));
    check('filename: ASCII unchanged', decodeUploadFilename('passport.pdf') === 'passport.pdf');
    check('filename: already-Unicode left as-is', decodeUploadFilename('životopis.pdf') === 'životopis.pdf');
    check('filename: empty safe', decodeUploadFilename('') === '' && decodeUploadFilename(null) === '');
  }

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
