/**
 * Aggregate runner.
 *
 *   pnpm --filter backend exec ts-node src/saas/__validation__/all.ts
 *
 * Each suite calls `run()` itself; we just import them serially.
 */
async function main(): Promise<void> {
  // Each suite is a separate ts-node child so test arrays do not bleed
  // across suite boundaries.
  const { execSync } = require('child_process') as typeof import('child_process');
  const suites = [
    'feature-flags.check.ts',
    'als.check.ts',
    'rls.check.ts',
    'registry.check.ts',
    'jobs.check.ts',
    'reports.check.ts',
  ];
  let failed = 0;
  for (const s of suites) {
    try {
      execSync(`ts-node src/saas/__validation__/${s}`, { stdio: 'inherit' });
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n${failed} suite(s) FAILED`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`\nAll ${suites.length} suites passed.`);
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
