import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, Palette, Moon, Sun, Monitor, ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { useTheme, brandSchemes, darkSchemes, lightSchemes, type BrandScheme, type DarkScheme, type LightScheme } from '../../contexts/ThemeContext';
import { cn } from '../../components/ui/utils';

// ─── Brand colour swatch ──────────────────────────────────────────────────────
function BrandSwatch({ scheme, selected, onSelect }: {
  scheme: BrandScheme;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all hover:scale-105',
        selected
          ? 'border-primary shadow-lg shadow-primary/20'
          : 'border-transparent hover:border-border',
      )}
    >
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center shadow-md"
        style={{ backgroundColor: scheme.primary }}
      >
        {selected && <Check className="w-5 h-5 text-white" />}
      </div>
      <span className="text-xs font-medium text-foreground">{scheme.name}</span>
    </button>
  );
}

// ─── Dark-mode palette card ───────────────────────────────────────────────────
function DarkSchemeCard({ scheme, selected, onSelect }: {
  scheme: DarkScheme;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'relative flex flex-col rounded-xl border-2 overflow-hidden transition-all hover:scale-[1.02] text-start',
        selected
          ? 'border-primary shadow-lg shadow-primary/20'
          : 'border-border hover:border-muted-foreground/40',
      )}
    >
      {/* Mini layout preview */}
      <div className="flex h-20" style={{ backgroundColor: scheme.background }}>
        {/* Sidebar strip */}
        <div className="w-8 flex flex-col gap-1 p-1.5" style={{ backgroundColor: scheme.sidebar }}>
          <div className="h-1.5 rounded-full" style={{ backgroundColor: scheme.card, opacity: 0.6 }} />
          <div className="h-1.5 rounded-full" style={{ backgroundColor: scheme.card, opacity: 0.6 }} />
          <div className="h-2 rounded-full" style={{ backgroundColor: scheme.accent }} />
          <div className="h-1.5 rounded-full" style={{ backgroundColor: scheme.card, opacity: 0.4 }} />
        </div>
        {/* Content area */}
        <div className="flex-1 p-2 flex flex-col gap-1.5">
          {/* Header bar */}
          <div className="h-3 rounded" style={{ backgroundColor: scheme.card }} />
          {/* Cards */}
          <div className="flex gap-1 flex-1">
            <div className="flex-1 rounded" style={{ backgroundColor: scheme.card }} />
            <div className="flex-1 rounded" style={{ backgroundColor: scheme.card }} />
          </div>
        </div>
      </div>

      {/* Label */}
      <div className={cn(
        'px-3 py-2 flex items-center justify-between',
        selected ? 'bg-primary text-primary-foreground' : 'bg-card text-card-foreground',
      )}>
        <div>
          <p className="text-xs font-semibold">{scheme.name}</p>
          <p className="text-[10px] opacity-70">{scheme.description}</p>
        </div>
        {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
      </div>
    </button>
  );
}

// ─── Light-mode palette card ──────────────────────────────────────────────────
function LightSchemeCard({ scheme, selected, onSelect }: {
  scheme: LightScheme;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'relative flex flex-col rounded-xl border-2 overflow-hidden transition-all hover:scale-[1.02] text-start',
        selected
          ? 'border-primary shadow-lg shadow-primary/20'
          : 'border-border hover:border-muted-foreground/40',
      )}
    >
      {/* Mini layout preview */}
      <div className="flex h-20" style={{ backgroundColor: scheme.background }}>
        {/* Sidebar strip */}
        <div className="w-8 flex flex-col gap-1 p-1.5" style={{ backgroundColor: scheme.sidebar }}>
          <div className="h-1.5 rounded-full" style={{ backgroundColor: scheme.muted }} />
          <div className="h-1.5 rounded-full" style={{ backgroundColor: scheme.muted }} />
          <div className="h-2 rounded-full" style={{ backgroundColor: scheme.accent }} />
          <div className="h-1.5 rounded-full" style={{ backgroundColor: scheme.muted, opacity: 0.5 }} />
        </div>
        {/* Content area */}
        <div className="flex-1 p-2 flex flex-col gap-1.5">
          <div className="h-3 rounded" style={{ backgroundColor: scheme.card }} />
          <div className="flex gap-1 flex-1">
            <div className="flex-1 rounded" style={{ backgroundColor: scheme.card }} />
            <div className="flex-1 rounded" style={{ backgroundColor: scheme.card }} />
          </div>
        </div>
      </div>

      {/* Label */}
      <div className={cn(
        'px-3 py-2 flex items-center justify-between',
        selected ? 'bg-primary text-primary-foreground' : 'bg-card text-card-foreground',
      )}>
        <div>
          <p className="text-xs font-semibold">{scheme.name}</p>
          <p className="text-[10px] opacity-70">{scheme.description}</p>
        </div>
        {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
      </div>
    </button>
  );
}

