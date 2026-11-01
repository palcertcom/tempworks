/**
 * Notification event registry.
 *
 * Single source of truth for every notifiable event in the platform.
 * Each entry carries:
 *   - the Prisma NotificationType used for the bell-icon visual treatment,
 *   - the module category surfaced in the preferences matrix,
 *   - the permission a recipient must hold to ever receive the event
 *     (gates the fanout helpers — see notifications.service),
 *   - default channel toggles seeded into a brand-new user's prefs,
 *   - i18n keys for the bell-icon title / body strings (callers may
 *     still pass plain title/message for callers that haven't moved to
 *     keyed strings yet).
 *
 * Adding an event is purely additive: define it here, emit it from the
 * owning module, and the preferences matrix surfaces it automatically.
 */

// ── Event keys (string-literal type derived below) ──────────────────────────

export const NOTIF_EVENTS = {
  // Documents & Compliance
  DOCUMENT_UPLOADED:       'DOCUMENT_UPLOADED',
  DOCUMENT_EXPIRING_SOON:  'DOCUMENT_EXPIRING_SOON',
  DOCUMENT_EXPIRED:        'DOCUMENT_EXPIRED',
  DOCUMENT_APPROVED:       'DOCUMENT_APPROVED',
  DOCUMENT_REJECTED:       'DOCUMENT_REJECTED',
  DOCUMENT_RENEWED:        'DOCUMENT_RENEWED',

  // Financial
  FINANCIAL_RECORD_CREATED:   'FINANCIAL_RECORD_CREATED',
  FINANCIAL_RECORD_UPDATED:   'FINANCIAL_RECORD_UPDATED',
  FINANCIAL_RECORD_DELETED:   'FINANCIAL_RECORD_DELETED',
  FINANCIAL_RECORD_DEDUCTED:  'FINANCIAL_RECORD_DEDUCTED',
  FINANCIAL_DEDUCTION_PROCESSED: 'FINANCIAL_DEDUCTION_PROCESSED',
  FINANCIAL_HIGH_BALANCE:     'FINANCIAL_HIGH_BALANCE',

  // Applicants (Leads & Candidates)
  APPLICANT_NEW_LEAD:           'APPLICANT_NEW_LEAD',
  APPLICANT_AGENCY_PENDING:     'APPLICANT_AGENCY_PENDING',
  APPLICANT_APPROVAL_DECISION:  'APPLICANT_APPROVAL_DECISION',
  APPLICANT_LEAD_CONVERTED:     'APPLICANT_LEAD_CONVERTED',
  APPLICANT_ASSIGNED_TO_ME:     'APPLICANT_ASSIGNED_TO_ME',
  APPLICANT_PROFILE_COMPLETED:  'APPLICANT_PROFILE_COMPLETED',

  // Employees
  EMPLOYEE_ONBOARDED:        'EMPLOYEE_ONBOARDED',
  EMPLOYEE_CONTRACT_EXPIRING:'EMPLOYEE_CONTRACT_EXPIRING',
  EMPLOYEE_CONTRACT_ENDED:   'EMPLOYEE_CONTRACT_ENDED',
  EMPLOYEE_CONTRACT_RENEWED: 'EMPLOYEE_CONTRACT_RENEWED',
  EMPLOYEE_STATUS_CHANGED:   'EMPLOYEE_STATUS_CHANGED',
  EMPLOYEE_PROFILE_LOCKED:   'EMPLOYEE_PROFILE_LOCKED',
  EMPLOYEE_BIRTHDAY_REMINDER:'EMPLOYEE_BIRTHDAY_REMINDER',

  // Workflow Pipeline
  PIPELINE_STAGE_ENTERED:    'PIPELINE_STAGE_ENTERED',
  PIPELINE_AWAITING_APPROVAL:'PIPELINE_AWAITING_APPROVAL',
  PIPELINE_STAGE_ADVANCED:   'PIPELINE_STAGE_ADVANCED',
  PIPELINE_STAGE_REJECTED:   'PIPELINE_STAGE_REJECTED',
  PIPELINE_DEADLINE_NEAR:    'PIPELINE_DEADLINE_NEAR',
  PIPELINE_FLAGGED:          'PIPELINE_FLAGGED',
  PIPELINE_ACCESS_CHANGED:   'PIPELINE_ACCESS_CHANGED',

  // System & Administration
  SYSTEM_MAINTENANCE:        'SYSTEM_MAINTENANCE',
  SYSTEM_BULK_JOB_RESULT:    'SYSTEM_BULK_JOB_RESULT',
  SYSTEM_AUDIT_ALERT:        'SYSTEM_AUDIT_ALERT',
  SYSTEM_VERSION_UPDATED:    'SYSTEM_VERSION_UPDATED',
} as const;

