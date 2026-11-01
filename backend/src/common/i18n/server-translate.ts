/**
 * Minimal server-side i18n resolver.
 *
 * Used by:
 *   - the Notifications reader to render `titleKey`/`messageKey` against
 *     the requester's `Accept-Language`
 *   - export services (Excel/PDF) to localize column headers and section
 *     titles based on `Accept-Language`
 *
 * Locale catalogs live under `backend/src/common/i18n/locales/<locale>/`
 * as plain JSON. They duplicate the relevant frontend keys (notifications,
 * exports) — kept small on purpose. The frontend's broader `pages`
 * namespace is not mirrored server-side; only the strings the backend
 * actually emits.
 *
 * Lookup order on a missing key:
 *   1. requested locale
 *   2. English fallback
 *   3. the verbatim key string (so missing keys surface in dev rather than
 *      silently returning empty)
 */
import enNotifications from './locales/en/notifications.json';
import enExports from './locales/en/exports.json';
import arNotifications from './locales/ar/notifications.json';
import arExports from './locales/ar/exports.json';
import deNotifications from './locales/de/notifications.json';
import deExports from './locales/de/exports.json';
import ruNotifications from './locales/ru/notifications.json';
import ruExports from './locales/ru/exports.json';
import skNotifications from './locales/sk/notifications.json';
import skExports from './locales/sk/exports.json';
import trNotifications from './locales/tr/notifications.json';
import trExports from './locales/tr/exports.json';

export type ServerLocale = 'en' | 'ar' | 'de' | 'ru' | 'sk' | 'tr';
export type ServerNamespace = 'notifications' | 'exports';

export const SERVER_SUPPORTED_LOCALES: readonly ServerLocale[] = [
  'en', 'ar', 'de', 'ru', 'sk', 'tr',
] as const;

const CATALOGS: Record<ServerLocale, Record<ServerNamespace, unknown>> = {
  en: { notifications: enNotifications, exports: enExports },
  ar: { notifications: arNotifications, exports: arExports },
  de: { notifications: deNotifications, exports: deExports },
  ru: { notifications: ruNotifications, exports: ruExports },
  sk: { notifications: skNotifications, exports: skExports },
  tr: { notifications: trNotifications, exports: trExports },
};

function getNested(obj: unknown, path: string): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const segments = path.split('.');
  let cur: any = obj;
  for (const s of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    params[key] !== undefined && params[key] !== null ? String(params[key]) : '',
  );
}

/**
 * Resolve `Accept-Language` (e.g. `ar,en-US;q=0.9`) into one of the
 * supported server locales. Returns `'en'` when nothing matches so callers
 * can pass the result straight into `tServer`.
 */
export function resolveAcceptLanguage(header: string | undefined | null): ServerLocale {
  if (!header || typeof header !== 'string') return 'en';
  const candidates = header
    .split(',')
    .map(s => s.split(';')[0].trim().toLowerCase())
    .map(s => s.split('-')[0]);
  for (const c of candidates) {
    if ((SERVER_SUPPORTED_LOCALES as readonly string[]).includes(c)) {
      return c as ServerLocale;
    }
  }
  return 'en';
}

/**
 * Resolve a dotted key against the server's locale catalogs.
 *
 *   tServer('events.documentUploaded.title', { name: 'CV.pdf' }, 'ar')
 *
 * Falls back through (locale → en → verbatim key). Always returns a string.
 */
export function tServer(
  key: string,
  params: Record<string, unknown> | undefined,
  locale: ServerLocale,
  ns: ServerNamespace = 'notifications',
): string {
  const lc = (SERVER_SUPPORTED_LOCALES as readonly string[]).includes(locale)
    ? locale
    : 'en';
  const primary = getNested(CATALOGS[lc as ServerLocale][ns], key);
  if (primary !== undefined) return interpolate(primary, params);
  const fallback = getNested(CATALOGS.en[ns], key);
  if (fallback !== undefined) return interpolate(fallback, params);
  return key;
}