// ─── Live preview ─────────────────────────────────────────────────────────────
function ThemePreview({ brand, isDark, dark, light }: {
  brand: BrandScheme;
  isDark: boolean;
  dark: DarkScheme;
  light: LightScheme;
}) {
  const bg = isDark ? dark.background : light.background;
  const cardBg = isDark ? dark.card : light.card;
  const sidebar = isDark ? dark.sidebar : light.sidebar;
  const accent = isDark ? dark.accent : light.accent;
  const textColor = isDark ? '#e8e8f5' : '#0F172A';
  const mutedText = isDark ? '#8080a8' : '#717182';

  return (
    <div
      className="rounded-xl overflow-hidden border border-border shadow-lg"
      style={{ backgroundColor: bg, minHeight: 160 }}
    >
      <div className="flex h-40">
        {/* Sidebar */}
        <div className="w-28 flex flex-col" style={{ backgroundColor: sidebar }}>
          <div className="p-2.5 border-b" style={{ borderColor: 'rgba(128,128,128,0.15)' }}>
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: brand.primary }}>
                <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: brand.primaryForeground, opacity: 0.8 }} />
              </div>
              <div className="text-[9px] font-bold" style={{ color: textColor }}>TempWorks</div>
            </div>
          </div>
          <div className="flex-1 p-1.5 flex flex-col gap-0.5">
            {['Dashboard', 'Employees', 'Documents', 'Reports'].map((label, i) => (
              <div
                key={label}
                className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[8px]"
                style={{
                  backgroundColor: i === 0 ? brand.primary : 'transparent',
                  color: i === 0 ? brand.primaryForeground : mutedText,
                }}
              >
                <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: i === 0 ? brand.primaryForeground : mutedText, opacity: 0.6 }} />
                {label}
              </div>
            ))}
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="h-8 flex items-center px-3 gap-2 border-b" style={{ backgroundColor: cardBg, borderColor: 'rgba(128,128,128,0.1)' }}>
            <div className="flex-1 h-3 rounded-full" style={{ backgroundColor: accent }} />
            <div className="w-5 h-5 rounded-full" style={{ backgroundColor: brand.primary, opacity: 0.8 }} />
          </div>
          {/* Cards */}
          <div className="flex-1 p-2 grid grid-cols-2 gap-1.5">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="rounded-lg p-1.5 flex flex-col gap-1" style={{ backgroundColor: cardBg }}>
                <div className="h-1.5 rounded-full w-3/4" style={{ backgroundColor: accent }} />
                <div className="h-2 rounded font-bold text-[7px] flex items-center ps-0.5" style={{ color: textColor }}>
                  {i % 2 === 0 ? '1,240' : '98.2%'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export function ColorScheme() {
  const { t } = useTranslation('pages');
  const { isDark, toggleDark, brandScheme, setBrandScheme, darkScheme, setDarkScheme, lightScheme, setLightScheme } = useTheme();
  const navigate = useNavigate();

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-2xl font-semibold text-foreground">{t('settings.colorScheme.headerTitle')}</h1>
        </div>
        <p className="text-muted-foreground mt-1">{t('settings.colorScheme.headerSubtitle')}</p>
      </div>

      {/* Mode toggle */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Monitor className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle>Color Mode</CardTitle>
              <CardDescription>Switch between light and dark appearance</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <button
              onClick={() => isDark && toggleDark()}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-3 rounded-lg border-2 transition-all text-sm font-medium',
                !isDark
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/50',
              )}
            >
              <Sun className="w-4 h-4" />
              Light Mode
              {!isDark && <Check className="w-4 h-4" />}
            </button>
            <button
              onClick={() => !isDark && toggleDark()}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-3 rounded-lg border-2 transition-all text-sm font-medium',
                isDark
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/50',
              )}
            >
              <Moon className="w-4 h-4" />
              Dark Mode
              {isDark && <Check className="w-4 h-4" />}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Brand colour */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Palette className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle>Brand Color</CardTitle>
              <CardDescription>Primary accent for buttons, active states, and highlights — applies to both modes</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {brandSchemes.map(s => (
              <BrandSwatch
                key={s.id}
                scheme={s}
                selected={brandScheme.id === s.id}
                onSelect={() => setBrandScheme(s)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Light background palette */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
              <Sun className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <CardTitle>Light Mode Background</CardTitle>
              <CardDescription>Background palette used in light mode</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {lightSchemes.map(s => (
              <LightSchemeCard
                key={s.id}
                scheme={s}
                selected={lightScheme.id === s.id}
                onSelect={() => setLightScheme(s)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Dark background palette */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
              <Moon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <CardTitle>Dark Mode Background</CardTitle>
              <CardDescription>Background palette used when dark mode is active</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {darkSchemes.map(s => (
              <DarkSchemeCard
                key={s.id}
                scheme={s}
                selected={darkScheme.id === s.id}
                onSelect={() => setDarkScheme(s)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Live preview */}
      <Card>
        <CardHeader>
          <CardTitle>Live Preview</CardTitle>
          <CardDescription>See how your selected theme looks across the layout</CardDescription>
        </CardHeader>
        <CardContent>
          <ThemePreview
            brand={brandScheme}
            isDark={isDark}
            dark={darkScheme}
            light={lightScheme}
          />
          <p className="text-xs text-muted-foreground mt-3 text-center">
            Changes apply instantly — your selections are saved automatically
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
