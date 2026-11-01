/**
 * Seed-account credentials. Same plaintext for every seeded user so
 * the dev can sign in with one short password. Bcrypt hashed once at
 * import time — the seed runs many users, so we don't want to hash
 * per-user.
 */
import * as bcrypt from 'bcryptjs';

export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Seed!2026Dev';

let cachedHash: string | null = null;
export async function seedPasswordHash(): Promise<string> {
  if (!cachedHash) cachedHash = await bcrypt.hash(SEED_PASSWORD, 10);
  return cachedHash;
}
