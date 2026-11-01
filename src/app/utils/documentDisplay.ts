/**
 * getDocumentDisplayName — turn an onboarding upload-instruction label
 * into a clean, user-facing document name.
 *
 * Required-document slots in the applicant onboarding form are labelled
 * with localized strings like:
 *   en "Upload Passport (Required)"        sk "Nahrať cestovný pas (povinné)"
 *   de "Reisepass hochladen (erforderlich)" ar "رفع جواز السفر (مطلوب)"
 *   ru "Загрузить паспорт (обязательно)"    tr "Pasaportu Yükle (Zorunlu)"
 * When the uploaded file is materialised into a Document row, that label
 * becomes the document `name`. This strips the upload verb and the
 * trailing "(required)" marker across all six supported locales so the
 * list/detail/cards show "Passport", "Certificate / Diploma", etc.
 *
 * Display-only — it never mutates stored data, and it leaves normal
 * names (e.g. "John's passport scan", "Contract (Renewal)") untouched
 * because it only removes a parenthetical whose content is a known
 * "required" word, and only strips a leading/trailing upload verb.
 */

// "required" markers, one per supported locale (lower-cased).
const REQUIRED_WORDS = ['required', 'povinné', 'povinne', 'erforderlich', 'مطلوب', 'обязательно', 'zorunlu'];

// Upload-verb tokens. Most locales put the verb first; German puts it
// last ("… hochladen"), so we strip from both ends.
const UPLOAD_LEADING = ['upload', 'nahrať', 'nahrajte', 'nahrat', 'رفع', 'تحميل', 'загрузить', 'загрузка', 'yükle', 'yükleyin', 'yükleme'];
// Some languages put the upload verb after the noun (German "… hochladen",
// Turkish "Pasaportu Yükle"), so strip these from the end too.
const UPLOAD_TRAILING = ['hochladen', 'yükle', 'yükleyin', 'yükleme'];

function stripRequiredParenthetical(s: string): string {
  // Remove a trailing "(…)" only when its inner text is a required marker.
  return s.replace(/\s*\(([^)]*)\)\s*$/u, (full, inner) => {
    const norm = String(inner).trim().toLowerCase();
    return REQUIRED_WORDS.some((w) => norm === w || norm.includes(w)) ? '' : full;
  });
}

function stripUploadVerb(s: string): string {
  let out = s.trim();
  for (const v of UPLOAD_LEADING) {
    const re = new RegExp(`^${v}\\s+`, 'iu');
    if (re.test(out)) { out = out.replace(re, '').trim(); break; }
  }
  for (const v of UPLOAD_TRAILING) {
    const re = new RegExp(`\\s+${v}$`, 'iu');
    if (re.test(out)) { out = out.replace(re, '').trim(); break; }
  }
  return out;
}

export function getDocumentDisplayName(
  name: string | null | undefined,
  fallback?: string | null,
): string {
  const raw = (name ?? '').trim();
  if (!raw) return (fallback ?? '').trim();
  let out = stripRequiredParenthetical(raw);
  out = stripUploadVerb(out);
  out = out.replace(/\s{2,}/g, ' ').trim();
  // If cleanup emptied the string (e.g. label was only verb + marker),
  // fall back to the canonical type name or the original.
  return out || (fallback ?? '').trim() || raw;
}
