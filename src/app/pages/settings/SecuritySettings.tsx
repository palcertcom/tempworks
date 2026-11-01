import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Shield, Lock, Save, Loader2, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { settingsApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';

const LOCKOUT_SETTING_KEY  = 'MAX_LOGIN_ATTEMPTS';
const IDLE_SETTING_KEY     = 'SESSION_IDLE_TIMEOUT_MINUTES';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_IDLE_MINUTES = 30;

function findSettingValue(grouped: Record<string, any[]> | null, key: string): string | null {
  if (!grouped) return null;
  for (const category of Object.values(grouped)) {
    const found = (category as any[]).find(s => s.key === key);
    if (found) return found.value ?? null;
  }
  return null;
}

export function SecuritySettings() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [loading, setLoading]               = useState(true);
  const [saving, setSaving]                 = useState(false);
  const [maxAttempts, setMaxAttempts]       = useState<string>(String(DEFAULT_MAX_ATTEMPTS));
  const [initialAttempts, setInitialAttempts] = useState<string>(String(DEFAULT_MAX_ATTEMPTS));

  const [savingIdle, setSavingIdle]         = useState(false);
  const [idleMinutes, setIdleMinutes]       = useState<string>(String(DEFAULT_IDLE_MINUTES));
  const [initialIdle, setInitialIdle]       = useState<string>(String(DEFAULT_IDLE_MINUTES));

  useEffect(() => {
    settingsApi.getAll(true)
      .then((grouped) => {
        const attempts = findSettingValue(grouped, LOCKOUT_SETTING_KEY) ?? String(DEFAULT_MAX_ATTEMPTS);
        const idle     = findSettingValue(grouped, IDLE_SETTING_KEY)    ?? String(DEFAULT_IDLE_MINUTES);
        setMaxAttempts(attempts);
        setInitialAttempts(attempts);
        setIdleMinutes(idle);
        setInitialIdle(idle);
      })
      .catch(() => toast.error(tc('toast.loadFailed')))
      .finally(() => setLoading(false));
  }, []);

  const handleSaveLockout = async () => {
    const n = parseInt(maxAttempts, 10);
    if (isNaN(n) || n < 1 || n > 20) {
      toast.error(t('settings.security.lockoutValidationError'));
      return;
    }
    setSaving(true);
    try {
      await settingsApi.update({ [LOCKOUT_SETTING_KEY]: String(n) });
      setInitialAttempts(String(n));
      toast.success(t('settings.security.lockoutUpdated'));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveIdle = async () => {
    const n = parseInt(idleMinutes, 10);
    if (isNaN(n) || n < 1 || n > 1440) {
      toast.error(t('settings.security.idleValidationError'));
      return;
    }
    setSavingIdle(true);
    try {
      await settingsApi.update({ [IDLE_SETTING_KEY]: String(n) });
      setInitialIdle(String(n));
      toast.success(t('settings.security.idleUpdated'));
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSavingIdle(false);
    }
  };

  const dirty = maxAttempts !== initialAttempts;
  const idleDirty = idleMinutes !== initialIdle;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/settings"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('settings.security.headerTitle')}</h1>
          <p className="text-muted-foreground mt-1">{t('settings.security.headerSubtitle')}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Lock className="w-5 h-5 text-[#2563EB]" />
            <CardTitle>{t('settings.security.lockoutCardTitle')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 max-w-sm">
            <Label htmlFor="max-attempts">{t('settings.security.lockoutLabel')}</Label>
            <div className="flex items-center gap-3">
              <Input
                id="max-attempts"
                type="number"
                min={1}
                max={20}
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                disabled={loading || saving}
                className="w-28"
              />
              <span className="text-sm text-muted-foreground">{t('settings.security.failedAttemptsSuffix')}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.security.lockoutHelper')}
            </p>
          </div>
          <Button onClick={handleSaveLockout} disabled={loading || saving || !dirty}>
            {saving ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Save className="w-4 h-4 me-2" />}
            {t('settings.security.saveThreshold')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-[#2563EB]" />
            <CardTitle>{t('settings.security.idleCardTitle')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 max-w-sm">
            <Label htmlFor="idle-minutes">{t('settings.security.idleLabel')}</Label>
            <div className="flex items-center gap-3">
              <Input
                id="idle-minutes"
                type="number"
                min={1}
                max={1440}
                value={idleMinutes}
                onChange={(e) => setIdleMinutes(e.target.value)}
                disabled={loading || savingIdle}
                className="w-28"
              />
              <span className="text-sm text-muted-foreground">{t('settings.security.idleMinutesSuffix')}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.security.idleHelper')}
            </p>
          </div>
          <Button onClick={handleSaveIdle} disabled={loading || savingIdle || !idleDirty}>
            {savingIdle ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Save className="w-4 h-4 me-2" />}
            {t('settings.security.saveTimeout')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.security.authCardTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="2fa">{t('settings.security.twoFactorLabel')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.security.twoFactorHelper')}</p>
            </div>
            <Switch id="2fa" defaultChecked />
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-timeout">{t('settings.security.sessionTimeoutLabel')}</Label>
            <Select defaultValue="30">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">{t('settings.security.sessionTimeout15')}</SelectItem>
                <SelectItem value="30">{t('settings.security.sessionTimeout30')}</SelectItem>
                <SelectItem value="60">{t('settings.security.sessionTimeout60')}</SelectItem>
                <SelectItem value="120">{t('settings.security.sessionTimeout120')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.security.accessControlTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="ip-restriction">{t('settings.security.ipRestrictionLabel')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.security.ipRestrictionHelper')}</p>
            </div>
            <Switch id="ip-restriction" />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="audit-log">{t('settings.security.auditLoggingLabel')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.security.auditLoggingHelper')}</p>
            </div>
            <Switch id="audit-log" defaultChecked />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-[#EFF6FF] border-[#2563EB]">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-[#2563EB]" />
            <CardTitle>{t('settings.security.statusCardTitle')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your system security is configured correctly. Last security audit: March 1, 2026
          </p>
        </CardContent>
      </Card>
    </div>
  );
}