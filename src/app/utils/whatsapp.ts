/**
 * WhatsApp linking helpers.
 * Produces a `https://wa.me/<digits>` URL that opens WhatsApp Web on
 * desktop and the native app on mobile. All numbers are collapsed to
 * digits only — wa.me does not accept `+`, spaces or dashes.
 *
 * Country-code handling:
 *   - If the phone already starts with `+`, its digits are kept.
 *   - Numbers written with `00` international prefix (e.g. 0049..) are
 *     rewritten to drop the leading `00`.
 *   - Pure-local numbers (single leading `0`, no country code, no `+`)
 *     get the optional `defaultCountryCode` prepended if provided.
 *   - Anything else is used as-is.
 *
 * Validation:
 *   - Returns null for anything with fewer than 7 or more than 15
 *     digits, which is the E.164 range.
 */

/** Strip everything except digits. */
function digitsOnly(v: string): string {
  return (v || '').replace(/\D+/g, '');
}

/** Normalise a raw phone string into a digits-only WhatsApp number, or null. */
export function normalizeWhatsAppNumber(
  rawPhone: string | null | undefined,
  defaultCountryCode?: string | null,
): string | null {
  if (!rawPhone) return null;
  const trimmed = String(rawPhone).trim();
  if (!trimmed) return null;

  let digits: string;
  if (trimmed.startsWith('+')) {
    digits = digitsOnly(trimmed);
  } else if (trimmed.startsWith('00')) {
    digits = digitsOnly(trimmed).replace(/^00/, '');
  } else {
    const local = digitsOnly(trimmed);
    const cc = digitsOnly(defaultCountryCode ?? '');
    if (cc && local.startsWith('0')) {
      digits = cc + local.replace(/^0+/, '');
    } else if (cc && local.length <= 10) {
      // Short local-looking number with no country code → prepend default.
      digits = cc + local;
    } else {
      digits = local;
    }
  }

  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** Build a wa.me URL. Returns null if the phone cannot be normalised. */
export function buildWhatsAppUrl(
  rawPhone: string | null | undefined,
  opts?: { defaultCountryCode?: string | null; message?: string },
): string | null {
  const digits = normalizeWhatsAppNumber(rawPhone, opts?.defaultCountryCode ?? null);
  if (!digits) return null;
  const base = `https://wa.me/${digits}`;
  const msg = (opts?.message ?? '').trim();
  return msg ? `${base}?text=${encodeURIComponent(msg)}` : base;
}

/** True if the phone can be sent to WhatsApp. Cheap check for UI gating. */
export function hasWhatsAppNumber(
  rawPhone: string | null | undefined,
  defaultCountryCode?: string | null,
): boolean {
  return normalizeWhatsAppNumber(rawPhone, defaultCountryCode) !== null;
}
