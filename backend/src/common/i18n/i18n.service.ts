import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

const SUPPORTED = ['en', 'sk', 'de', 'ru', 'ar', 'tr'] as const;
type Locale = (typeof SUPPORTED)[number];
const FALLBACK: Locale = 'en';

const LEGACY_PROFILE_VALUES: Record<string, Locale> = {
  english: 'en', en: 'en',
  arabic: 'ar', ar: 'ar',
  german: 'de', deutsch: 'de', de: 'de',
  russian: 'ru', ru: 'ru',
  slovak: 'sk', slovencina: 'sk', sk: 'sk',
  turkish: 'tr', türkçe: 'tr', turkce: 'tr', tr: 'tr',
};

function isSupported(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED as readonly string[]).includes(value);
}

/**
 * Normalize an arbitrary input (BCP-47 tag, legacy profile value such as
 * "English", or undefined) into one of the SUPPORTED locales. Always returns
 * a valid value — falls back to English on any unrecognized input.
 */
export function normalizeLocale(input: string | null | undefined): Locale {
  if (!input) return FALLBACK;
  const lower = input.toLowerCase().trim();
  if (isSupported(lower)) return lower;
  const base = lower.split(/[-_]/)[0];
  if (isSupported(base)) return base;
  if (lower in LEGACY_PROFILE_VALUES) return LEGACY_PROFILE_VALUES[lower];
  return FALLBACK;
}

/**
 * Parse an `Accept-Language` header and return the highest-priority locale
 * we support. Examples that resolve to `de`:
 *   "de"
 *   "de-AT,de;q=0.9,en-US;q=0.8,en;q=0.7"
 *   "fr,de;q=0.7"  (we don't support fr → fall through to de)
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const parts = header
    .split(',')
    .map((entry) => {
      const [tag, ...rest] = entry.trim().split(';');
      const qPart = rest.find((p) => p.trim().startsWith('q='));
      const q = qPart ? Number(qPart.split('=')[1]) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of parts) {
    if (!tag) continue;
    if (isSupported(tag)) return tag;
    const base = tag.split(/[-_]/)[0];
    if (isSupported(base)) return base;
  }
  return null;
}

@Injectable()
export class I18nService {
  /**
   * Resolve the active locale for a request. Order:
   *   1. `?lang=` query (explicit override, useful for public endpoints)
   *   2. authenticated `req.user.preferredLanguage`
   *   3. `Accept-Language` header
   *   4. fallback `en`
   */
  resolve(req: Request): Locale {
    const fromQuery = (req.query?.lang as string | undefined) || undefined;
    if (fromQuery) {
      const normalized = normalizeLocale(fromQuery);
      if (normalized !== FALLBACK || fromQuery.toLowerCase() === 'en') return normalized;
    }
    const user = (req as any).user as { preferredLanguage?: string | null } | undefined;
    if (user?.preferredLanguage) return normalizeLocale(user.preferredLanguage);
    const fromHeader = localeFromAcceptLanguage(req.headers['accept-language'] as string | undefined);
    if (fromHeader) return fromHeader;
    return FALLBACK;
  }

  static localized<T extends Record<string, any>>(
    row: T,
    locale: string,
    field: keyof T = 'name' as keyof T,
  ): string {
    const fallback = (row[field] as unknown as string | null | undefined) ?? '';
    const translations = (row as any).translations;
    if (!translations || typeof translations !== 'object') return fallback;
    const candidate = translations[locale]?.[field as string];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    return fallback;
  }
}

export type { Locale };
export { SUPPORTED as SUPPORTED_LOCALES, FALLBACK as FALLBACK_LOCALE };
