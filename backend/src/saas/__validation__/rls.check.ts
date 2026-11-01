import { suite, test, expect, expectThrows, run } from './runner';
import { assertUuid, setLocalTenantSql, RLS_POLICY_TEMPLATE } from '../prisma/rls';

suite('rls-helpers');

test('assertUuid accepts a valid v4 UUID', () => {
  const v = assertUuid('11111111-1111-4111-8111-111111111111');
  expect(v).toBe('11111111-1111-4111-8111-111111111111');
});

test('assertUuid rejects garbage', async () => {
  await expectThrows(() => assertUuid("'; DROP TABLE x; --"));
  await expectThrows(() => assertUuid('not-a-uuid'));
  await expectThrows(() => assertUuid(''));
});

test('setLocalTenantSql produces SET LOCAL with quoted UUID', () => {
  const sql = setLocalTenantSql('11111111-1111-4111-8111-111111111111');
  expect(sql).toContain('SET LOCAL app.tenant_id');
  expect(sql).toContain("'11111111-1111-4111-8111-111111111111'");
});

test('setLocalTenantSql refuses injection attempts', async () => {
  await expectThrows(() => setLocalTenantSql("a'; DROP TABLE x;--"));
});

test('policy template contains NULLIF wrapper (SPIKE-001 F-1)', () => {
  expect(RLS_POLICY_TEMPLATE).toContain("NULLIF(current_setting('app.tenant_id', true), '')::uuid");
});

test('policy template has FORCE clause', () => {
  expect(RLS_POLICY_TEMPLATE).toContain('FORCE ROW LEVEL SECURITY');
});

test('policy template includes platform_admin bypass', () => {
  expect(RLS_POLICY_TEMPLATE).toContain('platform_admin');
});

run();
