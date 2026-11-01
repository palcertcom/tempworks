// Spike 002 — AsyncLocalStorage propagation probe
// Validates that an ALS store survives across:
//  - awaited promises
//  - Promise.all
//  - setTimeout / setImmediate / queueMicrotask
//  - EventEmitter listeners
//  - streams (async iteration)
//  - thrown-and-caught errors
//  - Node Worker thread (expected: NOT propagated; documented limitation)
//
// Also benchmarks ALS vs no-ALS overhead.

import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const als = new AsyncLocalStorage();

function ctx() { return als.getStore()?.tenant ?? null; }

async function awaitChain() {
  const a = ctx();
  await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setImmediate(r));
  await new Promise(r => queueMicrotask(r));
  const b = ctx();
  return a === b ? 'PASS' : `FAIL ${a} -> ${b}`;
}

async function promiseAll() {
  const a = ctx();
  const results = await Promise.all([1, 2, 3].map(async () => {
    await new Promise(r => setTimeout(r, 1));
    return ctx();
  }));
  return results.every(r => r === a) ? 'PASS' : `FAIL ${a} ${results}`;
}

async function eventEmitterCase() {
  const ee = new EventEmitter();
  const a = ctx();
  let captured = null;
  ee.on('x', () => { captured = ctx(); });
  ee.emit('x');
  return captured === a ? 'PASS' : `FAIL ${a} -> ${captured}`;
}

async function asyncIteratorCase() {
  const a = ctx();
  async function* gen() { yield ctx(); yield ctx(); yield ctx(); }
  const seen = [];
  for await (const v of gen()) seen.push(v);
  return seen.every(v => v === a) ? 'PASS' : `FAIL ${a} ${seen}`;
}

async function errorPath() {
  const a = ctx();
  try { await Promise.reject(new Error('boom')); }
  catch { /* ignore */ }
  return ctx() === a ? 'PASS' : 'FAIL';
}

async function detachedTimer() {
  // Fire-and-forget: store should still be available inside the timer
  const a = ctx();
  return new Promise(resolve => {
    setTimeout(() => resolve(ctx() === a ? 'PASS' : `FAIL ${a} -> ${ctx()}`), 5);
  });
}

async function workerCase() {
  // ALS is per-thread. Spawning a Worker resets context — expected.
  return new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { mode: 'check' } });
    w.once('message', m => { resolve(m === null ? 'PASS-DOCUMENTED' : `UNEXPECTED ${m}`); w.terminate(); });
    w.postMessage('check');
  });
}

async function bench() {
  const N = 1_000_000;
  let s1 = 0, s2 = 0;
  // No ALS
  const t0 = Date.now();
  for (let i = 0; i < N; i++) s1 += i;
  const t1 = Date.now();
  // ALS
  const t2 = Date.now();
  await als.run({ tenant: 't' }, async () => {
    for (let i = 0; i < N; i++) s2 += i;
  });
  const t3 = Date.now();
  return { noAls: t1 - t0, withAls: t3 - t2, equal: s1 === s2 };
}

async function main() {
  await als.run({ tenant: 't-acme' }, async () => {
    console.log('awaitChain        ', await awaitChain());
    console.log('promiseAll        ', await promiseAll());
    console.log('eventEmitter      ', await eventEmitterCase());
    console.log('asyncIterator     ', await asyncIteratorCase());
    console.log('errorPath         ', await errorPath());
    console.log('detachedTimer     ', await detachedTimer());
  });
  console.log('outsideRun        ', ctx() === null ? 'PASS' : `FAIL ${ctx()}`);
  console.log('workerThread      ', await workerCase());
  console.log('bench             ', await bench());
}

if (!isMainThread) {
  parentPort.once('message', () => parentPort.postMessage(als.getStore()?.tenant ?? null));
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}
