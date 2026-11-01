/**
 * Storage abstraction (ADR-006).
 *
 * Phase 0 ships only the interfaces. Implementations are wired in Phase 3
 * once `SIGNED_URLS_ENABLED` is on.
 */

export type StorageVisibility = 'PRIVATE' | 'TENANT_PUBLIC';

export interface SignedUrlRequest {
  /** Opaque DB id (e.g. Document.id). The server resolves the storage key. */
  resourceId: string;
  /** Resource class — informs key prefix derivation. */
  resourceClass:
    | 'document'
    | 'avatar'
    | 'logo'
    | 'employee-photo'
    | 'applicant-photo'
    | 'vehicle-doc'
    | 'finance-attachment'
    | 'work-history-attachment'
    | 'job-ad-asset'
    | 'application-upload';
  /** TTL seconds. Capped server-side. */
  ttlSec?: number;
  /** Operation: 'GET' for download, 'PUT' for upload presign. */
  op?: 'GET' | 'PUT';
}

export interface SignedUrl {
  url: string;
  expiresAt: number; // unix epoch ms
  /** The opaque storage key (server-derived; not secret but not user-controllable). */
  storageKey: string;
}

/** TTL caps per resource class (seconds). Storage-plan §5. */
export const TTL_CAPS: Record<SignedUrlRequest['resourceClass'], number> = {
  document:                300,
  avatar:                  3600,
  logo:                    3600,
  'employee-photo':        3600,
  'applicant-photo':       3600,
  'vehicle-doc':           300,
  'finance-attachment':    300,
  'work-history-attachment': 300,
  'job-ad-asset':          3600,
  'application-upload':    300,
};

/** MIME allow-lists per resource class. */
export const MIME_ALLOWLIST: Record<SignedUrlRequest['resourceClass'], readonly string[]> = {
  document: [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  avatar:                  ['image/png', 'image/jpeg', 'image/webp'],
  logo:                    ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
  'employee-photo':        ['image/png', 'image/jpeg', 'image/webp'],
  'applicant-photo':       ['image/png', 'image/jpeg', 'image/webp'],
  'vehicle-doc':           ['application/pdf', 'image/png', 'image/jpeg'],
  'finance-attachment':    ['application/pdf', 'image/png', 'image/jpeg'],
  'work-history-attachment': ['application/pdf', 'image/png', 'image/jpeg'],
  'job-ad-asset':          ['image/png', 'image/jpeg', 'image/webp'],
  'application-upload':    ['application/pdf', 'image/png', 'image/jpeg'],
};

/** Size caps per resource class (bytes). */
export const SIZE_CAPS: Record<SignedUrlRequest['resourceClass'], number> = {
  document:                25 * 1024 * 1024,
  avatar:                   5 * 1024 * 1024,
  logo:                     2 * 1024 * 1024,
  'employee-photo':         5 * 1024 * 1024,
  'applicant-photo':        5 * 1024 * 1024,
  'vehicle-doc':           25 * 1024 * 1024,
  'finance-attachment':    25 * 1024 * 1024,
  'work-history-attachment': 25 * 1024 * 1024,
  'job-ad-asset':           5 * 1024 * 1024,
  'application-upload':    10 * 1024 * 1024,
};