export type NotifEventKey = typeof NOTIF_EVENTS[keyof typeof NOTIF_EVENTS];

// ── Categories used to group events in the preferences matrix ──────────────

export type NotifCategory =
  | 'Documents'
  | 'Financial'
  | 'Applicants'
  | 'Employees'
  | 'Pipeline'
  | 'System';

// ── Per-event metadata ──────────────────────────────────────────────────────

export interface NotifEventMeta {
  key:         NotifEventKey;
  /** Visual category on the bell-icon dropdown — re-uses the existing
   *  Prisma NotificationType enum so the badge styling is unchanged. */
  type:        'DOCUMENT_EXPIRY' | 'FINANCIAL' | 'WARNING' | 'INFO' | 'SYSTEM';
  category:    NotifCategory;
  /** English fallback used when the frontend hasn't loaded the i18n
   *  bundle yet (or for legacy callers that still pass plain strings). */
  label:       string;
  description: string;
  /** Permission the recipient must hold for the fanout to include them.
   *  null = no permission gate (e.g. SYSTEM_MAINTENANCE goes to all
   *  active users). Note: the gate is enforced server-side; a recipient
   *  who later loses the permission also loses future events of this
   *  kind without any client-side opt-out. */
  requiredPermission: string | null;
  /** Channel defaults seeded for a brand-new user. */
  defaultInApp: boolean;
  defaultEmail: boolean;
  /** SMS is reserved — every entry is false at launch (no provider). */
  /**
   * When true, per-row emission MUST NOT enqueue an individual email
   * (the in-app row still fires). The event is delivered via a daily
   * digest cron instead. Today this gates the document-compliance
   * events so the client gets one consolidated table per day rather
   * than dozens of emails across the 6h scan cycle.
   */
  digestOnly?: boolean;
}

/**
 * Catalogue ordered by category, then by spec order within the category.
 * The preferences UI renders this list directly.
 */
