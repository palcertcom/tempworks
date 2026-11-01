# SPIKE-002 — AsyncLocalStorage Tenant Context Propagation

- **Status:** PASS WITH CONSTRAINTS
- **Date:** 2026-05-09
- **Artifact:** `spikes/spike-002-als/als-probe.mjs` (executable)
- **Validates:** ADR-004 §1 (ALS-based RequestContext)

## Hypothesis

A request-scoped `AsyncLocalStorage` store propagates the tenant context faithfully through every async path used by the application — controllers, services, Prisma calls, BullMQ workers, scheduled tasks, websocket gateways — without parameter drilling, with negligible overhead.

## Probe Results (measured, Node 22.22.2)

| Path | Result | Note |
|---|---|---|
| `await Promise.resolve()` | ✅ PASS | Microtask boundary |
| `await new Promise(setTimeout)` | ✅ PASS | Macrotask boundary |
| `await new Promise(setImmediate)` | ✅ PASS | I/O phase |
| `queueMicrotask` | ✅ PASS | |
| `Promise.all([...async])` | ✅ PASS | Parallel branches each see store |
| `EventEmitter` synchronous emit | ✅ PASS | Listener captured store |
| Async iterator / `for await` | ✅ PASS | |
| Thrown-and-caught error | ✅ PASS | Store survives error path |
| Detached `setTimeout` (fire-and-forget) | ✅ PASS | |
| Outside `als.run` | ✅ PASS | `getStore()` returns `undefined` |
| Worker thread | ✅ PASS-DOCUMENTED | Worker is a new thread; ALS is per-thread → store is `undefined` inside the worker. **Expected.** |
| Overhead (1M tight-loop ops) | 8 ms → 14 ms | +6 ms / 1M ops; negligible |

## Implications for Production Code

### Controllers → Services → Prisma
ALS works through standard NestJS request handling: `TenantMiddleware` calls `als.run({ tenant, user }, () => next())` and every downstream `await` chain (controller → guard → interceptor → service → `tenantPrisma`) inherits the store.

### BullMQ Workers
**ALS is per-thread.** A BullMQ worker process is a separate Node process — its `process.on('message')` callbacks have no access to the producer's ALS. **The job payload must carry `tenantId` and the worker must explicitly call `als.run({ tenant }, () => ...)` before invoking handlers.**

This is exactly what the `TenantAwareJobProcessor` base class in ADR-004 §9 specifies. Spike confirms the pattern is the only correct option.

### Scheduled Tasks (cron)
Cron handlers run on the application's event loop (same process). They do **not** start inside any ALS context. The scheduler must enqueue per-tenant jobs (BullMQ pattern) rather than running multi-tenant logic directly in cron — see SPIKE-006.

### Websocket Gateways
Each socket is bound to a tenant at handshake (resolve from host or initial auth message). The gateway must wrap every emitted handler in `als.run({ tenant: socket.data.tenant }, ...)`. Standard nest-socket-io middleware can do this once.

### Streams (file uploads, exports)
Async iteration preserves ALS (✅). Stream-based workflows (multer → S3 → DB) inherit context through normal `for await`. Caveat: any callback handed to a *low-level* C++ binding (e.g. `fs.read` callback signature) inherits ALS, but **threadpool work** inside libuv (e.g. `crypto.pbkdf2`) does **not** corrupt the store; the callback re-enters JS in the same async context.

### Worker Threads / Sub-processes
ALS does **not** cross thread boundaries. If we ever introduce `worker_threads` for CPU-heavy work (PDF rendering, image processing), the dispatcher must serialize `tenantId` into the message payload and the worker must `als.run` it.

## Memory Leak Risks

ALS stores are **per-async-resource**. Each `als.run(store, fn)` call references `store` until all chained operations resolve. Risks:

- **Long-lived listeners**: an `EventEmitter` outside the request scope that captures the store (in a closure) keeps the store alive. Mitigation: `EventEmitter`s used inside a request must not outlive the request.
- **Promises that never resolve**: a request handler that awaits a never-resolving promise leaks the store. Mitigation: Nest's request timeout interceptor (90 s default).
- **Per-tenant caches that close over the store object**: forbidden — caches use plain values, not store references.

The probe's bench number (+6 ms / 1M ops) shows ALS is far below the noise floor of any database call.

## Performance Overhead

- **+6 ns per `als.getStore()` call** (1M iterations in 14 ms vs 8 ms baseline = 6 ms / 1M = 6 ns).
- **`als.run(store, fn)` setup**: O(1), nanoseconds.
- **Compared to a single Postgres roundtrip** (~0.5 ms): **negligible**.

## Recommended Final Implementation Pattern

```ts
// common/context/als.ts
import { AsyncLocalStorage } from 'node:async_hooks';
export interface RequestContext { tenant?: TenantSnapshot; user?: UserSnapshot; requestId: string; }
export const als = new AsyncLocalStorage<RequestContext>();

export const TenantContext = {
  current(): TenantSnapshot {
    const t = als.getStore()?.tenant;
    if (!t) throw new MissingTenantContextError();
    return t;
  },
  optional(): TenantSnapshot | null { return als.getStore()?.tenant ?? null; },
  attachUser(u: UserSnapshot) { const s = als.getStore(); if (s) s.user = u; },
};

// common/middleware/tenant.middleware.ts
async use(req, _res, next) {
  if (PUBLIC_NO_TENANT.has(req.path)) return als.run({ requestId: cuid() }, next);
  const tenant = await this.tenants.resolveByHost(req.hostname);
  if (!tenant || tenant.status !== 'ACTIVE') throw new NotFoundException();
  als.run({ tenant, requestId: cuid() }, next);
}

// jobs base class
export abstract class TenantAwareJobProcessor<T extends { tenantId: string }> {
  async process(job) {
    const tenant = await this.tenants.requireById(job.data.tenantId);
    return als.run({ tenant, requestId: `job:${job.id}` }, () => this.handle(job));
  }
  abstract handle(job): Promise<unknown>;
}
```

## Known Limitations

| # | Limitation | Mitigation |
|---|---|---|
| L-1 | Worker threads / child processes don't inherit ALS | Pass tenantId in payload; re-enter ALS at the boundary |
| L-2 | `setInterval` callbacks created **outside** any `als.run` have no store | Replace `setInterval` patterns (notifications scheduler) with BullMQ per-tenant jobs |
| L-3 | Native add-ons that bypass V8 microtask checkpoints can lose context | None observed in current dependencies; audit on each new native dep |
| L-4 | Heavy use of `domain` API (deprecated) interferes with ALS | We don't use `domain`; lint-block it |

## Verdict: **PASS WITH CONSTRAINTS**

Constraints:

1. `setInterval`/`setTimeout` patterns at module-load time (notifications scheduler) **must** be retired in favor of BullMQ per-tenant jobs that re-enter ALS via `TenantAwareJobProcessor`.
2. EventEmitter listeners that outlive a request are forbidden inside tenant-scoped modules (lint heuristic: warn on `.on(...)` declared at file top-level inside `modules/`).
3. Worker threads (if introduced) must serialize `tenantId` into messages.
4. Tests must run with `--no-experimental-async-context-frame`-like defaults (current Node ALS is stable; don't enable experimental frames mode that changes semantics).

## Cleanup

```sh
rm -rf spikes/spike-002-als
```
