import { BadRequestException } from '@nestjs/common';

/**
 * Centralized per-document-type metadata requirements.
 *
 * Some document types are only meaningful with certain metadata — a
 * Passport without an expiry date can't drive compliance, a Visa/Work
 * Permit without an expiry date can't expire. This is the single source
 * of truth for "which metadata fields are mandatory for which type",
 * shared by every create/update path so the rules can't drift between
 * the upload form, the edit form, and the API.
 *
 * The frontend mirror lives at src/app/utils/documentMetadataRules.ts —
 * keep the two in sync.
 *
 * Identification: seeded DocumentTypes carry no `code`, so matching is
 * primarily by `name` (case-insensitive), with `code` honoured when a
 * tenant later assigns one. Unknown types have no forced metadata.
 */

export type DocumentMetadataField = 'issueDate' | 'expiryDate' | 'documentNumber';

export type CanonicalDocumentType = 'PASSPORT' | 'VISA' | 'WORK_PERMIT';

export const DOCUMENT_TYPE_METADATA_REQUIREMENTS: Record<CanonicalDocumentType, DocumentMetadataField[]> = {
  // Passport must carry both dates to be a usable identity/compliance doc.
  // documentNumber is intentionally NOT forced here — there is no existing
  // business rule mandating it, and the task scopes it as "if applicable".
  PASSPORT: ['issueDate', 'expiryDate'],
  // Visa / Work Permit are time-bounded authorisations: expiry is required
  // so the compliance engine can flag them as expiring/expired.
  VISA: ['expiryDate'],
  WORK_PERMIT: ['expiryDate'],
};

const FIELD_ERROR: Record<DocumentMetadataField, { code: string; message: (docType: string) => string }> = {
  issueDate: {
    code: 'VALIDATION.ISSUE_DATE_REQUIRED',
    message: (d) => `Issue date is required for ${d} documents.`,
  },
  expiryDate: {
    code: 'VALIDATION.EXPIRY_DATE_REQUIRED',
    message: (d) => `Expiry date is required for ${d} documents.`,
  },
  documentNumber: {
    code: 'VALIDATION.DOCUMENT_NUMBER_REQUIRED',
    message: (d) => `Document number is required for ${d} documents.`,
  },
};

/**
 * Resolve a DocumentType ({ code?, name? }) to its canonical key, or null
 * when the type has no special metadata requirements.
 */
export function resolveCanonicalDocumentType(
  type: { code?: string | null; name?: string | null } | null | undefined,
): CanonicalDocumentType | null {
  const code = (type?.code ?? '').trim().toUpperCase();
  const name = (type?.name ?? '').trim().toLowerCase();
  if (code === 'PASS' || code === 'PASSPORT' || /passport/.test(name)) return 'PASSPORT';
  if (code === 'WP' || code === 'WORK_PERMIT' || code === 'WORKPERMIT' || /work\s*permit/.test(name)) return 'WORK_PERMIT';
  if (code === 'VISA' || /\bvisa\b/.test(name)) return 'VISA';
  return null;
}

/**
 * Required metadata fields for a document type. Empty array when the type
 * has no forced metadata.
 */
export function getRequiredDocumentMetadataFields(
  type: { code?: string | null; name?: string | null } | null | undefined,
): DocumentMetadataField[] {
  const key = resolveCanonicalDocumentType(type);
  return key ? DOCUMENT_TYPE_METADATA_REQUIREMENTS[key] : [];
}

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export interface DocumentFieldError {
  field: DocumentMetadataField;
  code: string;
  message: string;
  params: { docType: string };
}

/**
 * Validate a document's metadata against its type's requirements.
 * Returns a (possibly empty) list of field errors — never throws.
 */
export function validateDocumentMetadata(
  type: { code?: string | null; name?: string | null } | null | undefined,
  metadata: { issueDate?: unknown; expiryDate?: unknown; documentNumber?: unknown },
): DocumentFieldError[] {
  const required = getRequiredDocumentMetadataFields(type);
  if (required.length === 0) return [];
  const docTypeName = (type?.name ?? 'this').trim() || 'this';
  const errors: DocumentFieldError[] = [];
  for (const field of required) {
    if (isBlank((metadata as any)[field])) {
      errors.push({
        field,
        code: FIELD_ERROR[field].code,
        message: FIELD_ERROR[field].message(docTypeName),
        params: { docType: docTypeName },
      });
    }
  }
  return errors;
}

/**
 * Throw a `VALIDATION.FAILED` envelope (the shape the frontend's
 * useValidationErrors/apiError understands) when required metadata is
 * missing. No-op when the metadata satisfies the type's rules.
 */
export function assertDocumentMetadata(
  type: { code?: string | null; name?: string | null } | null | undefined,
  metadata: { issueDate?: unknown; expiryDate?: unknown; documentNumber?: unknown },
): void {
  const fields = validateDocumentMetadata(type, metadata);
  if (fields.length === 0) return;
  throw new BadRequestException({
    code: 'VALIDATION.FAILED',
    message: fields.length === 1 ? fields[0].message : fields.map((f) => f.message).join('; '),
    fields,
  });
}
