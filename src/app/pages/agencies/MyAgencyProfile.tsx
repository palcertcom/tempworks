/**
 * "Agency Profile" entry from the user menu. Redirects the signed-in
 * user to their own agency profile so the URL for self-service stays
 * stable as /dashboard/my-agency.
 *
 * Users without an agency attachment (e.g. some admin accounts) see
 * a friendly notice instead of a redirect loop.
 */
import { Navigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { getCurrentUser } from '../../services/api';

export function MyAgencyProfile() {
  const { t } = useTranslation('pages');
  const agencyId = getCurrentUser()?.agencyId;

  if (!agencyId) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold text-[#0F172A]">{t('agencies.myProfile.title')}</h1>
        <p className="text-muted-foreground mt-2">
          {t('agencies.myProfile.notAttached')}
        </p>
      </div>
    );
  }

  return <Navigate to={`/dashboard/agencies/${agencyId}`} replace />;
}
