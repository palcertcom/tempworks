import { suite, test, expect, run } from './runner';
import { FeatureFlagsService, FLAG_KEYS, FLAG_DEFAULTS, parseFlag } from '../feature-flags';

suite('feature-flags');

test('parseFlag accepts truthy aliases', () => {
  expect(parseFlag('true', false)).toBe(true);
  expect(parseFlag('TRUE', false)).toBe(true);
  expect(parseFlag('1', false)).toBe(true);
  expect(parseFlag('on', false)).toBe(true);
  expect(parseFlag('yes', false)).toBe(true);
});

test('parseFlag accepts falsy aliases', () => {
  expect(parseFlag('false', true)).toBe(false);
  expect(parseFlag('0', true)).toBe(false);
  expect(parseFlag('off', true)).toBe(false);
  expect(parseFlag('no', true)).toBe(false);
});

test('parseFlag falls back to default on unknown values', () => {
  expect(parseFlag('maybe', true)).toBe(true);
  expect(parseFlag('', false)).toBe(false);
  expect(parseFlag(undefined, false)).toBe(false);
});

test('all defaults are false (Phase 0 invariant)', () => {
  for (const k of FLAG_KEYS) expect(FLAG_DEFAULTS[k]).toBe(false);
});

test('forTesting builds a deterministic snapshot', () => {
  const svc = FeatureFlagsService.forTesting({ MULTI_TENANT_ENABLED: true });
  expect(svc.multiTenantEnabled()).toBe(true);
  expect(svc.tenantPrismaEnforcement()).toBe(false);
  expect(svc.signedUrlsEnabled()).toBe(false);
});

test('publicSnapshot is frozen', () => {
  const svc = FeatureFlagsService.forTesting({});
  const snap = svc.publicSnapshot() as Record<string, boolean>;
  let mutated = true;
  try { (snap as any).MULTI_TENANT_ENABLED = true; mutated = (snap as any).MULTI_TENANT_ENABLED === true; }
  catch { mutated = false; }
  expect(mutated).toBe(false);
});

run();
