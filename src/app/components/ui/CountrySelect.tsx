/** Reusable country dropdown. Uses the centralized COUNTRIES list.
 *  All country selects across the site should use this component.
 *
 *  Country names are translated at render time via `Intl.DisplayNames`
 *  using the active i18n locale, with the canonical English name from
 *  `COUNTRIES` as a fallback when the browser's CLDR doesn't supply a
 *  translation (e.g. for the special-case `XK` Kosovo code or older
 *  runtimes). The list is kept sorted by **localized** name so AR/DE/RU
 *  users see proper alphabetical ordering instead of the English ABC.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { COUNTRIES, Country } from '../../data/countries';
import { useLanguage } from '../../../i18n/LanguageContext';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  disabled?: boolean;
  countries?: Country[];
}

const NONE_VALUE = '__none__';

/** Resolve a country name in the active locale. Falls back to the
 *  canonical English name from `COUNTRIES` when the runtime's CLDR data
 *  has no entry. */
function localizedName(country: Country, locale: string): string {
  try {
    const dn = new Intl.DisplayNames([locale], { type: 'region' });
    return dn.of(country.code) ?? country.name;
  } catch {
    return country.name;
  }
}

export function CountrySelect({ value, onChange, placeholder, required, className, disabled, countries = COUNTRIES }: Props) {
  const { t } = useTranslation('ui');
  const { locale } = useLanguage();
  const selectValue = value === '' ? NONE_VALUE : value;
  const handleChange = (v: string) => onChange(v === NONE_VALUE ? '' : v);

  // Recompute + re-sort whenever the locale changes so AR users see
  // the list ordered by Arabic alphabet, etc. The dropdown still stores
  // the canonical English `c.name` as the form value (backend contract
  // unchanged); only the display label is translated.
  const localized = useMemo(() => {
    const items = countries.map(c => ({ ...c, displayName: localizedName(c, locale) }));
    return items.sort((a, b) => a.displayName.localeCompare(b.displayName, locale));
  }, [countries, locale]);

  return (
    <Select value={selectValue} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder ?? t('country.selectPlaceholder')} />
      </SelectTrigger>
      <SelectContent className="max-h-64 overflow-y-auto">
        {!required && (
          <SelectItem value={NONE_VALUE}>{t('country.none')}</SelectItem>
        )}
        {localized.map(c => (
          <SelectItem key={c.code} value={c.name}>
            <span className="flex items-center gap-2">
              <img src={`https://flagcdn.com/w20/${c.code.toLowerCase()}.png`} width={20} height={15} alt={c.code} className="inline-block rounded-sm" />
              <span>{c.displayName}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
