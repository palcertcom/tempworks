// Phase 0 / 1 — pre-existing barrel for the BullMQ-style job processor.
export { TenantAwareJobProcessor } from './tenant-aware-job.processor';
export { TenantAwareJobPayload, WithJob } from './payload';

/**
 * Phase 2.13 — tenant-aware job context framework. INFRASTRUCTURE
 * ONLY. No existing scheduler is wired to this module yet. Importing
 * these symbols does NOT change runtime behaviour unless the caller
 * explicitly invokes `runForTenant`/`runForTenantBatch` with the
 * appropriate flag profile.
 */
export {
  type IdempotencyKey,
  type TenantJobActor,
  type TenantJobRetryMeta,
  type TenantJobPayload,
  TenantJobPayloadError,
  assertTenantJobPayload,
  makeIdempotencyKey,
  buildTenantJobPayload,
  buildRetryPayload,
} from './tenant-job.payload';

export {
  type RunForTenantOptions,
  type JobResult,
  type BatchOptions,
  type BatchOutcome,
  MissingSafeEnvError,
  InvalidTenantIdError,
  runForTenant,
  runForTenantBatch,
  currentJobTenantId,
  requireJobTenantId,
  inJobContext,
} from './tenant-job-context';

export {
  type CandidateTenant,
  type FanoutOptions,
  type PlannedExecution,
  type SkippedTenant,
  type ExecutionPlan,
  TenantJobFanoutPlanner,
} from './tenant-job-fanout-planner';
