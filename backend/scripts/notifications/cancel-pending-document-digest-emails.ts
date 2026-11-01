/**
 * One-time outbox cleanup — Document-digest cutover.
 *
 * Before the daily DocumentDigestCron shipped, every
 * DOCUMENT_EXPIRING_SOON / DOCUMENT_EXPIRED / DOCUMENT_REJECTED row
 * enqueued an individual email through `notification_email_outbox`.
 * The email worker drains rows on its 60s tick — so even though the
 * new `digestOnly: true` flag stops *future* per-row enqueues, any
 * legacy PENDING rows would still be dispatched on the next worker
 * pass.
 *
 * This script:
 *   1. Audits every row in `notification_email_outbox` whose
 *      `eventType` matches a digest-only document event AND whose
 *      `status` would otherwise be dispatched ('PENDING' or
 *      'SENDING'). Prints a per-event-type tally.
 *   2. In CANCEL mode (`--apply`), flips each matching row to
 *      `status = 'SKIPPED_DIGEST'` and stamps `lastError` with a
 *      human-readable cutover note. Preserves every other row
 *      verbatim — no DELETE, no touching of non-document rows, no
 *      effect on the `notifications` (in-app) table.
 *   3. Prints a post-state report: rows cancelled per event type,
 *      confirms non-document outbox rows untouched, confirms the
 *      in-app `notifications` table was not modified.
 *
 * Default mode is DRY-RUN — pass `--apply` to actually perform the
 * UPDATE. Both modes print the full audit so an operator can
 * eyeball the impact before flipping the switch.
 *
 * Run:
 *   npx ts-node backend/scripts/notifications/cancel-pending-document-digest-emails.ts
 *   npx ts-node backend/scripts/notifications/cancel-pending-document-digest-emails.ts --apply
 *
 * DATABASE_URL is read from the environment (or `--db=…`).
 *
 * Safety:
 *   - Idempotent: re-running after `--apply` finds zero candidates.
 *   - Tenant-agnostic: a digest-only row in any tenant is suppressed.
 *     The downstream DocumentDigestCron re-delivers the underlying
 *     in-app row via the daily summary, so no information is lost.
 *   - Auditable: every cancelled row keeps its original
 *     (userId, email, eventType, title, message, params, createdAt)
 *     intact and gains a `lastError` describing the cutover.
 *
 * Status codes:
 *   0 — success (dry-run or apply)
 *   2 — argument / DB error
 */
/* eslint-disable no-console */
import { Client } from 'pg';
import { NOTIF_EVENT_META } from '../../src/notifications/notification-events';

interface Tally { eventType: string; count: number }

const SCRIPT = 'cancel-pending-document-digest-emails';

function resolveDatabaseUrl(): string {
  const arg = process.argv.find(a => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(`[${SCRIPT}] DATABASE_URL is not set. Pass --db=postgres://… or export DATABASE_URL.`);
    process.exit(2);
  }
  return url;
}

/** Pull every `digestOnly` event from the registry so the script
 *  stays in sync with future additions (e.g. a DOCUMENT_MISSING). */
function digestOnlyEventKeys(): string[] {
  return NOTIF_EVENT_META.filter(m => m.digestOnly).map(m => m.key);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = resolveDatabaseUrl();
  const digestKeys = digestOnlyEventKeys();

  console.log(`[${SCRIPT}] mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[${SCRIPT}] digest-only event keys (from registry): ${digestKeys.join(', ') || '(none)'}`);
  if (digestKeys.length === 0) {
    console.log(`[${SCRIPT}] no digest-only events registered; nothing to do.`);
    process.exit(0);
  }

  const client = new Client({
    connectionString: url,
    ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    // ── 1. Audit pre-state ──────────────────────────────────────────────
    const candidatesQ = await client.query<Tally>(
      `SELECT "eventType", COUNT(*)::int AS count
         FROM "notification_email_outbox"
        WHERE "status" IN ('PENDING', 'SENDING')
          AND "eventType" = ANY($1::text[])
        GROUP BY "eventType"
        ORDER BY "eventType"`,
      [digestKeys],
    );
    const totals = candidatesQ.rows;
    const totalRows = totals.reduce((s, r) => s + Number(r.count), 0);

    console.log(`\n[${SCRIPT}] BEFORE — pending/sending document outbox rows: ${totalRows}`);
    if (totals.length === 0) {
      console.log(`  (none — outbox is already clean)`);
    } else {
      for (const t of totals) {
        console.log(`  ${t.eventType.padEnd(30)} ${t.count}`);
      }
    }

    // ── 2. Sanity snapshot — non-document rows MUST NOT change ──────────
    const nonDocBefore = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM "notification_email_outbox"
        WHERE "eventType" <> ALL($1::text[])`,
      [digestKeys],
    );
    const notifBefore = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "notifications"`,
    );

    // ── 3. Apply (optional) ─────────────────────────────────────────────
    let cancelled = 0;
    if (apply && totalRows > 0) {
      const res = await client.query(
        `UPDATE "notification_email_outbox"
            SET "status"    = 'SKIPPED_DIGEST',
                "lastError" = 'document-digest cutover: per-row email suppressed; row will appear in the daily document digest if the underlying in-app notification is still un-digested'
          WHERE "status" IN ('PENDING', 'SENDING')
            AND "eventType" = ANY($1::text[])`,
        [digestKeys],
      );
      cancelled = res.rowCount ?? 0;
      console.log(`\n[${SCRIPT}] APPLIED — cancelled ${cancelled} row(s).`);
    } else if (!apply) {
      console.log(`\n[${SCRIPT}] DRY-RUN — pass --apply to perform the UPDATE.`);
    }

    // ── 4. Verify post-state ────────────────────────────────────────────
    const afterDocPending = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM "notification_email_outbox"
        WHERE "status" IN ('PENDING', 'SENDING')
          AND "eventType" = ANY($1::text[])`,
      [digestKeys],
    );
    const nonDocAfter = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM "notification_email_outbox"
        WHERE "eventType" <> ALL($1::text[])`,
      [digestKeys],
    );
    const notifAfter = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "notifications"`,
    );

    console.log(`\n[${SCRIPT}] REPORT`);
    console.log(`  pending/sending document rows BEFORE : ${totalRows}`);
    console.log(`  pending/sending document rows AFTER  : ${afterDocPending.rows[0].count}`);
    console.log(`  rows cancelled this run              : ${cancelled}`);
    console.log(`  affected event types                 : ${totals.map(t => t.eventType).join(', ') || '(none)'}`);
    console.log(`  non-document outbox rows BEFORE      : ${nonDocBefore.rows[0].count}`);
    console.log(`  non-document outbox rows AFTER       : ${nonDocAfter.rows[0].count}`);
    console.log(`  non-document rows UNCHANGED          : ${nonDocBefore.rows[0].count === nonDocAfter.rows[0].count ? 'YES' : 'NO — INVESTIGATE'}`);
    console.log(`  in-app notifications BEFORE          : ${notifBefore.rows[0].count}`);
    console.log(`  in-app notifications AFTER           : ${notifAfter.rows[0].count}`);
    console.log(`  in-app notifications UNCHANGED       : ${notifBefore.rows[0].count === notifAfter.rows[0].count ? 'YES' : 'NO — INVESTIGATE'}`);

    if (apply && afterDocPending.rows[0].count !== 0) {
      console.error(`\n[${SCRIPT}] WARNING — pending document rows remain after APPLY. Re-run or investigate.`);
      process.exit(2);
    }

    process.exit(0);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch(e => {
  console.error(`[${SCRIPT}] failed:`, e);
  process.exit(2);
});
