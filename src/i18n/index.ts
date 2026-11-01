import i18n, { type BackendModule, type ReadCallback, type Services, type InitOptions } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import {
  SUPPORTED_LOCALES,
  FALLBACK_LOCALE,
  NAMESPACES,
  DEFAULT_NS,
  STORAGE_KEY,
  type Locale,
  type Namespace,
} from './config';
import { pseudoizeTree } from './pseudo';

// English is the fallback and is always needed up-front. Bundling it
// statically guarantees it's available synchronously on first render so
// no UI flickers untranslated while the chosen locale loads.
import enCommon    from './locales/en/common.json';
import enNav       from './locales/en/nav.json';
import enAuth      from './locales/en/auth.json';
import enPublic    from './locales/en/public.json';
import enEnums     from './locales/en/enums.json';
import enErrors    from './locales/en/errors.json';
import enDashboard from './locales/en/dashboard.json';
import enUi        from './locales/en/ui.json';
import enPages     from './locales/en/pages.json';

const ENGLISH_RESOURCES: Record<Namespace, Record<string, unknown>> = {
  common: enCommon, nav: enNav, auth: enAuth, public: enPublic,
  enums: enEnums, errors: enErrors, dashboard: enDashboard,
  ui: enUi, pages: enPages,
};

// Lazy-load every other locale via dynamic imports. Each locale becomes its
// own Vite chunk, so a user who never switches off English doesn't pay for
// the other 5 locales' bytes. The `pseudo` locale is materialized
// in-memory by walking the English tree and accenting every leaf.
const lazyBackend: BackendModule = {
  type: 'backend',
  init(_services: Services, _backendOptions: object, _i18nextOptions: InitOptions) { /* no-op */ },
  read(language: string, namespace: string, callback: ReadCallback) {
    if (language === 'en') {
      const ns = ENGLISH_RESOURCES[namespace as Namespace];
      callback(null, ns ?? {});
      return;
    }
    if (language === 'pseudo') {
      const ns = ENGLISH_RESOURCES[namespace as Namespace];
      callback(null, ns ? (pseudoizeTree(ns) as Record<string, unknown>) : {});
      return;
    }
    if (!(SUPPORTED_LOCALES as readonly string[]).includes(language)) {
      callback(new Error(`Unsupported locale: ${language}`), false);
      return;
    }
    // Vite picks these up at build time and creates a chunk per (locale, ns).
    // Using a template literal with two variables means Vite generates a
    // glob — fine for our small JSON files.
    import(`./locales/${language}/${namespace}.json`)
      .then((mod) => callback(null, mod.default))
      .catch((err) => callback(err as Error, false));
  },
};

void i18n
  .use(lazyBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: ENGLISH_RESOURCES },
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES, 'pseudo'],
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    partialBundledLanguages: true, // English is bundled, others are loaded lazily
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NS,
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: STORAGE_KEY,
    },
    interpolation: { escapeValue: false },
    returnNull: false,
  });

export default i18n;
export type { Locale };
