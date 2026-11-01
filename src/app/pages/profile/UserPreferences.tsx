import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Separator } from '../../components/ui/separator';
import { toast } from 'sonner';
import { usersApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';

const LANGUAGE_OPTIONS = [
  'English', 'Arabic', 'Polish', 'German', 'French',
  'Spanish', 'Italian', 'Romanian', 'Ukrainian',
] as const;

const TIMEZONE_OPTIONS = [
  'UTC',
  'Europe/London', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/Paris',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Bucharest', 'Europe/Kiev',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'Asia/Dubai', 'Asia/Riyadh',
] as const;

const NOTIFICATION_OPTIONS = [
  { key: 'emailNotifications', label: 'Email notifications', description: 'Receive notifications via email' },
  { key: 'inAppNotifications', label: 'In-app notifications', description: 'Show notifications within the platform' },
  { key: 'documentExpiryAlerts', label: 'Document expiry alerts', description: 'Get alerted when documents are about to expire' },
  { key: 'complianceAlerts', label: 'Compliance alerts', description: 'Notifications about compliance issues' },
  { key: 'taskReminders', label: 'Task reminders', description: 'Reminders for pending tasks and actions' },
  { key: 'workflowUpdates', label: 'Workflow updates', description: 'Receive updates on workflow stage changes' },
  { key: 'systemUpdates', label: 'System updates', description: 'Information about platform updates and maintenance' },
];

export function UserPreferences() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    preferredLanguage: 'English',
    timeZone: 'Europe/London',
    emailNotifications: true,
    inAppNotifications: true,
    documentExpiryAlerts: true,
    complianceAlerts: true,
    taskReminders: true,
    workflowUpdates: false,
    systemUpdates: false,
  });

  // Map common DB-stored values (e.g. legacy "en" / "UTC") onto the
  // human-readable values our SelectItems use. Without this, the Select
  // value won't match any item and the dropdown appears empty.
  const LANGUAGE_ALIASES: Record<string, string> = {
    en: 'English', ar: 'Arabic', pl: 'Polish', de: 'German', fr: 'French',
    es: 'Spanish', it: 'Italian', ro: 'Romanian', uk: 'Ukrainian',
  };
  const normalizeLanguage = (v: any) => (typeof v === 'string' && LANGUAGE_ALIASES[v]) || v;
  const normalizeTimeZone = (v: any) => (v === 'UTC' || !v ? 'UTC' : v);

  useEffect(() => {
    usersApi.me()
      .then((user: any) => {
        setForm(prev => ({
          ...prev,
          preferredLanguage: normalizeLanguage(user.preferredLanguage) || prev.preferredLanguage,
          timeZone: normalizeTimeZone(user.timeZone) || prev.timeZone,
          // The DB column is `notificationPrefs` — keep both names so old
          // payloads still work.
          ...((user.notificationPrefs ?? user.notificationPreferences) ?? {}),
        }));
      })
      .catch(() => toast.error(tc('toast.loadFailed')))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { preferredLanguage, timeZone, ...notificationPrefs } = form;
      // Send the field as `notificationPrefs` (matches the DTO + DB column).
      const updated: any = await usersApi.updatePreferences({
        preferredLanguage,
        timeZone,
        notificationPrefs,
      });
      // Re-sync the form from the server response so the UI reflects what
      // was actually persisted (instead of trusting local state).
      if (updated) {
        setForm(prev => ({
          ...prev,
          preferredLanguage: normalizeLanguage(updated.preferredLanguage) || prev.preferredLanguage,
          timeZone: normalizeTimeZone(updated.timeZone) || prev.timeZone,
          ...((updated.notificationPrefs ?? updated.notificationPreferences) ?? {}),
        }));
      }
      toast.success(tc('toast.savedSuccessfully'));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/profile"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('profile.preferences.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('profile.preferences.subtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSave}>
        <div className="max-w-2xl space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Localisation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{t('profile.preferences.language')}</Label>
                <Select value={form.preferredLanguage} onValueChange={val => setForm(prev => ({ ...prev, preferredLanguage: val }))}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('profile.preferences.languagePh')} />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_OPTIONS.map(code => (
                      <SelectItem key={code} value={code}>{t(`profile.preferences.languages.${code}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{t('profile.preferences.timezone')}</Label>
                <Select value={form.timeZone} onValueChange={val => setForm(prev => ({ ...prev, timeZone: val }))}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('profile.preferences.timezonePh')} />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONE_OPTIONS.map(tz => (
                      <SelectItem key={tz} value={tz}>{t(`profile.preferences.timezones.${tz}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('profile.preferences.notificationPreferences')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h4 className="text-sm font-medium text-[#0F172A] mb-3">{t('profile.preferences.channels')}</h4>
                {NOTIFICATION_OPTIONS.slice(0, 2).map(({ key, label, description }) => (
                  <div key={key} className="flex items-start gap-3 mb-3">
                    <input
                      type="checkbox"
                      id={key}
                      checked={form[key as keyof typeof form] as boolean}
                      onChange={(e) => setForm(prev => ({ ...prev, [key]: e.target.checked }))}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-[#2563EB] focus:ring-[#2563EB]"
                    />
                    <div>
                      <label htmlFor={key} className="text-sm font-medium cursor-pointer">{label}</label>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                  </div>
                ))}
              </div>
              <Separator />
              <div>
                <h4 className="text-sm font-medium text-[#0F172A] mb-3">{t('profile.preferences.notificationTypes')}</h4>
                {NOTIFICATION_OPTIONS.slice(2).map(({ key, label, description }) => (
                  <div key={key} className="flex items-start gap-3 mb-3">
                    <input
                      type="checkbox"
                      id={key}
                      checked={form[key as keyof typeof form] as boolean}
                      onChange={(e) => setForm(prev => ({ ...prev, [key]: e.target.checked }))}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-[#2563EB] focus:ring-[#2563EB]"
                    />
                    <div>
                      <label htmlFor={key} className="text-sm font-medium cursor-pointer">{label}</label>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="submit" className="flex-1 bg-[#2563EB] hover:bg-[#1d4ed8]" disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 me-2 animate-spin" />{t('profile.preferences.saving')}</> : t('profile.preferences.save')}
            </Button>
            <Button type="button" variant="outline" className="flex-1" asChild>
              <Link to="/dashboard/profile">{t('profile.preferences.cancel')}</Link>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