export const NOTIF_EVENT_META: NotifEventMeta[] = [
  // ── Documents & Compliance ───────────────────────────────────────────────
  { key: NOTIF_EVENTS.DOCUMENT_EXPIRING_SOON, type: 'DOCUMENT_EXPIRY', category: 'Documents',
    label: 'Document expiring soon',
    description: 'Tiered reminders 60/30/14/7 days before a tracked document expires.',
    requiredPermission: 'documents:read', defaultInApp: true, defaultEmail: true,
    digestOnly: true },
  { key: NOTIF_EVENTS.DOCUMENT_EXPIRED, type: 'DOCUMENT_EXPIRY', category: 'Documents',
    label: 'Document expired',
    description: 'A tracked document is past its expiry date.',
    requiredPermission: 'documents:read', defaultInApp: true, defaultEmail: true,
    digestOnly: true },
  { key: NOTIF_EVENTS.DOCUMENT_UPLOADED, type: 'DOCUMENT_EXPIRY', category: 'Documents',
    label: 'New document uploaded',
    description: 'A document is uploaded to any tracked profile.',
    requiredPermission: 'documents:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.DOCUMENT_APPROVED, type: 'DOCUMENT_EXPIRY', category: 'Documents',
    label: 'Document approved',
    description: 'A pending document has been approved.',
    requiredPermission: 'documents:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.DOCUMENT_REJECTED, type: 'WARNING', category: 'Documents',
    label: 'Document rejected',
    description: 'A pending document was rejected — includes the rejection reason.',
    requiredPermission: 'documents:read', defaultInApp: true, defaultEmail: true,
    digestOnly: true },
  { key: NOTIF_EVENTS.DOCUMENT_RENEWED, type: 'DOCUMENT_EXPIRY', category: 'Documents',
    label: 'Document renewed / replaced',
    description: 'A new revision was uploaded against an existing tracked document.',
    requiredPermission: 'documents:read', defaultInApp: true, defaultEmail: true },

  // ── Financial ────────────────────────────────────────────────────────────
  { key: NOTIF_EVENTS.FINANCIAL_RECORD_CREATED, type: 'FINANCIAL', category: 'Financial',
    label: 'New financial record',
    description: 'A new financial record is created for any tracked profile.',
    requiredPermission: 'finance:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.FINANCIAL_RECORD_UPDATED, type: 'FINANCIAL', category: 'Financial',
    label: 'Financial record edited',
    description: 'An existing financial record is modified.',
    requiredPermission: 'finance:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.FINANCIAL_RECORD_DELETED, type: 'FINANCIAL', category: 'Financial',
    label: 'Financial record deleted',
    description: 'A financial record is soft-deleted.',
    requiredPermission: 'finance:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.FINANCIAL_RECORD_DEDUCTED, type: 'FINANCIAL', category: 'Financial',
    label: 'Marked for deduction',
    description: 'A record is flagged for payroll deduction in the upcoming run.',
    requiredPermission: 'finance:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.FINANCIAL_DEDUCTION_PROCESSED, type: 'FINANCIAL', category: 'Financial',
    label: 'Deduction processed',
    description: 'Deduction is closed against the payroll reference.',
    requiredPermission: 'finance:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.FINANCIAL_HIGH_BALANCE, type: 'WARNING', category: 'Financial',
    label: 'High balance alert',
    description: 'A profile\'s outstanding balance crossed the configured threshold.',
    requiredPermission: 'finance:read', defaultInApp: true, defaultEmail: true },

  // ── Applicants ──────────────────────────────────────────────────────────
  { key: NOTIF_EVENTS.APPLICANT_NEW_LEAD, type: 'INFO', category: 'Applicants',
    label: 'New lead received',
    description: 'A new lead was submitted from the public-facing apply form.',
    requiredPermission: 'applicants:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.APPLICANT_AGENCY_PENDING, type: 'INFO', category: 'Applicants',
    label: 'New candidate pending approval',
    description: 'An agency submitted a candidate that awaits admin approval.',
    requiredPermission: 'applicants:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.APPLICANT_APPROVAL_DECISION, type: 'INFO', category: 'Applicants',
    label: 'Approval decision',
    description: 'An admin approved or declined a candidate you submitted.',
    requiredPermission: 'applicants:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.APPLICANT_LEAD_CONVERTED, type: 'INFO', category: 'Applicants',
    label: 'Lead converted',
    description: 'A lead was converted to a candidate.',
    requiredPermission: 'applicants:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.APPLICANT_ASSIGNED_TO_ME, type: 'INFO', category: 'Applicants',
    label: 'Candidate assigned to me',
    description: 'A candidate was assigned to you as the owning recruiter.',
    requiredPermission: 'applicants:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.APPLICANT_PROFILE_COMPLETED, type: 'INFO', category: 'Applicants',
    label: 'Candidate profile completed',
    description: 'A candidate completed their profile and is ready for screening.',
    requiredPermission: 'applicants:read', defaultInApp: true, defaultEmail: false },

  // ── Employees ───────────────────────────────────────────────────────────
  { key: NOTIF_EVENTS.EMPLOYEE_ONBOARDED, type: 'INFO', category: 'Employees',
    label: 'New employee onboarded',
    description: 'A candidate was converted to an employee.',
    requiredPermission: 'employees:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.EMPLOYEE_CONTRACT_EXPIRING, type: 'WARNING', category: 'Employees',
    label: 'Contract expiring soon',
    description: 'An active contract is approaching its end date.',
    requiredPermission: 'employees:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.EMPLOYEE_CONTRACT_ENDED, type: 'WARNING', category: 'Employees',
    label: 'Contract ended',
    description: 'An employee\'s contract reached its end date with no renewal recorded.',
    requiredPermission: 'employees:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.EMPLOYEE_CONTRACT_RENEWED, type: 'INFO', category: 'Employees',
    label: 'Contract renewed',
    description: 'A new contract was issued and the employee status is Active again.',
    requiredPermission: 'employees:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.EMPLOYEE_STATUS_CHANGED, type: 'INFO', category: 'Employees',
    label: 'Employee status changed',
    description: 'On Leave, Terminated, or other status transition.',
    requiredPermission: 'employees:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.EMPLOYEE_PROFILE_LOCKED, type: 'WARNING', category: 'Employees',
    label: 'Profile locked / unlocked',
    description: 'An admin locked or unlocked the employee\'s self-edit access.',
    requiredPermission: 'employees:read', defaultInApp: true, defaultEmail: false },
  { key: NOTIF_EVENTS.EMPLOYEE_BIRTHDAY_REMINDER, type: 'INFO', category: 'Employees',
    label: 'Birthday reminder',
    description: 'HR managers are notified one week before an employee\'s birthday.',
    requiredPermission: 'employees:read', defaultInApp: true, defaultEmail: false },

  // ── Workflow Pipeline ───────────────────────────────────────────────────
  { key: NOTIF_EVENTS.PIPELINE_STAGE_ENTERED, type: 'INFO', category: 'Pipeline',
    label: 'Candidate entered my stage',
    description: 'A candidate moved into a stage you are responsible for.',
    requiredPermission: 'workflow:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.PIPELINE_AWAITING_APPROVAL, type: 'WARNING', category: 'Pipeline',
    label: 'Candidate awaiting my approval',
    description: 'A candidate is waiting on your sign-off to advance.',
    requiredPermission: 'workflow:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.PIPELINE_STAGE_ADVANCED, type: 'INFO', category: 'Pipeline',
    label: 'Candidate advanced',
    description: 'A candidate was approved and advanced to the next stage.',
    requiredPermission: 'workflow:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.PIPELINE_STAGE_REJECTED, type: 'WARNING', category: 'Pipeline',
    label: 'Candidate rejected at a stage',
    description: 'A candidate was rejected at a stage — includes the reason.',
    requiredPermission: 'workflow:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.PIPELINE_DEADLINE_NEAR, type: 'WARNING', category: 'Pipeline',
    label: 'Stage deadline approaching',
    description: 'A configured stage deadline is approaching for a candidate.',
    requiredPermission: 'workflow:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.PIPELINE_FLAGGED, type: 'WARNING', category: 'Pipeline',
    label: 'Candidate flagged',
    description: 'A candidate was flagged for attention by a colleague.',
    requiredPermission: 'workflow:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.PIPELINE_ACCESS_CHANGED, type: 'INFO', category: 'Pipeline',
    label: 'Private workflow access changed',
    description: 'You were granted or revoked access on a private workflow.',
    requiredPermission: 'workflow:read', defaultInApp: true, defaultEmail: true },

  // ── System & Administration ─────────────────────────────────────────────
  { key: NOTIF_EVENTS.SYSTEM_MAINTENANCE, type: 'SYSTEM', category: 'System',
    label: 'System maintenance',
    description: 'Planned downtime or maintenance window announcements.',
    requiredPermission: null, defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.SYSTEM_BULK_JOB_RESULT, type: 'SYSTEM', category: 'System',
    label: 'Bulk job completed',
    description: 'A bulk import or export completed — successfully or with errors.',
    requiredPermission: null, defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.SYSTEM_AUDIT_ALERT, type: 'SYSTEM', category: 'System',
    label: 'Audit alert',
    description: 'An audit-defined critical action was performed.',
    requiredPermission: 'audit:read', defaultInApp: true, defaultEmail: true },
  { key: NOTIF_EVENTS.SYSTEM_VERSION_UPDATED, type: 'SYSTEM', category: 'System',
    label: 'New version available',
    description: 'The platform was upgraded — release notes / version delta sent to every active user.',
    requiredPermission: null, defaultInApp: true, defaultEmail: false },
];

