# SaaS Pre-Implementation Risk Matrix

**Compiled from spikes 1–6.** Each row is a concrete, validated risk; mitigations are spike-derived, not theoretical.

| # | Risk | Likelihood | Impact | Status | Mitigation | Owner |
|---|---|---|---|---|---|---|
| **DB-1** | RLS policy `current_setting(...)::uuid` errors on empty string after `RESET` | High (reproduced) | Hard-fail every tenant query | **Mitigated** | All policies wrap in `NULLIF(..., '')::uuid` (SPIKE-001 F-1). Codified in ADR-001/004. | Backend |
| **DB-2** | Plain `SET app.tenant_id` (without `LOCAL`) leaks GUC across pooled connections | High if used | Cross-tenant leakage | **Mitigated** | ESLint rule rejects `SET ` without `LOCAL`; `TenantPrismaService` only emits `SET LOCAL`. (SPIKE-001 F-2.) | Backend |
| **DB-3** | Per-query `BEGIN/SET LOCAL/COMMIT` overhead is too high | Medium (suspected) | Latency regression | **Refuted** | Measured 14% overhead at 10 qps; net positive at 30 qps. Acceptable. (SPIKE-001 F-6.) | Backend |
| **DB-4** | Concurrent multi-tenant requests on small pool leak via shared connection | Medium | Cross-tenant leakage | **Refuted** | 200 interleaved requests on 4-conn pool: 0 leaks. (SPIKE-001 F-5.) | Backend |
| **DB-5** | Long-running reports/exports under transaction-mode pool block backend connections | Medium | Hot-tenant noisy neighbor | **Mitigated by design** | Workers on separate session-mode pool; HTTP API on transaction-mode. (SPIKE-006.) | DevOps |
| **DB-6** | Prepared-statement plans don't pick up partition pruning | Low | Performance | **Watch** | Re-evaluate at 100k+ rows/tenant. | Backend |
| **CTX-1** | ALS doesn't propagate through `Promise.all`, EventEmitter, async iterators | Low (suspected) | Context loss → wrong tenant | **Refuted** | All paths verified. (SPIKE-002.) | Backend |
| **CTX-2** | ALS doesn't cross worker thread / sub-process boundary | Certain | Context loss in worker_threads | **Mitigated by design** | `TenantAwareJobProcessor` re-enters ALS at boundary. (SPIKE-002 + SPIKE-006.) | Backend |
| **CTX-3** | EventEmitters created at module load capture cross-request stores | Low | Memory leak / cross-request bleed | **Mitigated** | Lint heuristic; module-load EE listeners forbidden in tenant-scoped modules. | Backend |
| **CTX-4** | `setInterval` patterns at module load run outside any ALS | High (current code does this) | Cross-tenant scan | **Mitigated by design** | Legacy notifications scheduler retired in favor of BullMQ per-tenant fanout. (SPIKE-002 L-2.) | Backend |
| **MIG-1** | Duplicate emails block the migration | Low (already structurally impossible) | Aborted backfill | **Mitigated** | Pre-flight enforces; existing `User.email UNIQUE` blocks today. (SPIKE-003 F-1.) | Backend |
| **MIG-2** | Foreign-key cascade surprise during agency reparenting | Medium | Data loss / corruption | **Mitigated** | Per-old-agency transactional step; checkpoint table; staging dry-run mandatory. (SPIKE-003 F-2/F-8.) | Backend |
| **MIG-3** | System-agency users lose access during `agencyIsSystem` retirement | Medium | Lockout | **Mitigated** | `PlatformAdmin` provisioned **before** dropping `agencyIsSystem`; dual-honor period. | Backend |
| **MIG-4** | Identifier-sequence collision in cutover window | High | Duplicate identifiers | **Mitigated** | Per-tenant advisory locks + dual-key window. | Backend |
| **MIG-5** | `users.agency_id NOT NULL` blocks system-user detach | Certain | Cannot delete system agency | **Accepted** | Make column nullable for legacy users (matches ADR-002 D-5). (SPIKE-003 F-6.) | Backend |
| **MIG-6** | Reserved-word column names cause migration syntax errors | Low | Migration script failure | **Mitigated** | Convention: avoid reserved words; rename `grant` → `effect`/`is_grant`. (SPIKE-003 F-7.) | Backend |
| **MIG-7** | No automatic rollback after smoke-test failure days later | Certain | Forward-fix only | **Accepted** | Mandatory pre-migration snapshot; staging twice before prod. | Ops |
| **REP-1** | Reports SQL bypasses tenant filter via raw composition | High in current codebase | Catastrophic cross-tenant leakage | **Mitigated by design** | `SOURCE_DEFS.tenantColumn` mandatory; boot validator; ESLint allowlist; per-source isolation tests. (SPIKE-004.) | Backend |
| **REP-2** | New `SOURCE_DEFS` entry shipped without `tenantColumn` | Medium | Leakage in one source | **Mitigated** | Boot validator crashes process on missing field. (SPIKE-004 R-1.) | Backend |
| **REP-3** | User-controlled `ORDER BY` field bypasses allowlist | Medium | SQL injection / leakage | **Mitigated** | Same field allowlist applies to `ORDER BY`. | Backend |
| **REP-4** | Export pipeline (Excel/PDF/DOCX) uses a separate SQL path | Medium | Leakage in exports | **Mitigated by design** | Exports route through the same engine. (SPIKE-004 R-4.) | Backend |
| **STO-1** | ACL flip before frontend cutover breaks existing assets | High in original plan | Mass UI breakage | **Mitigated** | Order corrected: rekey → frontend → ACL flip; metric-gated. (SPIKE-005 F-4.) | Frontend + DevOps |
| **STO-2** | Sensitive documents reachable by URL guess (current `public-read`) | Certain | PII disclosure | **Mitigated by design** | All objects private; signed URL only; tenant prefix; audit. (ADR-006.) | Backend |
| **STO-3** | Cross-tenant signed URL via client-controlled tenantId | Hypothetical | Cross-tenant leakage | **Mitigated** | Server resolves tenantId from ALS; client only sends opaque doc id. (SPIKE-005 F-1.) | Backend |
| **STO-4** | Long-lived signed URL leaked via screenshot/email | Medium | Time-bounded disclosure | **Mitigated** | TTL 5 min default; emails never embed signed URLs. (SPIKE-005 F-7.) | Frontend |
| **STO-5** | Browser caches expired signed URL → broken UI | Medium | UX bug | **Mitigated** | In-memory cache with `expiresAt - 30s` eviction; 403-aware refetch. (SPIKE-005 F-5.) | Frontend |
| **STO-6** | Emergency revocation requires bucket key rotation (invalidates all URLs) | Low | Operational pain | **Accepted** | Runbook documented; per-tenant DEK in Phase 4 narrows blast radius. | Ops |
| **JOB-1** | Producer forgets `tenantId` in job payload | Medium | Job runs without tenant | **Mitigated** | Typed `Job<{ tenantId: string; ... }>`; handler base class throws on missing. (SPIKE-006 R-1.) | Backend |
| **JOB-2** | Worker uses raw `prisma` instead of `tenantPrisma` | High in old code | Cross-tenant leakage | **Mitigated** | ESLint allowlist + `TenantAwareJobProcessor` requirement. (SPIKE-006 R-2.) | Backend |
| **JOB-3** | Retry storm overwhelms a tenant's DB | Medium | Hot-tenant outage | **Mitigated** | BullMQ `groupKey: 'tenantId'` rate limiter; exponential backoff. (SPIKE-006 R-3.) | Backend |
| **JOB-4** | Job payload references cross-tenant IDs | Medium | Confused-deputy leakage | **Mitigated** | At job entry, validate every id via `tenantPrisma` existence check. (SPIKE-006 R-5.) | Backend |
| **JOB-5** | DLQ inspection exposes mixed-tenant payloads | Low | PII exposure to support staff | **Mitigated** | DLQ UI under `/_platform` with audit; payloads displayed with redaction. (SPIKE-006 R-7.) | Backend |
| **JOB-6** | Legacy `setInterval` scheduler runs alongside new fanout | Medium | Duplicate notifications | **Mitigated** | Deterministic `jobId` per period; one-week parallel run. (SPIKE-006 cleanup.) | Backend |
| **OPS-1** | Tenant resolution cache stale after slug change | Low | Wrong-tenant routing | **Mitigated** | TTL 5 min; pub/sub invalidation. (ADR-004 §7.) | Backend |
| **OPS-2** | Slug collisions when deriving from agency name | Low | Migration blocker per agency | **Mitigated** | kebab-case + collision suffix; reserved-slug list. (ADR-004 §8.) | Product + Backend |
| **OPS-3** | PII redaction in shared logs not yet implemented | Certain | Cross-tenant log smell | **Accepted (Phase 5)** | Pino redaction layer; field deny-list; not blocking SaaS launch. | Ops |
| **OPS-4** | JWT key rotation locks out users mid-flight | Medium | Mass logout | **Mitigated** | JWKS exposes both keys ≥ 30 days; verifier accepts both. (ADR-002 §13.) | Backend |
| **OPS-5** | Custom-domain TLS provisioning lag | Medium | Onboarding delay | **Mitigated** | Maintenance page during issuance; DNS verification UI. (Phase 4.) | DevOps |

## Summary by Tier

- **Mitigated (validated by spike or codified in ADR):** 30
- **Mitigated by design (architectural; needs implementation):** 6
- **Accepted (residual risk with operational controls):** 4
- **Refuted (hypothesis was wrong):** 3
- **Watch (re-evaluate later):** 1

## Top 5 Residual Risks Going into Phase 1

1. **OPS-3 — PII in logs.** Acceptable for Phase 0–3; must ship before commercial GA.
2. **MIG-7 — No automatic rollback days post-migration.** Mitigated only by mandatory snapshot + staging dry-run.
3. **STO-6 — Emergency revocation = bucket-key rotation.** Operational; per-tenant DEK shrinks blast radius later.
4. **DB-5 — Long-running workers hold backend connections.** Architecturally segregated (separate pool); operational guardrails needed.
5. **OPS-5 — Custom-domain TLS lag.** Phase 4 onboarding UX; not blocking.
