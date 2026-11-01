import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import i18n from './index';
import {
  dirOf,
  isAnyLocale,
  isSupportedLocale,
  normalizeLocale,
  PSEUDO_LOCALE,
  STORAGE_KEY,
  type Locale,
  type LocaleOrPseudo,
} from './config';

interface LanguageContextValue {
  locale: LocaleOrPseudo;
  dir: 'ltr' | 'rtl';
  setLocale: (l: LocaleOrPseudo) => void;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function applyDocumentAttributes(locale: LocaleOrPseudo) {
  const dir = dirOf(locale);
  if (typeof document !== 'undefined') {
    // For pseudo, keep `lang="en"` so screen readers / spell-check don't get confused.
    document.documentElement.lang = locale === PSEUDO_LOCALE ? 'en' : (locale as Locale);
    document.documentElement.dir = dir;
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleOrPseudo>(() => {
    const detected = i18n.resolvedLanguage ?? i18n.language;
    if (isAnyLocale(detected)) return detected;
    if (isSupportedLocale(detected)) return detected;
    return normalizeLocale(detected);
  });

  // Apply <html lang>/<html dir> immediately on first render and whenever the locale changes.
  useEffect(() => {
    applyDocumentAttributes(locale);
  }, [locale]);

  // Keep our state in sync if i18next changes language elsewhere (e.g. the detector
  // running on init, or another component calling i18n.changeLanguage directly).
  useEffect(() => {
    const handler = (lng: string) => {
      const next: LocaleOrPseudo = isAnyLocale(lng)
        ? lng
        : isSupportedLocale(lng)
        ? lng
        : normalizeLocale(lng);
      setLocaleState(prev => (prev === next ? prev : next));
    };
    i18n.on('languageChanged', handler);
    return () => {
      i18n.off('languageChanged', handler);
    };
  }, []);

  const value = useMemo<LanguageContextValue>(() => ({
    locale,
    dir: dirOf(locale),
    setLocale: (l: LocaleOrPseudo) => {
      void i18n.changeLanguage(l);
      try { localStorage.setItem(STORAGE_KEY, l); } catch {/* ignore quota / privacy mode */}
      setLocaleState(l);
    },
  }), [locale]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
