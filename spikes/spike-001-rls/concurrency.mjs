// Spike 001 — concurrency & pooling correctness
// Simulates the pattern TenantPrismaService will use: shared pool, per-request
// transaction with SET LOCAL app.tenant_id. Verifies no leakage when many
// requests for different tenants land on the same backend connection.

import pg from 'pg';
const { Pool } = pg;

const T_A = '11111111-1111-1111-1111-111111111111';
const T_B = '22222222-2222-2222-2222-222222222222';

// Small pool forces connection reuse — equivalent to PgBouncer transaction mode
const pool = new Pool({
  host: '127.0.0.1',
  database: 'spike_rls',
  user: 'spike_app',
  max: 4,
});

async function tenantQuery(tenantId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function leakProbe() {
  // 200 interleaved requests, half tenant A, half tenant B.
  // Each request asserts it sees ONLY its tenant's rows.
  const N = 200;
  const tasks = Array.from({ length: N }, (_, i) => {
    const tid = i % 2 === 0 ? T_A : T_B;
    return tenantQuery(tid, async (c) => {
      const { rows } = await c.query(
        'SELECT tenant_id::text AS tid, count(*)::int AS n FROM candidates GROUP BY 1'
      );
      // Must be exactly one group, matching this tenant
      if (rows.length !== 1 || rows[0].tid !== tid) {
        throw new Error(`LEAK detected (request ${i}, expected ${tid}): ${JSON.stringify(rows)}`);
      }
      return rows[0].n;
    });
  });
  const counts = await Promise.all(tasks);
  return counts;
}

async function noTxProbe() {
  // Run a query OUTSIDE any tx after another connection set LOCAL — must see 0
  const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT count(*)::int AS n FROM candidates');
    return rows[0].n;
  } finally {
    c.release();
  }
}

async function timing() {
  // 1000 tenant-scoped findMany equivalents, single connection
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    await tenantQuery(T_A, async (c) => {
      await c.query('SELECT id FROM candidates LIMIT 50');
    });
  }
  return Date.now() - t0;
}

async function rawTiming() {
  // Same 1000 queries WITHOUT tx wrapper (would be unsafe under RLS, baseline only)
  const c = await pool.connect();
  // Run as platform_admin so RLS doesn't block
  try {
    await c.query("RESET ROLE"); // already spike_app via DB user, baseline as-is
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      await c.query("SELECT id FROM candidates WHERE tenant_id = $1 LIMIT 50", [T_A]);
    }
    return Date.now() - t0;
  } finally {
    c.release();
  }
}

(async () => {
  console.log('--- leak probe (200 interleaved, mixed tenants) ---');
  const counts = await leakProbe();
  const allEq = counts.every((n) => n === 1000);
  console.log(`each request saw 1000 rows (own tenant): ${allEq ? 'PASS' : 'FAIL'}`);

  console.log('--- no-tx probe (after pool reuse) ---');
  const n = await noTxProbe();
  console.log(`rows visible outside tx: ${n} (expect 0): ${n === 0 ? 'PASS' : 'FAIL'}`);

  console.log('--- timing ---');
  const tx = await timing();
  // Note: rawTiming would still hit RLS for spike_app; we run it via the
  // bypass role to get a clean baseline.
  const rawPool = new Pool({
    host: '127.0.0.1', database: 'spike_rls', user: 'spike_admin', max: 1,
  });
  const c = await rawPool.connect();
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    await c.query("SELECT id FROM candidates WHERE tenant_id = $1 LIMIT 50", [T_A]);
  }
  const raw = Date.now() - t0;
  c.release();
  await rawPool.end();
  console.log(`tx-wrapped 1000 ops: ${tx} ms`);
  console.log(`raw 1000 ops:        ${raw} ms`);
  console.log(`overhead:            ${((tx / raw - 1) * 100).toFixed(1)}%`);

  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
