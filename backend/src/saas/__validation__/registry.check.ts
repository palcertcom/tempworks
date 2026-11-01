import { suite, test, expect, run } from './runner';
import {
  TENANT_SCOPED_MODELS,
  GLOBAL_MODELS,
  CATALOG_MODELS,
  classify,
  isTenantScoped,
} from '../prisma/tenant-scoped-models';

suite('tenant-scoped-models');

test('Phase 0 invariant: TENANT_SCOPED_MODELS is empty', () => {
  expect(TENANT_SCOPED_MODELS.size).toBe(0);
});

test('Phase 0 invariant: CATALOG_MODELS is empty', () => {
  expect(CATALOG_MODELS.size).toBe(0);
});

test('GLOBAL_MODELS contains all SaaS identity tables', () => {
  expect(GLOBAL_MODELS.has('User')).toBe(true);
  expect(GLOBAL_MODELS.has('Tenant')).toBe(true);
  expect(GLOBAL_MODELS.has('TenantMembership')).toBe(true);
  expect(GLOBAL_MODELS.has('PlatformAdmin')).toBe(true);
  expect(GLOBAL_MODELS.has('PlatformAuditLog')).toBe(true);
});

test('classify returns expected values', () => {
  expect(classify('User')).toBe('GLOBAL');
  expect(classify('UnknownModel')).toBe('UNKNOWN');
});

test('isTenantScoped returns false for everything in Phase 0', () => {
  expect(isTenantScoped('Employee')).toBe(false);
  expect(isTenantScoped('User')).toBe(false);
});

run();
