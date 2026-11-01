/** Reusable structured address block.
 *  Standard address format used across the entire site:
 *    Address Line 1, Address Line 2, Country, City, Zip Code
 */
import { useTranslation } from 'react-i18next';
import { Label } from './label';
import { Input } from './input';
import { CountrySelect } from './CountrySelect';

export interface AddressData {
  line1: string;
  line2: string;
  country: string;
  city: string;
  zip: string;
}

export const EMPTY_ADDRESS: AddressData = { line1: '', line2: '', country: '', city: '', zip: '' };

interface Props {
  label?: string;
  value: AddressData;
  onChange: (data: AddressData) => void;
  required?: boolean;
  disabled?: boolean;
}

export function AddressForm({ label, value, onChange, required = false, disabled = false }: Props) {
  const { t } = useTranslation('ui');
  // Defensive: callers occasionally pass `undefined` (e.g. an applicant
  // edit page hydrated from a record whose abroadAddress / currentAddress
  // was never filled in). Fall back to an empty shape so reading the
  // first input doesn't blow up the whole route with "Cannot read
  // properties of undefined (reading 'line1')".
  const safe: AddressData = value ?? { ...EMPTY_ADDRESS };
  const set = (field: keyof AddressData) => (v: string) => onChange({ ...safe, [field]: v });
  const star = required ? ' *' : '';

  return (
    <div className="space-y-3">
      {label && <p className="text-sm font-semibold text-gray-700">{label}</p>}
      <div className="grid md:grid-cols-2 gap-3">
        <div className="space-y-1 md:col-span-2">
          <Label className="text-xs">{t('address.line1')}{star}</Label>
          <Input
            placeholder={t('address.line1Placeholder')}
            value={safe.line1 ?? ''}
            onChange={e => set('line1')(e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label className="text-xs">{t('address.line2')}</Label>
          <Input
            placeholder={t('address.line2Placeholder')}
            value={safe.line2 ?? ''}
            onChange={e => set('line2')(e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('address.country')}{star}</Label>
          <CountrySelect value={safe.country ?? ''} onChange={set('country')} required={required} disabled={disabled} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('address.city')}{star}</Label>
          <Input
            placeholder={t('address.cityPlaceholder')}
            value={safe.city ?? ''}
            onChange={e => set('city')(e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('address.zip')}{star}</Label>
          <Input
            placeholder={t('address.zip')}
            value={safe.zip ?? ''}
            onChange={e => set('zip')(e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}
