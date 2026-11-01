import { suite, test, expect, expectThrows, run } from './runner';
import {
  tenantALS,
  TenantContext,
  UserContext,
  withRequestContext,
  currentRequestContext,
  newRequestId,
  MissingTenantContextError,
} from '../context';

suite('als-context');

const TENANT = { id: '11111111-1111-1111-1111-111111111111', slug: 'acme', name: 'Acme', status: 'ACTIVE' as const, region: 'eu' };

test('outside any frame: optional() returns null', () => {
  expect(TenantContext.optional()).toBe(null);
  expect(UserContext.optional()).toBe(null);
});

test('outside any frame: current() throws', async () => {
  const e = await expectThrows(() => TenantContext.current('probe'));
  expect(e instanceof MissingTenantContextError).toBe(true);
});

test('inside frame: tenant attach + read', async () => {
  await withRequestContext({ requestId: newRequestId() }, async () => {
    TenantContext.attach(TENANT);
    expect(TenantContext.current().id).toBe(TENANT.id);
  });
});

test('propagation through await Promise.all', async () => {
  await withRequestContext({ requestId: 'r1' }, async () => {
    TenantContext.attach(TENANT);
    const ids = await Promise.all([
      Promise.resolve().then(() => TenantContext.current().id),
      new Promise(r => setTimeout(r, 1)).then(() => TenantContext.current().id),
      new Promise(r => setImmediate(r)).then(() => TenantContext.current().id),
    ]);
    expect(ids.every(i => i === TENANT.id)).toBe(true);
  });
});

test('propagation through error path', async () => {
  await withRequestContext({ requestId: 'r2' }, async () => {
    TenantContext.attach(TENANT);
    try { await Promise.reject(new Error('x')); } catch { /* swallow */ }
    expect(TenantContext.current().id).toBe(TENANT.id);
  });
});

test('two parallel frames do not bleed', async () => {
  const t1 = TENANT;
  const t2 = { ...TENANT, id: '22222222-2222-2222-2222-222222222222', slug: 'globex' };
  const seen: string[] = [];
  await Promise.all([
    withRequestContext({ requestId: 'a' }, async () => {
      TenantContext.attach(t1);
      await new Promise(r => setTimeout(r, 5));
      seen.push(TenantContext.current().id);
    }),
    withRequestContext({ requestId: 'b' }, async () => {
      TenantContext.attach(t2);
      await new Promise(r => setTimeout(r, 1));
      seen.push(TenantContext.current().id);
    }),
  ]);
  expect(seen.length).toBe(2);
  expect(seen.includes(t1.id)).toBe(true);
  expect(seen.includes(t2.id)).toBe(true);
});

test('after frame ends, context is cleared', async () => {
  await withRequestContext({ requestId: 'c' }, async () => {
    TenantContext.attach(TENANT);
  });
  expect(TenantContext.optional()).toBe(null);
});

run();
