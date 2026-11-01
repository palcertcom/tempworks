import { useState, useEffect } from 'react';
import { API_URL } from '../services/api';

export interface Branding {
  // Core
  companyName: string;
  logoUrl?: string;
  tagline: string;
  // Hero section
  heroBadge: string;
  heroHeadline: string;
  heroDescription: string;
  // Stats
  statPlacements: string;
  statPartners: string;
  statCountries: string;
  // Contact
  address: string;
  phone1: string;
  phone2: string;
  emailInfo: string;
  emailRecruitment: string;
  emailSupport: string;
  // Social
  linkedIn: string;
  facebook: string;
  // Footer
  footerTagline: string;
  vatInfo: string;
}

export const BRANDING_DEFAULTS: Branding = {
  companyName: 'TempWorks Europe',
  tagline: 'Professional Recruitment Solutions',
  heroBadge: 'Trusted European Recruitment Partner',
  heroHeadline: 'Connecting Skilled Workers with Opportunities in Europe',
  heroDescription: 'We help professionals start their careers in Germany with legal employment, visa support, and professional onboarding.',
  statPlacements: '500+',
  statPartners: '50+',
  statCountries: '15',
  address: 'Königsallee 27, 40212 Düsseldorf, Germany',
  phone1: '+49 211 1234 5678',
  phone2: '+49 211 1234 5679',
  emailInfo: 'info@tempworks.eu',
  emailRecruitment: 'recruitment@tempworks.eu',
  emailSupport: 'support@tempworks.eu',
  linkedIn: 'https://linkedin.com',
  facebook: 'https://facebook.com',
  footerTagline: 'Professional recruitment solutions connecting skilled workers with leading European employers.',
  vatInfo: 'Registered in Germany | HRB 123456 | VAT: DE123456789',
};

let cache: Branding | null = null;
let inflight: Promise<Branding> | null = null;
const listeners = new Set<(b: Branding) => void>();

function mapApiData(data: Record<string, string>): Branding {
  return {
    companyName: data.companyName || BRANDING_DEFAULTS.companyName,
    logoUrl: data.logoUrl,
    tagline: data.tagline || BRANDING_DEFAULTS.tagline,
    heroBadge: data.heroBadge || BRANDING_DEFAULTS.heroBadge,
    heroHeadline: data.heroHeadline || BRANDING_DEFAULTS.heroHeadline,
    heroDescription: data.heroDescription || BRANDING_DEFAULTS.heroDescription,
    statPlacements: data.statPlacements || BRANDING_DEFAULTS.statPlacements,
    statPartners: data.statPartners || BRANDING_DEFAULTS.statPartners,
    statCountries: data.statCountries || BRANDING_DEFAULTS.statCountries,
    address: data.address || BRANDING_DEFAULTS.address,
    phone1: data.phone1 || BRANDING_DEFAULTS.phone1,
    phone2: data.phone2 || BRANDING_DEFAULTS.phone2,
    emailInfo: data.emailInfo || BRANDING_DEFAULTS.emailInfo,
    emailRecruitment: data.emailRecruitment || BRANDING_DEFAULTS.emailRecruitment,
    emailSupport: data.emailSupport || BRANDING_DEFAULTS.emailSupport,
    linkedIn: data.linkedIn || BRANDING_DEFAULTS.linkedIn,
    facebook: data.facebook || BRANDING_DEFAULTS.facebook,
    footerTagline: data.footerTagline || BRANDING_DEFAULTS.footerTagline,
    vatInfo: data.vatInfo || BRANDING_DEFAULTS.vatInfo,
  };
}

async function fetchBranding(): Promise<Branding> {
  try {
    // Phase 3.17 — forward the bearer when present so the backend can
    // overlay the active tenant's branding. The endpoint stays public
    // (no token required); the bearer is just a hint.
    const token = (() => {
      try { return localStorage.getItem('access_token') || ''; } catch { return ''; }
    })();
    const res = await fetch(`${API_URL}/settings/branding`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return BRANDING_DEFAULTS;
    return mapApiData(await res.json());
  } catch {
    return BRANDING_DEFAULTS;
  }
}

export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(cache ?? BRANDING_DEFAULTS);

  useEffect(() => {
    listeners.add(setBranding);

    if (cache) {
      setBranding(cache);
    } else {
      if (!inflight) {
        inflight = fetchBranding().then(b => { cache = b; return b; });
      }
      inflight.then(b => { setBranding(b); });
    }

    return () => { listeners.delete(setBranding); };
  }, []);

  return branding;
}

export function invalidateBrandingCache() {
  cache = null;
  inflight = null;
  // Re-fetch and push to all mounted hook instances immediately
  fetchBranding().then(b => {
    cache = b;
    listeners.forEach(fn => fn(b));
  });
}
