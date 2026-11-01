// Spike 004 — Tenant-safe reports builder
// Demonstrates: a SOURCE_DEFS registry where every entry MUST declare a
// tenant filter; the builder rejects sources without it; user filters are
// AND-only over a whitelist of fields; identifiers are quoted via a typed
// helper; values are parameterized.
//
// Runs against the spike_rls DB seeded by Spike-001.

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ host: '127.0.0.1', database: 'spike_rls', user: 'spike_app', max: 4 });
const T_A = '11111111-1111-1111-1111-111111111111';
const T_B = '22222222-2222-2222-2222-222222222222';

// ---- Registry ----
const SOURCE_DEFS = {
  candidates: {
    rootTable: 'candidates',
    tenantColumn: 'tenant_id',
    fields: {
      id:        { col: 'id',         type: 'uuid' },
      email:     { col: 'email',      type: 'text' },
      full_name: { col: 'full_name',  type: 'text' },
      created_at:{ col: 'created_at', type: 'timestamptz' },
    },
  },
  // Intentionally missing tenantColumn — startup MUST reject it
  candidates_unsafe: {
    rootTable: 'candidates',
    fields: { id: { col: 'id', type: 'uuid' } },
  },
};

// ---- Validator ----
function validateSources(defs) {
  const errors = [];
  for (const [k, d] of Object.entries(defs)) {
    if (!d.tenantColumn) errors.push(`source '${k}' missing tenantColumn`);
    if (!d.rootTable)    errors.push(`source '${k}' missing rootTable`);
    if (!d.fields || Object.keys(d.fields).length === 0) errors.push(`source '${k}' has no fields`);
  }
  return errors;
}

// ---- Identifier quoter (allowlist enforced) ----
function ident(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('bad identifier: ' + name);
  return `"${name}"`;
}

const ALLOWED_OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'ILIKE', 'IN']);

function buildWhere(filters, fields, params) {
  if (!filters?.length) return { sql: '', params };
  const parts = [];
  for (const f of filters) {
    const fdef = fields[f.field];
    if (!fdef) throw new Error('unknown field: ' + f.field);
    if (!ALLOWED_OPS.has(f.op)) throw new Error('forbidden op: ' + f.op);
    if (f.op === 'IN') {
      if (!Array.isArray(f.value) || f.value.length === 0) throw new Error('IN needs array');
      const idxs = f.value.map(v => { params.push(v); return `$${params.length}`; });
      parts.push(`${ident(fdef.col)} IN (${idxs.join(',')})`);
    } else {
      params.push(f.value);
      parts.push(`${ident(fdef.col)} ${f.op} $${params.length}`);
    }
  }
  return { sql: 'AND ' + parts.join(' AND '), params };
}

// ---- The actual run() — tenant filter is FIXED, parameter-bound ----
async function runReport(sourceKey, tenantId, userFilters = []) {
  const def = SOURCE_DEFS[sourceKey];
  if (!def) throw new Error('unknown source: ' + sourceKey);
  if (!def.tenantColumn) throw new Error('source not tenant-safe: ' + sourceKey);

  const cols = Object.values(def.fields).map(f => ident(f.col)).join(', ');
  const params = [tenantId];
  const where = buildWhere(userFilters, def.fields, params);

  const sql = `SELECT ${cols} FROM ${ident(def.rootTable)}
               WHERE ${ident(def.tenantColumn)} = $1 ${where.sql}
               LIMIT 50`;

  // Tenant filter at app layer + RLS at DB layer = belt and suspenders
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const r = await c.query(sql, where.params);
    await c.query('COMMIT');
    return r.rows;
  } catch (e) { await c.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { c.release(); }
}

// ---- Tests ----
async function main() {
  // Startup validation
  const errs = validateSources(SOURCE_DEFS);
  console.log('startup validation errors:', errs);
  if (!errs.some(e => e.includes('candidates_unsafe'))) {
    console.log('FAIL: validator did not catch unsafe source');
    process.exit(1);
  }

  // Run for tenant A
  const a = await runReport('candidates', T_A);
  const b = await runReport('candidates', T_B);
  console.log(`tenant A rows: ${a.length} (expected 50, ≤1000)`);
  console.log(`tenant B rows: ${b.length} (expected 50)`);
  // No row from A appears in B
  const aIds = new Set(a.map(r => r.id));
  const overlap = b.filter(r => aIds.has(r.id)).length;
  console.log(`overlap A∩B: ${overlap} (expected 0)`);

  // Reject unsafe source
  try {
    await runReport('candidates_unsafe', T_A);
    console.log('FAIL: unsafe source ran');
  } catch (e) { console.log('unsafe source rejected:', e.message); }

  // Reject bad field
  try {
    await runReport('candidates', T_A, [{ field: 'tenant_id', op: '=', value: T_B }]);
    console.log('FAIL: cross-tenant filter accepted');
  } catch (e) { console.log('cross-tenant filter rejected:', e.message); }

  // Reject SQL injection in op
  try {
    await runReport('candidates', T_A, [{ field: 'email', op: 'OR 1=1 --', value: 'x' }]);
    console.log('FAIL: bad op accepted');
  } catch (e) { console.log('bad op rejected:', e.message); }

  // Reject identifier injection
  try { ident('candidates; DROP TABLE x'); console.log('FAIL: ident allowed injection'); }
  catch (e) { console.log('ident rejected:', e.message); }

  // Even with adversarial filter values (parameterized, so safe)
  const r = await runReport('candidates', T_A, [
    { field: 'email', op: 'ILIKE', value: "%' OR 1=1 --" },
  ]);
  console.log(`adversarial value safely parameterized; rows: ${r.length} (expect 0)`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
