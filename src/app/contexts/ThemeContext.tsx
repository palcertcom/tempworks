import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

// ─── Brand colour schemes (primary accent – applies to both modes) ────────────
export interface BrandScheme {
  id: string;
  name: string;
  primary: string;
  primaryForeground: string;
}

export const brandSchemes: BrandScheme[] = [
  { id: 'blue',    name: 'Blue',    primary: '#2563EB', primaryForeground: '#ffffff' },
  { id: 'indigo',  name: 'Indigo',  primary: '#4F46E5', primaryForeground: '#ffffff' },
  { id: 'violet',  name: 'Violet',  primary: '#7C3AED', primaryForeground: '#ffffff' },
  { id: 'emerald', name: 'Emerald', primary: '#059669', primaryForeground: '#ffffff' },
  { id: 'teal',    name: 'Teal',    primary: '#0D9488', primaryForeground: '#ffffff' },
  { id: 'rose',    name: 'Rose',    primary: '#E11D48', primaryForeground: '#ffffff' },
  { id: 'orange',  name: 'Orange',  primary: '#EA580C', primaryForeground: '#ffffff' },
  { id: 'amber',   name: 'Amber',   primary: '#D97706', primaryForeground: '#ffffff' },
];

// ─── Dark-mode background palettes ───────────────────────────────────────────
export interface DarkScheme {
  id: string;
  name: string;
  description: string;
  background: string;
  card: string;
  popover: string;
  sidebar: string;
  sidebarAccent: string;
  accent: string;
  secondary: string;
  muted: string;
  inputBackground: string;
  border: string;
}

export const darkSchemes: DarkScheme[] = [
  {
    id: 'corona',
    name: 'Corona',
    description: 'Dark navy-purple',
    background: '#0f0f1a',
    card: '#171728',
    popover: '#1c1c30',
    sidebar: '#13132a',
    sidebarAccent: '#252542',
    accent: '#252542',
    secondary: '#252542',
    muted: '#171728',
    inputBackground: '#1c1c30',
    border: 'rgba(255,255,255,0.08)',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Near-black deep dark',
    background: '#020209',
    card: '#0d0d18',
    popover: '#12121f',
    sidebar: '#080812',
    sidebarAccent: '#1a1a2a',
    accent: '#1a1a2a',
    secondary: '#1a1a2a',
    muted: '#0d0d18',
    inputBackground: '#12121f',
    border: 'rgba(255,255,255,0.07)',
  },
  {
    id: 'slate',
    name: 'Slate Ocean',
    description: 'Blue-grey slate',
    background: '#0F172A',
    card: '#1E293B',
    popover: '#1E293B',
    sidebar: '#1E293B',
    sidebarAccent: '#334155',
    accent: '#334155',
    secondary: '#334155',
    muted: '#1E293B',
    inputBackground: '#1E293B',
    border: 'rgba(148,163,184,0.15)',
  },
  {
    id: 'deep-purple',
    name: 'Deep Purple',
    description: 'Rich violet depth',
    background: '#1a0a2e',
    card: '#251040',
    popover: '#2d1450',
    sidebar: '#200d38',
    sidebarAccent: '#351855',
    accent: '#351855',
    secondary: '#351855',
    muted: '#251040',
    inputBackground: '#2d1450',
    border: 'rgba(255,255,255,0.08)',
  },
  {
    id: 'charcoal',
    name: 'Charcoal',
    description: 'Neutral near-black',
    background: '#111111',
    card: '#1c1c1c',
    popover: '#242424',
    sidebar: '#161616',
    sidebarAccent: '#2e2e2e',
    accent: '#2e2e2e',
    secondary: '#2e2e2e',
    muted: '#1c1c1c',
    inputBackground: '#242424',
    border: 'rgba(255,255,255,0.08)',
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Dark emerald green',
    background: '#051a0a',
    card: '#0a2410',
    popover: '#0f2e16',
    sidebar: '#071d0c',
    sidebarAccent: '#14381e',
    accent: '#14381e',
    secondary: '#14381e',
    muted: '#0a2410',
    inputBackground: '#0f2e16',
    border: 'rgba(255,255,255,0.08)',
  },
];

// ─── Light-mode background palettes ──────────────────────────────────────────
export interface LightScheme {
  id: string;
  name: string;
  description: string;
  background: string;
  card: string;
  sidebar: string;
  sidebarAccent: string;
  accent: string;
  muted: string;
  border: string;
}

export const lightSchemes: LightScheme[] = [
  {
    id: 'snow',
    name: 'Snow White',
    description: 'Clean white & light grey',
    background: '#F8FAFC',
    card: '#ffffff',
    sidebar: '#ffffff',
    sidebarAccent: '#F1F5F9',
    accent: '#e9ebef',
    muted: '#ececf0',
    border: 'rgba(0,0,0,0.1)',
  },
  {
    id: 'warm',
    name: 'Warm Sand',
    description: 'Warm cream tones',
    background: '#FAFAF8',
    card: '#FFFEF5',
    sidebar: '#FFFEF5',
    sidebarAccent: '#F5F0E8',
    accent: '#EDE8DE',
    muted: '#EDECE8',
    border: 'rgba(0,0,0,0.08)',
  },
  {
    id: 'cool',
    name: 'Cool Mist',
    description: 'Soft blue-grey',
    background: '#F0F4F8',
    card: '#FFFFFF',
    sidebar: '#FFFFFF',
    sidebarAccent: '#E2EAF0',
    accent: '#DDE5ED',
    muted: '#E0E8F0',
    border: 'rgba(0,0,0,0.09)',
  },
];

