import i18n from './index';
import type { Locale } from './config';

/**
 * BCP-47 tag for Intl APIs. We mostly pass the bare locale code (`en`, `de`,
 * `ar`, …) — the platform falls back to the default region for each language.
 * Override here if you want a specific regional formatting (e.g. `ar-SA`).
 */
function intlLocale(): string {
  const lang = (i18n.resolvedLanguage ?? i18n.language ?? 'en') as Locale | string;
  return lang;
}

/**
 * The single user-facing date format for the whole app: `dd.MM.yyyy`
 * (e.g. `24.05.2026`). Slovak style, locale-independent — we deliberately
 * do NOT defer to `Intl`/`toLocaleDateString` here because those render
 * US-style `M/D/YYYY` under the `en` locale and vary per browser. Keep
 * every user-facing date going through formatDate / formatDateTime so the
 * format stays consistent across SK, EN, DE, RU, AR, TR.
 */
export const DISPLAY_DATE_FORMAT = 'dd.MM.yyyy';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Pull Y/M/D as displayed to the user. Date-only ISO strings
 * (`YYYY-MM-DD`, optionally with a time part) are read field-by-field so
 * a value like `2026-05-24` always renders `24.05.2026` regardless of the
 * viewer's timezone — `new Date('2026-05-24')` is UTC-midnight and would
 * drift to the 23rd west of UTC. Full timestamps and Date objects use
 * local components (so a logged-at time shows in the viewer's zone).
 */
function dateParts(
  value: Date | string | number,
): { y: number; mo: number; d: number; h: number; mi: number } | null {
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) {
      return {
        y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
        h: m[4] ? Number(m[4]) : 0, mi: m[5] ? Number(m[5]) : 0,
      };
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    y: date.getFullYear(), mo: date.getMonth() + 1, d: date.getDate(),
    h: date.getHours(), mi: date.getMinutes(),
  };
}

/**
 * Format a value as `dd.MM.yyyy`. The legacy `options` parameter is kept
 * for call-site compatibility but intentionally ignored — the app uses a
 * single fixed display format. Returns '' for null/empty/invalid input.
 */
export function formatDate(
  value: Date | string | number | null | undefined,
  _options?: Intl.DateTimeFormatOptions,
): string {
  if (value === null || value === undefined || value === '') return '';
  const p = dateParts(value);
  if (!p) return '';
  return `${pad2(p.d)}.${pad2(p.mo)}.${p.y}`;
}

/**
 * Format a value as `dd.MM.yyyy HH:mm` (24-hour). Same fixed format,
 * `options` ignored.
 */
export function formatDateTime(
  value: Date | string | number | null | undefined,
  _options?: Intl.DateTimeFormatOptions,
): string {
  if (value === null || value === undefined || value === '') return '';
  const p = dateParts(value);
  if (!p) return '';
  return `${pad2(p.d)}.${pad2(p.mo)}.${p.y} ${pad2(p.h)}:${pad2(p.mi)}`;
}

export function formatNumber(
  value: number | null | undefined,
  options?: Intl.NumberFormatOptions,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return new Intl.NumberFormat(intlLocale(), options).format(value);
}

/**
 * Format an amount as a currency string for the active locale. The currency
 * argument must be a 3-letter ISO 4217 code; falls back to plain number
 * formatting if it isn't.
 */
export function formatCurrency(
  value: number | null | undefined,
  currency: string = 'EUR',
  options?: Intl.NumberFormatOptions,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const code = (currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return formatNumber(value, options);
  }
  return new Intl.NumberFormat(intlLocale(), {
    style: 'currency',
    currency: code,
    ...options,
  }).format(value);
}

/**
 * Localized country name from an ISO 3166-1 alpha-2 code, via
 * `Intl.DisplayNames`. Used by phone-code/country dropdowns so a code like
 * `GB` renders as "United Kingdom" in en, "Vereinigtes Königreich" in de,
 * "المملكة المتحدة" in ar, etc. Falls back to the provided fallback (or the
 * raw code) when the runtime can't resolve the region.
 */
export function countryName(
  iso: string | null | undefined,
  fallback?: string,
): string {
  if (!iso) return fallback ?? '';
  const code = iso.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return fallback ?? iso;
  try {
    const dn = new Intl.DisplayNames([intlLocale()], { type: 'region' });
    const name = dn.of(code);
    return name && name !== code ? name : (fallback ?? code);
  } catch {
    return fallback ?? code;
  }
}
