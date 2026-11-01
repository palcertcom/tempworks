import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

/**
 * SUPER USER tenant filter dropdown. Renders the "All Tenants" option
 * plus every tenant the platform admin may scope to. Empty value ('')
 * == All Tenants.
 *
 * Render only when the caller is a platform SUPER user (gate with
 * useSuperUserTenantFilter().isPlatformSuper).
 */
export function TenantFilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (id: string) => void;
  options: Array<{ id: string; name: string }>;
}) {
  const { t } = useTranslation('pages');
  return (
    <Select value={value || '__all__'} onValueChange={v => onChange(v === '__all__' ? '' : v)}>
      <SelectTrigger className="w-44" aria-label={t('tenantFilter.filterByTenant', { defaultValue: 'Filter by tenant' })}>
        <SelectValue placeholder={t('tenantFilter.allTenants', { defaultValue: 'All Tenants' })} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{t('tenantFilter.allTenants', { defaultValue: 'All Tenants' })}</SelectItem>
        {options.map(o => (
          <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
