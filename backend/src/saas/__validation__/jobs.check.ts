import { suite, test, expect, expectThrows, run } from './runner';
import { TenantAwareJobProcessor } from '../jobs';
import { TenantContext } from '../context/als';

suite('tenant-aware-job-processor');

class StubProcessor extends TenantAwareJobProcessor<{ tenantId: string }> {
  public ranWithTenant: string | null = null;
  protected async resolveTenant(tenantId: string) {
    return { id: tenantId, slug: 'x', name: 'X', status: 'ACTIVE' as const, region: 'eu' };
  }
  protected async handle(job: { id?: string | number; data: { tenantId: string } }) {
    // Inside ALS — TenantContext.current() must succeed.
    this.ranWithTenant = TenantContext.current('handle').id;
  }
}

test('process() rehydrates ALS', async () => {
  const p = new StubProcessor();
  await p.process({ id: 1, data: { tenantId: '11111111-1111-1111-1111-111111111111' } });
  expect(p.ranWithTenant).toBe('11111111-1111-1111-1111-111111111111');
});

test('process() rejects missing tenantId', async () => {
  const p = new StubProcessor();
  const e = await expectThrows(() => p.process({ id: 2, data: {} as any }));
  expect(e.message).toContain('missing tenantId');
});

test('two interleaved jobs do not bleed context', async () => {
  const p = new StubProcessor();
  const seen: Array<string | null> = [];
  class Probe extends TenantAwareJobProcessor<{ tenantId: string }> {
    protected async resolveTenant(tenantId: string) {
      return { id: tenantId, slug: 'x', name: 'X', status: 'ACTIVE' as const, region: 'eu' };
    }
    protected async handle(job: any) {
      await new Promise(r => setTimeout(r, Math.random() * 5));
      seen.push(TenantContext.optional()?.id ?? null);
    }
  }
  const probe = new Probe();
  const tids = [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
  ];
  await Promise.all(
    Array.from({ length: 30 }, (_, i) => probe.process({ id: i, data: { tenantId: tids[i % 3] } })),
  );
  expect(seen.length).toBe(30);
  // Each result must equal one of the seeded tenants.
  expect(seen.every(s => s !== null && tids.includes(s))).toBe(true);
});

run();
