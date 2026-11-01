import { suite, test, expect, expectThrows, run } from './runner';
import {
  TenantSafeReportSourceRegistry,
  buildTenantSafeWhere,
  ALLOWED_OPS,
  joinHasTenantEquality,
  looksLikeUnsafeSql,
} from '../reports';
import type { SourceDef } from '../reports';

suite('reports-scaffolding');

const VALID_TID_A = '11111111-1111-4111-8111-111111111111';
const VALID_TID_B = '22222222-2222-4222-8222-222222222222';

const sampleSource: SourceDef = {
  key: 'employees',
  label: 'Employees',
  group: 'single',
  tables: ['employees'],
  primaryTable: 'employees',
  primaryAlias: 'e',
  softDelete: true,
  tenantColumn: 'tenantId',
  agencyColumn: 'agencyId',
  tenantAwareJoins: [],
  fields: {
    id:        { alias: 'e', dbCol: 'id',        type: 'uuid',   label: 'ID' },
    email:     { alias: 'e', dbCol: 'email',     type: 'string', label: 'Email' },
    status:    { alias: 'e', dbCol: 'status',    type: 'enum',   label: 'Status' },
    createdAt: { alias: 'e', dbCol: 'createdAt', type: 'date',   label: 'Created' },
  },
};

test('registry rejects source missing tenantColumn', () => {
  const r = new TenantSafeReportSourceRegistry();
  // agencyColumn null avoids the secondary "agencyColumn-without-tenantColumn" rule;
  // we want to assert the primary rule fires.
  r.register({ ...sampleSource, key: 'bad', tenantColumn: '' as any, agencyColumn: null });
  const errs = r.validateAll();
  expect(errs.length).toBe(1);
  expect(errs[0].rule).toBe('missing-tenantColumn');
});

test('registry accepts a valid source', () => {
  const r = new TenantSafeReportSourceRegistry();
  r.register(sampleSource);
  expect(r.validateAll().length).toBe(0);
});

test('registry rejects join without tenant_id equality', () => {
  const r = new TenantSafeReportSourceRegistry();
  r.register({
    ...sampleSource,
    key: 'employees_documents',
    tenantAwareJoins: [
      { joinType: 'LEFT', table: 'documents', alias: 'd', on: 'd.entityId = e.id' },
    ],
  });
  const errs = r.validateAll();
  expect(errs.some((e) => e.rule === 'join-missing-tenant-equality')).toBe(true);
});

test('registry accepts join WITH tenant_id equality', () => {
  const r = new TenantSafeReportSourceRegistry();
  r.register({
    ...sampleSource,
    key: 'employees_documents',
    tenantAwareJoins: [
      { joinType: 'LEFT', table: 'documents', alias: 'd',
        on: 'd.entityId = e.id AND d.tenant_id = e.tenant_id' },
    ],
  });
  expect(r.validateAll().length).toBe(0);
});

test('joinHasTenantEquality accepts camelCase column too', () => {
  expect(joinHasTenantEquality('a.tenantId = b.tenantId AND a.x = b.y')).toBe(true);
  expect(joinHasTenantEquality('a."tenant_id" = b."tenant_id"')).toBe(true);
  expect(joinHasTenantEquality('a.id = b.id')).toBe(false);
});

test('assertAllValid throws aggregated message', async () => {
  const r = new TenantSafeReportSourceRegistry();
  r.register({ ...sampleSource, key: 'bad1', tenantColumn: '' as any });
  r.register({ ...sampleSource, key: 'bad2', tenantColumn: 'has spaces' });
  const e = await expectThrows(() => r.assertAllValid());
  expect(e.message.includes('bad1')).toBe(true);
  expect(e.message.includes('bad2')).toBe(true);
});

test('whereBuilder forces tenantId as $1', () => {
  const w = buildTenantSafeWhere(sampleSource, [], {
    tenantId: VALID_TID_A, platformAdmin: false,
  });
  expect(w.params[0]).toBe(VALID_TID_A);
  expect(w.sql.startsWith('"e"."tenantId" = $1')).toBe(true);
});

