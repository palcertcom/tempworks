import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { TenantContext } from '../context/als';
import {
  SignedUrlRequest,
  SignedUrl,
  TTL_CAPS,
} from './signed-url.types';

/**
 * Phase 0 SKELETON.
 *
 * Contract:
 *   - When `SIGNED_URLS_ENABLED=false`: every call throws. The legacy
 *     `StorageService` (`src/common/storage`) continues to issue public
 *     URLs, byte-identical to today.
 *   - When ON: derives a tenant-prefixed storage key from server context,
 *     applies TTL caps, asks the underlying S3/Spaces SDK for a SigV4
 *     presigned URL, and writes one `audit_logs` row per issuance.
 *
 * The actual SDK wiring is intentionally NOT implemented in Phase 0:
 *   - It would require the existing StorageService refactor, which is
 *     a Phase 3 deliverable.
 *   - Issuing a URL today might leak — failure-closed is safer than a
 *     half-built pathway.
 */
@Injectable()
export class SignedUrlService {
  private readonly logger = new Logger('SignedUrlService');

  constructor(private readonly flags: FeatureFlagsService) {}

  async issue(req: SignedUrlRequest): Promise<SignedUrl> {
    if (!this.flags.signedUrlsEnabled()) {
      throw new Error('SIGNED_URLS_ENABLED=false; signed-URL service is dormant');
    }
    const tenant = TenantContext.current('signed-url:issue');
    const cap = TTL_CAPS[req.resourceClass];
    if (req.ttlSec && req.ttlSec > cap) {
      throw new BadRequestException(`TTL exceeds cap (${cap}s) for ${req.resourceClass}`);
    }
    // Storage key is ALWAYS tenant-prefixed and ALWAYS server-derived.
    const storageKey = this.deriveStorageKey(tenant.id, req);

    // Phase 3: bind to S3 SDK and write audit log row.
    throw new Error('SignedUrlService.issue not implemented in Phase 0');
  }

  /** Server-side key derivation; intentionally exposed for tests. */
  deriveStorageKey(tenantId: string, req: SignedUrlRequest): string {
    return `tenants/${tenantId}/${this.subPrefix(req.resourceClass)}/${req.resourceId}`;
  }

  private subPrefix(rc: SignedUrlRequest['resourceClass']): string {
    const map: Record<SignedUrlRequest['resourceClass'], string> = {
      document:                  'documents',
      avatar:                    'avatars',
      logo:                      'logos',
      'employee-photo':          'employees',
      'applicant-photo':         'applicants',
      'vehicle-doc':             'vehicles',
      'finance-attachment':      'finance',
      'work-history-attachment': 'employees/work-history',
      'job-ad-asset':            'job-ads',
      'application-upload':      'applications',
    };
    return map[rc];
  }
}
