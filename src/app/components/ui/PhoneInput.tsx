/** Phone field with a SEARCHABLE country-dial-code dropdown.
 *  The component works on a single phone string (e.g. "+44 20 7123 4567")
 *  and splits/joins it against the known dial codes so the caller only
 *  sees one string value — no schema change required.
 *
 *  Phase 3 #7 — replaced the previous static <Select> with a
 *  Popover + Command pattern so users can type a country name or dial
 *  code to filter the 200+ options.
 */
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverTrigger, PopoverContent } from './popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from './command';
import { Button } from './button';
import { Input } from './input';
import { ChevronDown, Check } from 'lucide-react';
import { PHONE_CODES, splitPhone } from '../../data/phoneCodes';
import { countryName } from '../../../i18n/formatters';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  /** Dial code to use when the value has none. Default is empty so the
   *  user is forced to pick one — same convention used everywhere else
   *  on the site. Pass e.g. '+44' to keep a UK pre-selection. */
  defaultCode?: string;
}

export function PhoneInput({
  value,
  onChange,
  placeholder,
  disabled,
  required,
  id,
  className,
  defaultCode = '',
}: Props) {
  const { t } = useTranslation('ui');
  const { code, number } = splitPhone(value);
  const activeCode = code || defaultCode;
  const hasCode = !!activeCode;
  const iso = PHONE_CODES.find(p => p.code === activeCode)?.iso ?? '';
  const inputPlaceholder = placeholder ?? t('phone.placeholder');
  const [open, setOpen] = useState(false);

  // Each option already carries its dial code + ISO + a label.
  // For the searchable command we add a localized country name so the
  // user can type either the name or the dial code.
  const options = useMemo(() => PHONE_CODES.map(c => ({
    code: c.code,
    iso: c.iso,
    label: c.label,
    name: countryName(c.iso, c.label),
  })), []);

  const commit = (nextCode: string, nextNumber: string) => {
    const n = nextNumber.trim();
    onChange(n ? `${nextCode} ${n}` : nextCode);
  };

  return (
    <div className={`flex gap-2 ${className ?? ''}`}>
      <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-32 shrink-0 justify-between font-normal"
            aria-label={t('phone.code', { defaultValue: 'Country code' })}
          >
            {hasCode ? (
              <span className="inline-flex items-center gap-2 truncate">
                {iso && (
                  <img
                    src={`https://flagcdn.com/w20/${iso.toLowerCase()}.png`}
                    width={20}
                    height={15}
                    alt=""
                    className="inline-block rounded-sm"
                  />
                )}
                <span className="font-mono text-xs">{activeCode}</span>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">{t('phone.code')}</span>
            )}
            <ChevronDown className="w-3.5 h-3.5 opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder={t('phone.searchCode', { defaultValue: 'Search country or code…' })} />
            <CommandList className="max-h-64">
              <CommandEmpty>{t('phone.noResults', { defaultValue: 'No country matches.' })}</CommandEmpty>
              <CommandGroup>
                {options.map(o => (
                  <CommandItem
                    key={`${o.iso}-${o.code}`}
                    /* Command filters on `value` — combine name + code so a
                       user can type either to find the row. */
                    value={`${o.name} ${o.code} ${o.label} ${o.iso}`}
                    onSelect={() => { commit(o.code, number); setOpen(false); }}
                  >
                    <Check className={`me-2 h-3.5 w-3.5 ${o.code === activeCode ? 'opacity-100' : 'opacity-0'}`} />
                    <img
                      src={`https://flagcdn.com/w20/${o.iso.toLowerCase()}.png`}
                      width={20}
                      height={15}
                      alt=""
                      className="inline-block rounded-sm me-2"
                    />
                    <span className="font-mono text-xs w-12 shrink-0">{o.code}</span>
                    <span className="text-muted-foreground truncate">{o.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        value={number}
        onChange={(e) => commit(activeCode, e.target.value)}
        placeholder={inputPlaceholder}
        disabled={disabled}
        required={required}
        className="flex-1"
      />
    </div>
  );
}
