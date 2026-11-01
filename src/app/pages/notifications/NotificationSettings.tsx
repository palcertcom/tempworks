import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save, Loader2, Bell, Mail, MessageSquare, Info, Clock, Send, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Switch } from '../../components/ui/switch';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Separator } from '../../components/ui/separator';
import { notificationsApi } from '../../services/api';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { toast } from 'sonner';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChannelPrefs {
  in_app: boolean;
  email:  boolean;
  sms:    boolean;
}

interface EventMeta {
  key:         string;
  label:       string;
  description: string;
  category:    string;
}

// ── Channel header cell ───────────────────────────────────────────────────────

function ChannelHeader({ icon, label, sub }: { icon: React.ReactNode; label: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-[72px]">
      <div className="text-muted-foreground">{icon}</div>
      <span className="text-xs font-medium">{label}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function NotificationSettings() {
  const { t } = useTranslation('pages');
  const [meta, setMeta]     = useState<EventMeta[]>([]);
  const [prefs, setPrefs]   = useState<Record<string, ChannelPrefs>>({});
  const [loading, setLoading]   = useState(true);
  const [saving,  setSaving]    = useState(false);
  const [dirty,   setDirty]     = useState(false);

  // SUPER-user-only daily document digest controls.
  const { isPlatformSuper } = useSuperUserTenantFilter();
  const [digestTime, setDigestTime]       = useState('08:00'); // HH:MM
  const [digestTz, setDigestTz]           = useState('Europe/Bratislava');
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [sendingMe, setSendingMe]         = useState(false);
  const [sendingAll, setSendingAll]       = useState(false);

  useEffect(() => {
    if (!isPlatformSuper) return;
    notificationsApi.adminGetDigestSchedule()
      .then((s) => {
        const hh = String(s.hour ?? 8).padStart(2, '0');
        const mm = String(s.minute ?? 0).padStart(2, '0');
        setDigestTime(`${hh}:${mm}`);
        if (s.timezone) setDigestTz(s.timezone);
      })
      .catch(() => { /* non-fatal: keep defaults */ })
      .finally(() => setScheduleLoaded(true));
  }, [isPlatformSuper]);

  const handleSaveSchedule = async () => {
    const [hStr, mStr] = digestTime.split(':');
    const hour = Number(hStr);
    const minute = Number(mStr);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      toast.error(t('notifications.digest.invalidTime', { defaultValue: 'Enter a valid time (HH:MM).' }));
      return;
    }
    setSavingSchedule(true);
    try {
      await notificationsApi.adminSetDigestSchedule({ hour, minute, timezone: digestTz });
      toast.success(t('notifications.digest.scheduleSaved', { defaultValue: 'Daily digest schedule saved' }));
    } catch (e: any) {
      toast.error(e?.message || t('notifications.digest.scheduleFailed', { defaultValue: 'Failed to save schedule' }));
    } finally {
      setSavingSchedule(false);
    }
  };

  const summarise = (r: { emailsSent: number; recipients: number; rows: number }) =>
    t('notifications.digest.sentSummary', {
      defaultValue: '{{emails}} email(s) sent · {{rows}} item(s) · {{recipients}} recipient(s)',
      emails: r.emailsSent, rows: r.rows, recipients: r.recipients,
    });

  const handleSendMe = async () => {
    setSendingMe(true);
    try {
      const r = await notificationsApi.adminDigestSendMe();
      r.emailsSent > 0
        ? toast.success(`${t('notifications.digest.sentMe', { defaultValue: 'Digest sent to you' })} — ${summarise(r)}`)
        : toast.info(t('notifications.digest.nothingPending', { defaultValue: 'No pending document notifications for you.' }));
    } catch (e: any) {
      toast.error(e?.message || t('notifications.digest.sendFailed', { defaultValue: 'Failed to send digest' }));
    } finally {
      setSendingMe(false);
    }
  };

  const handleSendAll = async () => {
    setSendingAll(true);
    try {
      const r = await notificationsApi.adminDigestSendAll();
      r.emailsSent > 0
        ? toast.success(`${t('notifications.digest.sentAll', { defaultValue: 'Digest sent to all recipients' })} — ${summarise(r)}`)
        : toast.info(t('notifications.digest.nothingPendingAll', { defaultValue: 'No pending document notifications to send.' }));
    } catch (e: any) {
      toast.error(e?.message || t('notifications.digest.sendFailed', { defaultValue: 'Failed to send digest' }));
    } finally {
      setSendingAll(false);
    }
  };

  useEffect(() => {
    notificationsApi.getPreferences()
      .then((data: any) => {
        const { meta: m, ...rest } = data;
        setMeta(Array.isArray(m) ? m : []);
        // rest keys are event type strings mapped to ChannelPrefs
        const prefMap: Record<string, ChannelPrefs> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (k !== 'meta' && typeof v === 'object' && v !== null) {
            prefMap[k] = v as ChannelPrefs;
          }
        }
        setPrefs(prefMap);
      })
      .catch(() => toast.error(t('notifications.toast.loadPrefsFailed')))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (eventKey: string, channel: 'in_app' | 'email') => {
    setPrefs(prev => ({
      ...prev,
      [eventKey]: {
        ...(prev[eventKey] ?? { in_app: true, email: false, sms: false }),
        [channel]: !(prev[eventKey]?.[channel] ?? false),
      },
    }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await notificationsApi.updatePreferences(prefs);
      setDirty(false);
      toast.success(t('notifications.toast.savePrefsSuccess'));
    } catch {
      toast.error(t('notifications.toast.savePrefsFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Group meta by category
  const categories = [...new Set(meta.map(m => m.category))];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/notifications"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('notifications.settings.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('notifications.settings.subtitle')}</p>
        </div>
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Save className="w-4 h-4 me-2" />}
          {saving ? 'Saving…' : 'Save Changes'}
        </Button>
      </div>

      {/* Info banner */}
      <Card className="border-blue-200 bg-blue-50 dark:bg-blue-950/20">
        <CardContent className="p-4 flex items-start gap-3">
          <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-blue-700 dark:text-blue-300">
            <strong>In-App</strong> — shown in your Notifications inbox.&nbsp;
            <strong>Email</strong> — sent to your account email.&nbsp;
            <strong>SMS</strong> — not yet available (coming soon).
          </div>
        </CardContent>
      </Card>

      {/* SUPER-user-only: daily document digest controls */}
      {isPlatformSuper && (
        <Card className="border-amber-200 bg-amber-50/40 dark:bg-amber-950/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4" />
              {t('notifications.digest.title', { defaultValue: 'Daily Document Digest' })}
              <Badge variant="outline" className="text-[10px] uppercase">{t('notifications.digest.superOnly', { defaultValue: 'Super User' })}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('notifications.digest.help', {
                defaultValue: 'Document notifications (expiring soon, expired, rejected) are consolidated into one daily email. Choose when the scheduled digest is sent, or trigger it manually below.',
              })}
            </p>

            {/* Schedule */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.digest.timeLabel', { defaultValue: 'Daily send time' })}</Label>
                <Input
                  type="time"
                  className="h-9 w-32"
                  value={digestTime}
                  disabled={!scheduleLoaded}
                  onChange={e => setDigestTime(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.digest.tzLabel', { defaultValue: 'Timezone' })}</Label>
                <Input
                  className="h-9 w-56"
                  value={digestTz}
                  disabled={!scheduleLoaded}
                  onChange={e => setDigestTz(e.target.value)}
                  placeholder="Europe/Bratislava"
                />
              </div>
              <Button onClick={handleSaveSchedule} disabled={savingSchedule || !scheduleLoaded}>
                {savingSchedule ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Save className="w-4 h-4 me-2" />}
                {t('notifications.digest.saveSchedule', { defaultValue: 'Save Schedule' })}
              </Button>
            </div>

            <Separator />

            {/* Manual triggers */}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={handleSendMe} disabled={sendingMe}>
                {sendingMe ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Send className="w-4 h-4 me-2" />}
                {t('notifications.digest.sendMe', { defaultValue: 'Send Me' })}
              </Button>
              <Button variant="outline" onClick={handleSendAll} disabled={sendingAll}>
                {sendingAll ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Users className="w-4 h-4 me-2" />}
                {t('notifications.digest.sendAll', { defaultValue: 'Send All' })}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('notifications.digest.triggerHelp', {
                  defaultValue: 'Send Me delivers your own pending digest now; Send All runs the full scheduled digest for every recipient.',
                })}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Matrix */}
      {categories.map(category => {
        const items = meta.filter(m => m.category === category);
        return (
          <Card key={category}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{category} Notifications</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {/* Column headers */}
              <div className="flex items-center border-b px-6 py-3 bg-muted/30">
                <div className="flex-1" />
                <div className="flex items-center gap-6">
                  <ChannelHeader icon={<Bell className="w-4 h-4" />} label="In-App" />
                  <ChannelHeader icon={<Mail className="w-4 h-4" />} label="Email" />
                  <ChannelHeader
                    icon={<MessageSquare className="w-4 h-4 opacity-40" />}
                    label="SMS"
                    sub="Soon"
                  />
                </div>
              </div>

              {/* Rows */}
              {items.map((evt, idx) => {
                const p = prefs[evt.key] ?? { in_app: true, email: false, sms: false };
                return (
                  <div key={evt.key}>
                    <div className="flex items-center px-6 py-4">
                      <div className="flex-1 min-w-0 pe-4">
                        <p className="text-sm font-medium">{evt.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{evt.description}</p>
                      </div>
                      <div className="flex items-center gap-6">
                        {/* In-App toggle */}
                        <div className="min-w-[72px] flex justify-center">
                          <Switch
                            checked={p.in_app}
                            onCheckedChange={() => toggle(evt.key, 'in_app')}
                          />
                        </div>
                        {/* Email toggle */}
                        <div className="min-w-[72px] flex justify-center">
                          <Switch
                            checked={p.email}
                            onCheckedChange={() => toggle(evt.key, 'email')}
                          />
                        </div>
                        {/* SMS — always disabled */}
                        <div className="min-w-[72px] flex justify-center">
                          <Switch checked={false} disabled />
                        </div>
                      </div>
                    </div>
                    {idx < items.length - 1 && <Separator />}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })}

      {/* Empty state */}
      {meta.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Bell className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No notification types configured.</p>
        </div>
      )}

      {/* Save footer */}
      {dirty && (
        <div className="sticky bottom-4 flex justify-end">
          <div className="bg-card border rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{t('notifications.settings.unsavedChanges')}</span>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 me-1.5 animate-spin" /> : <Save className="w-4 h-4 me-1.5" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
