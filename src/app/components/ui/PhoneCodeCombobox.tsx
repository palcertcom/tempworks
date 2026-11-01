/** Stand-alone country dial-code picker (Phase 3 #7).
 *
 *  The applicant/candidate forms keep their dial code in a separate
 *  `phoneCode` field, so they can't reuse the full <PhoneInput>. This
 *  combobox is the same searchable Popover+Command pattern, but it
 *  emits only the dial code string — drop-in replacement for the
 *  inline <Select> blocks the forms were using.
 */
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverTrigger, PopoverContent } from './popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from './command';
import { Button } from './button';
import { ChevronDown, Check } from 'lucide-react';
import { PHONE_CODES } from '../../data/phoneCodes';
import { countryName } from '../../../i18n/formatters';

interface Props {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  placeholder?: string;
}

export function PhoneCodeCombobox({
  value, onChange, disabled, className, id, placeholder,
}: Props) {
  const { t } = useTranslation('ui');
  const [open, setOpen] = useState(false);
  const iso = PHONE_CODES.find(p => p.code === value)?.iso ?? '';
  const options = useMemo(
    () => PHONE_CODES.map(c => ({ code: c.code, iso: c.iso, label: c.label, name: countryName(c.iso, c.label) })),
    [],
  );

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={t('phone.code', { defaultValue: 'Country code' })}
          disabled={disabled}
          className={`justify-between font-normal ${className ?? 'w-32 shrink-0'}`}
        >
          {value ? (
            <span className="inline-flex items-center gap-2 truncate">
              {iso && (
                <img src={`https://flagcdn.com/w20/${iso.toLowerCase()}.png`} width={20} height={15} alt="" className="inline-block rounded-sm" />
              )}
              <span className="font-mono text-xs">{value}</span>
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">{placeholder ?? t('phone.code')}</span>
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
                  value={`${o.name} ${o.code} ${o.label} ${o.iso}`}
                  onSelect={() => { onChange(o.code); setOpen(false); }}
                >
                  <Check className={`me-2 h-3.5 w-3.5 ${o.code === value ? 'opacity-100' : 'opacity-0'}`} />
                  <img src={`https://flagcdn.com/w20/${o.iso.toLowerCase()}.png`} width={20} height={15} alt="" className="inline-block rounded-sm me-2" />
                  <span className="font-mono text-xs w-12 shrink-0">{o.code}</span>
                  <span className="text-muted-foreground truncate">{o.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
