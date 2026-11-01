/**
 * Seeded faker + deterministic-id helpers.
 *
 * Re-runs of the seed must produce identical output (same UUIDs, same
 * fake names) so it is safe to run as `prisma db seed` without
 * accumulating dupes or churn. Both helpers below are seeded from a
 * single string so the whole graph is reproducible.
 */
import { faker } from '@faker-js/faker';
import { createHash } from 'crypto';

// Single seed everything derives from. Override via SEED env var if you
// want a different deterministic dataset.
export const SEED_BASE = process.env.SEED_BASE ?? 'tempworks-dev-seed-v1';

faker.seed(hash32(SEED_BASE));

export { faker };

/**
 * Deterministic UUID v4-shaped string derived from a tag. Two callers
 * with the same tag get the same UUID across runs.
 */
export function detId(...parts: string[]): string {
  const h = createHash('sha1').update([SEED_BASE, ...parts].join('|')).digest('hex');
  // Shape into a UUID v4 (variant + version bits patched).
  const u = h.slice(0, 32);
  const a = u.slice(0, 8);
  const b = u.slice(8, 12);
  const c = '4' + u.slice(13, 16);
  const d = ((parseInt(u.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + u.slice(17, 20);
  const e = u.slice(20, 32);
  return `${a}-${b}-${c}-${d}-${e}`;
}

function hash32(s: string): number {
  return parseInt(createHash('sha1').update(s).digest('hex').slice(0, 8), 16);
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(faker.number.float({ min: 0, max: arr.length - 0.0001 }))];
}
