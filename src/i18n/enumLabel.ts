import i18n from './index';

/**
 * Translate a stable backend enum/status code into the user-facing label for
 * the current language. The codes themselves are never translated and remain
 * stable — only the display label is localized. Falls back to the raw code if
 * no translation is registered.
 *
 * @example
 *   enumLabel('documentStatus', 'PENDING') // → "Pending Review" in en, "بانتظار المراجعة" in ar
 */
export function enumLabel(group: string, code: string | null | undefined): string {
  if (!code) return '';
  return i18n.t(`${group}.${code}`, {
    ns: 'enums',
    defaultValue: code,
  });
}
