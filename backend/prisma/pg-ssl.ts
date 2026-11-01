import type { PoolConfig } from 'pg';
import { existsSync, readFileSync } from 'fs';

export type PgSslConfig = PoolConfig['ssl'];

/**
 * Parse the `sslmode` query parameter from a PostgreSQL connection URL and
 * return the corresponding node-pg SSL config.
 *
 * Supported libpq sslmode values (best-effort mapping — node-pg does not
 * implement libpq's graceful fallback between SSL and plain connections):
 *
 *   disable     → no SSL
 *   allow       → no SSL (libpq's "try plain, then SSL" is not supported)
 *   prefer      → SSL without certificate verification (node-pg cannot fall
 *                 back to a plain connection, so we use the strongest option
 *                 that will not fail against self-signed/managed databases)
 *   require     → SSL without certificate verification
 *   verify-ca   → SSL with CA chain verification; hostname check skipped
 *                 (uses the Node trust store; set NODE_EXTRA_CA_CERTS for
 *                 custom CAs)
 *   verify-full → SSL with full CA chain + hostname verification
 *
 * Certificate trust (replaces a global NODE_TLS_REJECT_UNAUTHORIZED=0):
 *   DATABASE_CA_CERT  PEM text of the database CA (DigitalOcean: the cluster's
 *                     "CA certificate"; it is public, not a secret), or
 *   PGSSLROOTCERT     path to that PEM file (the libpq variable).
 * With a CA configured, `require`/`prefer` VERIFY the certificate chain
 * against it — exactly what libpq does when a root certificate is present —
 * and verify-ca / verify-full use it as the trust anchor. Without a CA the
 * historical behaviour is unchanged.
 *
 * When the URL does not set `sslmode`, SSL is disabled. This matches the
 * historical behaviour of the project and keeps local/dev connections to
 * plain Postgres working out of the box. Set `?sslmode=require` (or
 * stricter) explicitly on managed/production databases that require TLS.
 */
/** The configured database CA (PEM), or undefined. */
export function databaseCa(): string | undefined {
  const pem = process.env.DATABASE_CA_CERT;
  if (pem && pem.includes('BEGIN CERTIFICATE')) return pem.replace(/\\n/g, '\n');
  const file = process.env.PGSSLROOTCERT;
  if (file && file !== 'system' && existsSync(file)) return readFileSync(file, 'utf8');
  return undefined;
}

export function resolvePoolSsl(databaseUrl: string | undefined): PgSslConfig {
  if (!databaseUrl) return false;

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }

  const ca = databaseCa();
  switch (url.searchParams.get('sslmode')) {
    case 'disable':
    case 'allow':
      return false;
    case 'prefer':
    case 'require':
      return ca
        ? { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }
        : { rejectUnauthorized: false };
    case 'verify-ca':
      return { ...(ca ? { ca } : {}), rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full':
      return { ...(ca ? { ca } : {}), rejectUnauthorized: true };
    default:
      return false;
  }
}

/**
 * Return the raw libpq sslmode value from a PostgreSQL connection URL, or
 * `undefined` when it is not set. Useful for forwarding the mode to child
 * processes such as `pg_dump`/`pg_restore` via the `PGSSLMODE` env var.
 */
export function readSslMode(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;
  try {
    const mode = new URL(databaseUrl).searchParams.get('sslmode');
    return mode ?? undefined;
  } catch {
    return undefined;
  }
}
