/**
 * Phase 2.2 — Live diagnostics probe.
 *
 * Calls the three `/api/v1/saas/diagnostics/*` endpoints against a
 * running app. Useful as a post-deploy smoke test in staging.
 *
 * Usage:
 *   npm run saas:phase2-diagnostics -- --base http://localhost:3000 \
 *     --tenant-id <uuid> --token <jwt>
 *
 * Outputs JSON to stdout. Never logs the JWT.
 */
/* eslint-disable no-console */
import http from 'http';
import https from 'https';
import { URL } from 'url';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchJson(urlStr: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const url = new URL(urlStr);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(body); } catch { json = body; }
        resolve({ status: res.statusCode ?? 0, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const base = arg('--base') ?? 'http://localhost:3000';
  const tenantId = arg('--tenant-id') ?? '';
  const token = arg('--token') ?? '';

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  for (const path of ['/api/v1/saas/diagnostics/flags', '/api/v1/saas/diagnostics/context', '/api/v1/saas/diagnostics/tenant-resolution']) {
    const r = await fetchJson(base + path, headers);
    console.log(`\n=== ${path} ===`);
    console.log(`status: ${r.status}`);
    console.log(JSON.stringify(r.body, null, 2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
