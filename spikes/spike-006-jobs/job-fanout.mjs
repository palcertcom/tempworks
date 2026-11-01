// Spike 006 — Tenant-aware job fan-out simulation
// In lieu of a real BullMQ deployment we simulate the queue contract:
//  - producer enqueues per-tenant jobs (job.data carries tenantId)
//  - worker re-enters ALS via TenantAwareJobProcessor
//  - retries preserve tenantId
//  - delayed jobs preserve tenantId
//  - cron fanout schedules N tenants in parallel
// Validates that no shared mutable state leaks tenant context across handlers
// when concurrency > 1.

import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage();

class FakeQueue {
  constructor(name, concurrency = 4) {
    this.name = name;
    this.jobs = [];
    this.concurrency = concurrency;
    this.handler = null;
  }
  add(name, data, opts = {}) {
    const job = { id: this.jobs.length + 1, name, data, attempts: opts.attempts ?? 1, delay: opts.delay ?? 0 };
    this.jobs.push(job);
    return job;
  }
  process(handler) { this.handler = handler; }
  async drain() {
    // Simulate concurrent workers
    const queue = [...this.jobs].sort((a, b) => (a.delay || 0) - (b.delay || 0));
    const inflight = new Set();
    const results = [];
    while (queue.length || inflight.size) {
      while (inflight.size < this.concurrency && queue.length) {
        const job = queue.shift();
        const p = (async () => {
          try {
            return await this.handler(job);
          } catch (e) {
            if (job.attempts > 1) {
              job.attempts -= 1;
              queue.push(job);              // retry
              return { retry: true };
            }
            return { error: e.message };
          }
        })().then(r => { inflight.delete(p); results.push(r); });
        inflight.add(p);
      }
      if (inflight.size) await Promise.race(inflight);
    }
    return results;
  }
}

// Base class — the production version of TenantAwareJobProcessor
class TenantAwareJobProcessor {
  constructor(tenants /* fake repo */) { this.tenants = tenants; }
  async process(job) {
    const tenant = this.tenants.requireById(job.data.tenantId);
    return als.run({ tenant, requestId: `job:${job.id}` }, () => this.handle(job));
  }
}

// A handler that asserts ALS contains the right tenant
class CheckTenantJob extends TenantAwareJobProcessor {
  constructor(tenants, results) { super(tenants); this.results = results; }
  async handle(job) {
    const seen = als.getStore()?.tenant;
    // Yield the event loop a few times — common cause of context loss bugs
    await new Promise(r => setImmediate(r));
    await Promise.all([
      new Promise(r => setTimeout(r, 1)).then(() => als.getStore()?.tenant),
      new Promise(r => setTimeout(r, 1)).then(() => als.getStore()?.tenant),
    ]);
    const after = als.getStore()?.tenant;
    const ok = seen === after && seen?.id === job.data.tenantId;
    this.results.push({ jobId: job.id, ok, expected: job.data.tenantId, seen: seen?.id });
    if (!ok) throw new Error(`context lost: expected ${job.data.tenantId}, got ${seen?.id}`);
  }
}

// --- Drivers ---
const tenants = {
  '11111111-1111-1111-1111-111111111111': { id: '11111111-1111-1111-1111-111111111111', name: 'Acme' },
  '22222222-2222-2222-2222-222222222222': { id: '22222222-2222-2222-2222-222222222222', name: 'Globex' },
  '33333333-3333-3333-3333-333333333333': { id: '33333333-3333-3333-3333-333333333333', name: 'Initech' },
  requireById(id) { const t = this[id]; if (!t) throw new Error('no tenant ' + id); return t; },
};

async function probeFanout() {
  const q = new FakeQueue('notifications.runChecks', 8);
  const results = [];
  const proc = new CheckTenantJob(tenants, results);
  q.process(job => proc.process(job));

  // 100 jobs across 3 tenants, interleaved
  for (let i = 0; i < 100; i++) {
    const t = ['11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222',
              '33333333-3333-3333-3333-333333333333'][i % 3];
    q.add('check', { tenantId: t });
  }
  await q.drain();
  const fail = results.filter(r => !r.ok);
  console.log(`fanout: ${results.length} jobs, leaks: ${fail.length}`);
  return fail.length === 0;
}

async function probeRetry() {
  const q = new FakeQueue('flaky', 4);
  const results = [];
  let crashes = 0;
  q.process(async job => {
    return als.run({ tenant: tenants.requireById(job.data.tenantId), requestId: `job:${job.id}` }, async () => {
      // Crash every 3rd attempt to force a retry — context must persist on retry.
      if (Math.random() < 0.3 && crashes < 10) { crashes++; throw new Error('flaky'); }
      results.push({ jobId: job.id, tid: als.getStore()?.tenant?.id, expected: job.data.tenantId });
    });
  });
  for (let i = 0; i < 50; i++) {
    q.add('flaky', { tenantId: i % 2 === 0 ? '11111111-1111-1111-1111-111111111111' : '22222222-2222-2222-2222-222222222222' }, { attempts: 4 });
  }
  await q.drain();
  const wrong = results.filter(r => r.tid !== r.expected);
  console.log(`retry: ${results.length} successful runs, mismatches: ${wrong.length}, crashes: ${crashes}`);
  return wrong.length === 0;
}

async function probeCronFanout() {
  // Scheduler enqueues one job per active tenant every period. We assert
  // each tenant gets exactly one job per period.
  const q = new FakeQueue('cron.checks', 4);
  const counts = new Map();
  q.process(async job => {
    counts.set(job.data.tenantId, (counts.get(job.data.tenantId) ?? 0) + 1);
  });
  // 3 ticks of the cron scheduler
  for (let tick = 0; tick < 3; tick++) {
    for (const tid of [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ]) q.add('check', { tenantId: tid, tick });
  }
  await q.drain();
  console.log('cron counts:', [...counts.entries()].map(([k,v]) => `${k.slice(0,4)}=${v}`).join(' '));
  return [...counts.values()].every(v => v === 3);
}

(async () => {
  console.log('fanout      :', await probeFanout()      ? 'PASS' : 'FAIL');
  console.log('retry       :', await probeRetry()       ? 'PASS' : 'FAIL');
  console.log('cron fanout :', await probeCronFanout()  ? 'PASS' : 'FAIL');
})();
