#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tls-check.mjs — read-only TLS trust check for every outbound connection the
// backend makes, with certificate verification EXPLICITLY ON, regardless of
// NODE_TLS_REJECT_UNAUTHORIZED. Run it inside the production container (App
// Platform console) BEFORE removing NODE_TLS_REJECT_UNAUTHORIZED=0:
//
//     node scripts/ops/tls-check.mjs            # human summary + JSON line
//
// Database: connects with the app's own TLS policy plus two strict variants
//   (chain verified against DATABASE_CA_CERT/PGSSLROOTCERT or the system store;
//   chain + host name). Runs `SELECT 1` only.
// HTTPS: TLS handshake only (no request is sent) to the upload/backup object
//   storage endpoints, the public upload URL host, api.resend.com and
//   www.google.com (reCAPTCHA); reports whether the chain is trusted by Node's
//   default store and the certificate's issuer/expiry.
// Prints host names and verdicts only — never credentials or URLs with secrets.
// Exit 0 = every configured endpoint verifies; 1 = at least one does not.
// ─────────────────────────────────────────────────────────────────────────────
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(BACKEND, 'package.json'));
const { Client } = require('pg');
const { resolvePoolSsl, databaseCa } = require(join(BACKEND, 'prisma', 'pg-ssl.js'));
const E = process.env;
const results = [];
const add = (r) => { results.push(r); console.log(`${r.ok ? '✓' : '✗'} ${r.target.padEnd(42)} ${r.detail}`); };

if (E.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  console.log('! NODE_TLS_REJECT_UNAUTHORIZED=0 is set in this process — certificate checks are DISABLED for ordinary');
  console.log('  connections. This tool sets verification explicitly per connection, so its results are still valid.\n');
}

// ── database ────────────────────────────────────────────────────────────────
async function pgTry(label, ssl) {
  const url = new URL(E.DATABASE_URL);
  url.searchParams.delete('sslmode'); // the ssl object below is authoritative
  const c = new Client({ connectionString: url.toString(), ssl, connectionTimeoutMillis: 10000 });
  try { await c.connect(); await c.query('SELECT 1'); return { ok: true, detail: label }; }
  catch (e) { return { ok: false, detail: `${label}: ${e.code || ''} ${e.message}`.trim() }; }
  finally { await c.end().catch(() => undefined); }
}
if (E.DATABASE_URL) {
  const u = new URL(E.DATABASE_URL);
  const host = `${u.hostname}:${u.port || 5432}`;
  const mode = u.searchParams.get('sslmode') || '(none)';
  const ca = databaseCa();
  const app = resolvePoolSsl(E.DATABASE_URL);
  const verifying = !!app && app.rejectUnauthorized === true;
  const a = await pgTry(`app policy (sslmode=${mode}${ca ? ', CA configured' : ''}): ${!app ? 'NO TLS' : verifying ? 'verified' : 'encrypted, NOT verified'}`, app);
  add({ target: `postgres ${host} [app policy]`, ok: a.ok && verifying, detail: a.detail, connects: a.ok });
  const chain = await pgTry('chain verified', { ...(ca ? { ca } : {}), rejectUnauthorized: true, checkServerIdentity: () => undefined });
  add({ target: `postgres ${host} [chain]`, ok: chain.ok, detail: chain.ok ? `chain trusted (${ca ? 'DATABASE_CA_CERT/PGSSLROOTCERT' : 'system store'})` : chain.detail });
  const full = await pgTry('chain + host name verified', { ...(ca ? { ca } : {}), rejectUnauthorized: true });
  add({ target: `postgres ${host} [chain+hostname]`, ok: full.ok, detail: full.ok ? 'verify-full would work' : full.detail });
} else {
  console.log('- DATABASE_URL not set: database not checked');
}

// ── HTTPS endpoints ─────────────────────────────────────────────────────────
function hostOf(v) { try { return new URL(v).hostname; } catch { return null; } }
function handshake(host, port = 443) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 10000 }, () => {
      const cert = s.getPeerCertificate();
      resolve({ ok: s.authorized, detail: s.authorized
        ? `trusted; issuer "${cert.issuer?.O || cert.issuer?.CN}", expires ${cert.valid_to}`
        : `NOT trusted: ${s.authorizationError}` });
      s.end();
    });
    s.on('timeout', () => { resolve({ ok: false, detail: 'timeout' }); s.destroy(); });
    s.on('error', (e) => resolve({ ok: false, detail: e.message }));
  });
}
const https = new Map();
const want = (why, v) => { const h = hostOf(v); if (h && !https.has(h)) https.set(h, why); };
want('upload storage endpoint', E.DO_SPACES_ENDPOINT);
want('public upload URL', E.DO_SPACES_PUBLIC_URL);
want('backup storage endpoint', E.BACKUP_SPACES_ENDPOINT);
if (E.DO_SPACES_BUCKET && hostOf(E.DO_SPACES_ENDPOINT)) want('upload bucket (virtual-host)', `https://${E.DO_SPACES_BUCKET}.${hostOf(E.DO_SPACES_ENDPOINT)}`);
if (E.BACKUP_SPACES_BUCKET && hostOf(E.BACKUP_SPACES_ENDPOINT || E.DO_SPACES_ENDPOINT)) want('backup bucket (virtual-host)', `https://${E.BACKUP_SPACES_BUCKET}.${hostOf(E.BACKUP_SPACES_ENDPOINT || E.DO_SPACES_ENDPOINT)}`);
if (E.TLS_CHECK_SKIP_EXTERNAL !== '1') { // local tests without internet egress set this
  want('e-mail API (Resend)', 'https://api.resend.com');
  want('reCAPTCHA verification', 'https://www.google.com');
}
for (const [h, why] of https) {
  if (/^(127\.|localhost$)/.test(h)) { console.log(`- ${h} (${why}): local endpoint, skipped`); continue; }
  const r = await handshake(h);
  add({ target: `${h} [${why}]`, ...r });
}

const ok = results.every((r) => r.ok);
console.log(`\n${ok ? 'ALL VERIFIED — NODE_TLS_REJECT_UNAUTHORIZED=0 is not needed for these endpoints.' : 'NOT ALL VERIFIED — keep the current setting until the failures above are resolved (see docs).'}`);
console.log(JSON.stringify({ tlsCheck: ok ? 'ok' : 'failed', results }));
process.exit(ok ? 0 : 1);
