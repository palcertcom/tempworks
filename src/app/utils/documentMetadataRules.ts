/**
 * Per-document-type required metadata — frontend mirror of
 * backend/src/documents/document-metadata-rules.ts. Keep the two in sync.
 *
 * Used by the Upload and Edit forms to mark required fields (issue/expiry
 * date) and block submit before hitting the API. The backend re-validates,
 * so this is UX only — never the sole enforcement.
 */

export type DocumentMetadataField = 'issueDate' | 'expiryDate' | 'documentNumber';
export type CanonicalDocumentType = 'PASSPORT' | 'VISA' | 'WORK_PERMIT';

export const DOCUMENT_TYPE_METADATA_REQUIREMENTS: Record<CanonicalDocumentType, DocumentMetadataField[]> = {
  PASSPORT: ['issueDate', 'expiryDate'],
  VISA: ['expiryDate'],
  WORK_PERMIT: ['expiryDate'],
};

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

export function getRequiredDocumentMetadataFields(
  type: { code?: string | null; name?: string | null } | null | undefined,
): DocumentMetadataField[] {
  const key = resolveCanonicalDocumentType(type);
  return key ? DOCUMENT_TYPE_METADATA_REQUIREMENTS[key] : [];
}

export function isDocumentFieldRequired(
  type: { code?: string | null; name?: string | null } | null | undefined,
  field: DocumentMetadataField,
): boolean {
  return getRequiredDocumentMetadataFields(type).includes(field);
}