// ─── Context ──────────────────────────────────────────────────────────────────
interface ThemeContextType {
  isDark: boolean;
  toggleDark: () => void;
  brandScheme: BrandScheme;
  setBrandScheme: (s: BrandScheme) => void;
  darkScheme: DarkScheme;
  setDarkScheme: (s: DarkScheme) => void;
  lightScheme: LightScheme;
  setLightScheme: (s: LightScheme) => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

// ─── CSS application helpers ──────────────────────────────────────────────────
function applyVars(vars: Record<string, string>) {
  const root = document.documentElement;
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
}

function removeVars(keys: string[]) {
  const root = document.documentElement;
  keys.forEach(k => root.style.removeProperty(k));
}

const DARK_ONLY_VARS = [
  '--background', '--card', '--card-foreground',
  '--popover', '--popover-foreground',
  '--muted', '--muted-foreground',
  '--accent', '--accent-foreground',
  '--secondary', '--secondary-foreground',
  '--sidebar', '--sidebar-accent', '--sidebar-accent-foreground',
  '--sidebar-border', '--border',
  '--input-background',
];

function applyFullTheme(
  brand: BrandScheme,
  dark: DarkScheme,
  light: LightScheme,
  isDark: boolean,
) {
  const root = document.documentElement;

  // Toggle dark class
  if (isDark) root.classList.add('dark');
  else root.classList.remove('dark');

  // Brand – applies to both modes
  applyVars({
    '--primary': brand.primary,
    '--primary-foreground': brand.primaryForeground,
    '--ring': brand.primary,
    '--sidebar-primary': brand.primary,
    '--sidebar-primary-foreground': brand.primaryForeground,
    '--sidebar-ring': brand.primary,
  });

  if (isDark) {
    applyVars({
      '--background': dark.background,
      '--card': dark.card,
      '--card-foreground': '#e8e8f5',
      '--popover': dark.popover,
      '--popover-foreground': '#e8e8f5',
      '--muted': dark.muted,
      '--muted-foreground': '#8080a8',
      '--accent': dark.accent,
      '--accent-foreground': '#e8e8f5',
      '--secondary': dark.secondary,
      '--secondary-foreground': '#e8e8f5',
      '--sidebar': dark.sidebar,
      '--sidebar-accent': dark.sidebarAccent,
      '--sidebar-accent-foreground': '#e8e8f5',
      '--sidebar-border': dark.border,
      '--border': dark.border,
      '--input-background': dark.inputBackground,
    });
  } else {
    // Clear dark overrides so :root stylesheet values take over for dark vars,
    // then apply the light scheme background overrides
    removeVars(DARK_ONLY_VARS);
    applyVars({
      '--background': light.background,
      '--card': light.card,
      '--sidebar': light.sidebar,
      '--sidebar-accent': light.sidebarAccent,
      '--sidebar-accent-foreground': 'oklch(0.205 0 0)',
      '--sidebar-border': light.border,
      '--accent': light.accent,
      '--muted': light.muted,
      '--border': light.border,
    });
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState<boolean>(() =>
    localStorage.getItem('theme') === 'dark',
  );
  const [brandScheme, setBrandSchemeState] = useState<BrandScheme>(() => {
    const id = localStorage.getItem('brandScheme');
    return brandSchemes.find(s => s.id === id) ?? brandSchemes[0];
  });
  const [darkScheme, setDarkSchemeState] = useState<DarkScheme>(() => {
    const id = localStorage.getItem('darkScheme');
    return darkSchemes.find(s => s.id === id) ?? darkSchemes[0];
  });
  const [lightScheme, setLightSchemeState] = useState<LightScheme>(() => {
    const id = localStorage.getItem('lightScheme');
    return lightSchemes.find(s => s.id === id) ?? lightSchemes[0];
  });

  // Apply theme whenever any piece changes
  useEffect(() => {
    applyFullTheme(brandScheme, darkScheme, lightScheme, isDark);
  }, [isDark, brandScheme, darkScheme, lightScheme]);

  const toggleDark = () => {
    const next = !isDark;
    setIsDark(next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  const setBrandScheme = (s: BrandScheme) => {
    setBrandSchemeState(s);
    localStorage.setItem('brandScheme', s.id);
  };
  const setDarkScheme = (s: DarkScheme) => {
    setDarkSchemeState(s);
    localStorage.setItem('darkScheme', s.id);
  };
  const setLightScheme = (s: LightScheme) => {
    setLightSchemeState(s);
    localStorage.setItem('lightScheme', s.id);
  };

  return (
    <ThemeContext.Provider
      value={{ isDark, toggleDark, brandScheme, setBrandScheme, darkScheme, setDarkScheme, lightScheme, setLightScheme }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
