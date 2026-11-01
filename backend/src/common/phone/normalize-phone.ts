/**
 * Phone normalization — canonical E.164 (`+<digits>`), server-side.
 *
 * The frontend may send a clean `+90 5394308925`, a duplicated
 * `+90 +905394308925`, an already-E.164 `+905394308925`, or a `00`-
 * prefixed international number. This collapses all of them to a single
 * `+<digits>` value so the database has one source of truth and the
 * country code never appears twice.
 *
 * No external dependency (libphonenumber is not installed). The dedupe
 * rule: when more than one `+` is present, the trailing segment is a
 * complete international number — prefer it; otherwise treat the head as
 * the dial code and strip the stray inner `+`.
 *
 * Conservative by design: returns the input untouched for null/empty,
 * and never throws. It does not reject numbers (the DTO's @IsString
 * still applies) — its job is to clean, not validate length per country.
 */
export function normalizePhoneE164(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return raw as any;
  let s = String(raw).trim();
  if (!s) return s;
  // International access prefix 00 → +
  s = s.replace(/^00/, '+');
  // Keep only digits and '+'
  s = s.replace(/[^\d+]/g, '');
  if (!s) return '';
  // Collapse duplicated leading dial code(s).
  let guard = 0;
  let idx = s.indexOf('+', 1);
  while (idx !== -1 && guard++ < 5) {
    const tail = s.slice(idx);
    const tailDigits = tail.replace(/\D/g, '');
    if (tail.startsWith('+') && tailDigits.length >= 8) {
      // The trailing segment is itself a full international number.
      s = tail;
    } else {
      s = s.slice(0, idx) + tail.replace(/\+/g, '');
    }
    idx = s.indexOf('+', 1);
  }
  return s;
}

/** class-transformer helper: `@Transform(normalizePhoneTransform)`. */
export function normalizePhoneTransform({ value }: { value: any }): any {
  return typeof value === 'string' ? normalizePhoneE164(value) : value;
}
