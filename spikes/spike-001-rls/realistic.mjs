// Realistic: one transaction per HTTP request, multiple queries inside.
import pg from 'pg';
const { Pool } = pg;

const T_A = '11111111-1111-1111-1111-111111111111';
const pool = new Pool({ host: '127.0.0.1', database: 'spike_rls', user: 'spike_app', max: 8 });

async function requestWithTx(queriesPerRequest) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.tenant_id = '${T_A}'`);
    for (let q = 0; q < queriesPerRequest; q++) {
      await c.query('SELECT id, email FROM candidates LIMIT 20');
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { c.release(); }
}

const baseline = new Pool({ host: '127.0.0.1', database: 'spike_rls', user: 'spike_admin', max: 8 });
async function requestNoTx(queriesPerRequest) {
  const c = await baseline.connect();
  try {
    for (let q = 0; q < queriesPerRequest; q++) {
      await c.query('SELECT id, email FROM candidates WHERE tenant_id = $1 LIMIT 20', [T_A]);
    }
  } finally { c.release(); }
}

async function bench(label, fn, requests, qpr) {
  const t0 = Date.now();
  await Promise.all(Array.from({ length: requests }, () => fn(qpr)));
  return { label, ms: Date.now() - t0, requests, qpr };
}

(async () => {
  // Warm up
  await bench('warmup', requestWithTx, 50, 5);

  for (const qpr of [1, 3, 10, 30]) {
    const wrapped = await bench('tx', requestWithTx, 200, qpr);
    // Re-create baseline pool for each measurement (it ends itself)
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 200 }, () => requestNoTx(qpr)));
    const raw = Date.now() - t0;
    const overhead = ((wrapped.ms / raw - 1) * 100).toFixed(1);
    console.log(`${qpr} queries/request × 200 requests: tx=${wrapped.ms}ms baseline=${raw}ms overhead=${overhead}%`);
  }

  await pool.end();
  await baseline.end();
})().catch(e => { console.error(e); process.exit(1); });
