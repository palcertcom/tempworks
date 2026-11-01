/**
 * Lightweight test runner for Phase 0 validation suites.
 *
 * The existing codebase has no Jest configuration. Adding one is invasive
 * and out of Phase 0 scope. Instead, every Phase 0 suite is a plain
 * ts-node entry point that uses this tiny harness to report PASS/FAIL.
 *
 * Run a single suite:
 *   pnpm --filter backend exec ts-node src/saas/__validation__/<file>.ts
 *
 * Run all:
 *   pnpm --filter backend run saas:validate
 */

type Test = { name: string; fn: () => Promise<void> | void };

const tests: Test[] = [];
let suiteName = '<unset>';

export function suite(name: string): void {
  suiteName = name;
  tests.length = 0;
  // eslint-disable-next-line no-console
  console.log(`\n=== ${name} ===`);
}

export function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, fn });
}

export function expect<T>(actual: T) {
  return {
    toBe(expected: T): void {
      if (actual !== expected) {
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: unknown): void {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`expected ${e}, got ${a}`);
    },
    toContain(needle: string): void {
      if (typeof actual !== 'string' || !actual.includes(needle)) {
        throw new Error(`expected string to contain ${JSON.stringify(needle)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeTruthy(): void {
      if (!actual) throw new Error(`expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy(): void {
      if (actual) throw new Error(`expected falsy, got ${JSON.stringify(actual)}`);
    },
    toBeDefined(): void {
      if (actual === undefined) throw new Error('expected defined, got undefined');
    },
    toThrow(): void {
      throw new Error('use toThrowAsync via expectThrows wrapper');
    },
  };
}

export async function expectThrows(fn: () => unknown | Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected function to throw, but it returned');
}

export async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      // eslint-disable-next-line no-console
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`  FAIL  ${t.name}\n        ${(e as Error).message}`);
      failed++;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n${suiteName}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