/** Lookup: event key → meta. Throws on unknown key so a stray emitter
 *  surfaces as a fast error instead of a silently dropped notification. */
const META_BY_KEY: Record<NotifEventKey, NotifEventMeta> = NOTIF_EVENT_META.reduce(
  (acc, m) => { acc[m.key] = m; return acc; },
  {} as Record<NotifEventKey, NotifEventMeta>,
);

export function metaFor(key: NotifEventKey): NotifEventMeta {
  const m = META_BY_KEY[key];
  if (!m) throw new Error(`Unknown notification event key: ${key}`);
  return m;
}

// ── Convenience map used by the notifications service ──────────────────────

export const EVENT_TO_TYPE: Record<NotifEventKey, string> =
  NOTIF_EVENT_META.reduce((acc, m) => { acc[m.key] = m.type; return acc; },
    {} as Record<NotifEventKey, string>);

// ── Per-user channel preferences ───────────────────────────────────────────

export type ChannelPrefs = { in_app: boolean; email: boolean; sms: boolean };
export type UserNotifPrefs = Record<NotifEventKey, ChannelPrefs>;

export function getDefaultPrefs(): UserNotifPrefs {
  const prefs = {} as UserNotifPrefs;
  for (const meta of NOTIF_EVENT_META) {
    prefs[meta.key] = {
      in_app: meta.defaultInApp,
      email:  meta.defaultEmail,
      sms:    false, // Future feature; always disabled at launch.
    };
  }
  return prefs;
}

/**
 * Merge a saved partial preferences blob with defaults so newly-added
 * events have sensible values on first read. Unknown keys are dropped.
 * SMS is force-disabled regardless of the saved value until the SMS
 * provider is wired up — a defensive backstop against orphaned writes.
 */
export function mergeWithDefaults(saved: Partial<UserNotifPrefs> | null): UserNotifPrefs {
  const defaults = getDefaultPrefs();
  if (!saved) return defaults;
  const result = { ...defaults } as UserNotifPrefs;
  for (const key of Object.keys(saved) as NotifEventKey[]) {
    if (result[key] !== undefined && saved[key] !== undefined) {
      result[key] = { ...result[key], ...saved[key], sms: false };
    }
  }
  return result;
}