test('whereBuilder rejects invalid tenantId', async () => {
  const e = await expectThrows(() => buildTenantSafeWhere(sampleSource, [], {
    tenantId: 'not-a-uuid', platformAdmin: false,
  }));
  expect(e.message.includes('Invalid UUID')).toBe(true);
});

test('whereBuilder applies agency scope when agencyIds provided', () => {
  const w = buildTenantSafeWhere(sampleSource, [], {
    tenantId: VALID_TID_A,
    agencyIds: ['33333333-3333-4333-8333-333333333333'],
    platformAdmin: false,
  });
  expect(w.sql.includes('"e"."agencyId" IN ($2)')).toBe(true);
  expect(w.params.length).toBe(2);
});

test('whereBuilder includes deletedAt filter for soft-delete sources', () => {
  const w = buildTenantSafeWhere(sampleSource, [], {
    tenantId: VALID_TID_A, platformAdmin: false,
  });
  expect(w.sql.includes('"e"."deletedAt" IS NULL')).toBe(true);
});

test('whereBuilder rejects unknown field', async () => {
  const e = await expectThrows(() => buildTenantSafeWhere(sampleSource, [
    { field: 'tenantId', op: '=', value: VALID_TID_B } as any,  // attempting cross-tenant
  ], { tenantId: VALID_TID_A, platformAdmin: false }));
  expect(e.message.includes('unknown field')).toBe(true);
});

test('whereBuilder rejects forbidden op', async () => {
  const e = await expectThrows(() => buildTenantSafeWhere(sampleSource, [
    { field: 'email', op: 'OR 1=1' as any, value: 'x' },
  ], { tenantId: VALID_TID_A, platformAdmin: false }));
  expect(e.message.includes('forbidden op')).toBe(true);
});

test('whereBuilder rejects adversarial string values', async () => {
  // Defense in depth: even though the value would be parameterised, we
  // refuse strings that match SQL-injection heuristics so the operator
  // sees an explicit failure rather than a silent execution.
  const e = await expectThrows(() => buildTenantSafeWhere(sampleSource, [
    { field: 'email', op: '=', value: "x'; DROP TABLE--" },
  ], { tenantId: VALID_TID_A, platformAdmin: false }));
  expect(e.message.includes('refusing unsafe value')).toBe(true);
});

test('whereBuilder safely parameterises ordinary special characters', () => {
  // Apostrophes / brackets in legitimate names must NOT be rejected.
  const w = buildTenantSafeWhere(sampleSource, [
    { field: 'email', op: '=', value: "o'reilly@example.com" },
  ], { tenantId: VALID_TID_A, platformAdmin: false });
  expect(w.params.includes("o'reilly@example.com")).toBe(true);
  expect(w.sql.includes('"e"."email" = $2')).toBe(true);
});

test('looksLikeUnsafeSql catches comments and unions', () => {
  expect(looksLikeUnsafeSql('foo OR 1=1')).toBe(true);
  expect(looksLikeUnsafeSql('foo; DROP TABLE x')).toBe(true);
  expect(looksLikeUnsafeSql('foo UNION SELECT *')).toBe(true);
  expect(looksLikeUnsafeSql('Acme & Sons')).toBe(false);
});

test('platformAdminOnly source rejected for tenant member', async () => {
  const e = await expectThrows(() => buildTenantSafeWhere(
    { ...sampleSource, platformAdminOnly: true },
    [],
    { tenantId: VALID_TID_A, platformAdmin: false },
  ));
  expect(e.message.includes('platform-admin only')).toBe(true);
});

test('ALLOWED_OPS does NOT contain OR', () => {
  expect(ALLOWED_OPS.has('OR')).toBe(false);
  expect(ALLOWED_OPS.has('=')).toBe(true);
});

run();
