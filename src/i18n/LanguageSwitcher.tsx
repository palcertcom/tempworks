import { Globe, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLanguage } from './LanguageContext';
import {
  LOCALE_LABELS,
  LOCALE_SHORT_LABELS,
  PSEUDO_LOCALE,
  SUPPORTED_LOCALES,
  type LocaleOrPseudo,
} from './config';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../app/components/ui/dropdown-menu';
import { cn } from '../app/components/ui/utils';

const IS_DEV = import.meta.env.DEV;

interface LanguageSwitcherProps {
  /** "compact" → flag + 2-letter code, "labelled" → flag + native name. */
  variant?: 'compact' | 'labelled';
  /** Optional extra class names for the trigger. */
  className?: string;
  /** Where the menu should be anchored. */
  align?: 'start' | 'center' | 'end';
}

export function LanguageSwitcher({
  variant = 'compact',
  className,
  align = 'end',
}: LanguageSwitcherProps) {
  const { locale, setLocale } = useLanguage();
  const { t } = useTranslation('common');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('language.switcherLabel')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm',
          'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
          className,
        )}
      >
        <Globe className="w-4 h-4" aria-hidden="true" />
        <span className="font-medium">
          {variant === 'compact' ? LOCALE_SHORT_LABELS[locale] : LOCALE_LABELS[locale]}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[10rem]">
        {SUPPORTED_LOCALES.map((l) => {
          const isCurrent = l === locale;
          return (
            <DropdownMenuItem
              key={l}
              onClick={() => setLocale(l)}
              aria-current={isCurrent}
              className="flex items-center justify-between gap-3"
            >
              <span>{LOCALE_LABELS[l]}</span>
              {isCurrent && <Check className="w-4 h-4 text-primary" aria-hidden="true" />}
            </DropdownMenuItem>
          );
        })}
        {IS_DEV && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              key={PSEUDO_LOCALE}
              onClick={() => setLocale(PSEUDO_LOCALE as LocaleOrPseudo)}
              aria-current={locale === PSEUDO_LOCALE}
              className="flex items-center justify-between gap-3 text-muted-foreground"
            >
              <span>{LOCALE_LABELS[PSEUDO_LOCALE]}</span>
              {locale === PSEUDO_LOCALE && <Check className="w-4 h-4 text-primary" aria-hidden="true" />}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
