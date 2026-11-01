import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentUser, tenantsApi } from '../../services/api';
import { Label } from './label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

/** True only for platform SUPER users — the sole level allowed to
 *  reassign a record's tenant from an edit screen. */
export function isSuperUser(): boolean {
  return (getCurrentUser() as any)?.platformAdmin?.level === 'SUPER';
}

/**
 * SUPER-USER-only tenant reassignment field for the Applicant / Candidate
 * / Employee edit screens. Renders nothing for non-SUPER users. The
 * backend re-checks SUPER and ignores the value otherwise, so this is a
 * UI affordance only — never the enforcement.
 *
 * `value` is the record's current tenantId ('' when unassigned); a blank
 * selection is treated by the backend as "no change" (never nulls).
 */
export function SuperUserTenantField({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation('pages');
  const isSuper = isSuperUser();
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!isSuper) return;
    tenantsApi.list({ limit: 500 })
      .then((res: any) => {
        const rows = Array.isArray(res?.data) ? res.data : [];
        setOptions(rows.map((r: any) => ({ id: r.id, name: r.name })));
      })
      .catch(() => { /* keep current value as the only option */ });
  }, [isSuper]);

  if (!isSuper) return null;

  return (
    <div className="space-y-2">
      <Label htmlFor="tenantId">{t('tenantFilter.tenant', { defaultValue: 'Tenant' })}</Label>
      <Select value={value || '__none__'} onValueChange={v => onChange(v === '__none__' ? '' : v)}>
        <SelectTrigger id="tenantId">
          <SelectValue placeholder={t('tenantFilter.filterByTenant', { defaultValue: 'Select tenant' })} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('tenantFilter.none', { defaultValue: 'No tenant' })}</SelectItem>
          {options.map(o => (
            <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {t('tenantFilter.editHelp', { defaultValue: 'SUPER USER only — reassigns this record to a tenant.' })}
      </p>
    </div>
  );
}
