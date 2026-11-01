import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save, RefreshCw, Server, Users, Briefcase, UserCheck, Building2 } from 'lucide-react';
import { usePermissions } from '../../hooks/usePermissions';
import { API_URL } from '../../services/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Shield } from 'lucide-react';

interface SystemInfoForm {
  version: string;
  organizationName: string;
  contactEmail: string;
  supportPhone: string;
  address: string;
  website: string;
  lastUpdated: string;
}

interface SystemStats {
  totalUsers: number;
  totalEmployees: number;
  totalApplicants: number;
  totalAgencies: number;
  databaseStatus: string;
}

async function fetchJson(path: string, token: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function SystemInformation() {
  const { t } = useTranslation('pages');
  const { canEdit } = usePermissions();
  const isAdmin = canEdit('settings');

  const [form, setForm] = useState<SystemInfoForm>({
    version: '',
    organizationName: '',
    contactEmail: '',
    supportPhone: '',
    address: '',
    website: '',
    lastUpdated: '',
  });
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = localStorage.getItem('access_token') ?? '';

  const loadInfo = async () => {
    setLoading(true);
    try {
      const data = await fetchJson('/settings/system-info', token);
      setForm({
        version: data.version ?? '',
        organizationName: data.organizationName ?? '',
        contactEmail: data.contactEmail ?? '',
        supportPhone: data.supportPhone ?? '',
        address: data.address ?? '',
        website: data.website ?? '',
        lastUpdated: data.lastUpdated ?? '',
      });
    } catch {
      setError('Failed to load system information');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    setStatsLoading(true);
    try {
      const data = await fetchJson('/settings/system-stats', token);
      setStats(data);
    } catch {
      // stats are non-critical
    } finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    loadInfo();
    loadStats();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await fetchJson('/settings/system-info', token, {
        method: 'PATCH',
        body: JSON.stringify(form),
      });
      setForm({
        version: updated.version ?? '',
        organizationName: updated.organizationName ?? '',
        contactEmail: updated.contactEmail ?? '',
        supportPhone: updated.supportPhone ?? '',
        address: updated.address ?? '',
        website: updated.website ?? '',
        lastUpdated: updated.lastUpdated ?? '',
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Failed to save system information');
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="p-8 flex items-center justify-center min-h-64">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto text-red-500 mb-3 opacity-60" />
          <h2 className="text-lg font-semibold mb-1">{t('settings.systemInformation.accessDenied')}</h2>
          <p className="text-muted-foreground text-sm">{t('settings.systemInformation.accessDeniedBody')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/dashboard/settings">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 me-2" />
            {t('settings.systemInformation.backToSettings')}
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-foreground">{t('settings.systemInformation.headerTitle')}</h1>
          <p className="text-muted-foreground mt-1">{t('settings.systemInformation.headerSubtitle')}</p>
        </div>
      </div>

      {/* Live Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                <Users className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('settings.systemInformation.statTotalUsers')}</p>
                <p className="text-2xl font-semibold">
                  {statsLoading ? '…' : (stats?.totalUsers ?? '—')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
                <Briefcase className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('settings.systemInformation.statTotalEmployees')}</p>
                <p className="text-2xl font-semibold">
                  {statsLoading ? '…' : (stats?.totalEmployees ?? '—')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
                <UserCheck className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('settings.systemInformation.statTotalApplicants')}</p>
                <p className="text-2xl font-semibold">
                  {statsLoading ? '…' : (stats?.totalApplicants ?? '—')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('settings.systemInformation.statTotalAgencies')}</p>
                <p className="text-2xl font-semibold">
                  {statsLoading ? '…' : (stats?.totalAgencies ?? '—')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* DB Status */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <Server className="w-5 h-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t('settings.systemInformation.databaseStatus')}</span>
            <Badge className="bg-green-500 text-white">
              {statsLoading ? 'Checking…' : (stats?.databaseStatus ?? 'Unknown')}
            </Badge>
            <Button variant="ghost" size="sm" onClick={loadStats} disabled={statsLoading}>
              <RefreshCw className={`w-4 h-4 ${statsLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Editable Fields */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.systemInformation.systemDetailsTitle')}</CardTitle>
          <CardDescription>{t('settings.systemInformation.systemDetailsDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}
          {loading ? (
            <p className="text-muted-foreground text-sm">{t('settings.systemInformation.loading')}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="version">{t('settings.systemInformation.labelSystemVersion')}</Label>
                  <Input
                    id="version"
                    value={form.version}
                    onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
                    placeholder="e.g. v2.4.0"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lastUpdated">{t('settings.systemInformation.labelLastUpdated')}</Label>
                  <Input
                    id="lastUpdated"
                    value={form.lastUpdated}
                    onChange={(e) => setForm((f) => ({ ...f, lastUpdated: e.target.value }))}
                    placeholder="e.g. April 6, 2026"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="organizationName">{t('settings.systemInformation.labelOrganizationName')}</Label>
                  <Input
                    id="organizationName"
                    value={form.organizationName}
                    onChange={(e) => setForm((f) => ({ ...f, organizationName: e.target.value }))}
                    placeholder="e.g. TempWorks Europe"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contactEmail">{t('settings.systemInformation.labelContactEmail')}</Label>
                  <Input
                    id="contactEmail"
                    type="email"
                    value={form.contactEmail}
                    onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
                    placeholder="e.g. admin@tempworks.eu"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="supportPhone">{t('settings.systemInformation.labelSupportPhone')}</Label>
                  <Input
                    id="supportPhone"
                    value={form.supportPhone}
                    onChange={(e) => setForm((f) => ({ ...f, supportPhone: e.target.value }))}
                    placeholder="e.g. +44 20 1234 5678"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="website">{t('settings.systemInformation.labelWebsite')}</Label>
                  <Input
                    id="website"
                    value={form.website}
                    onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                    placeholder="e.g. https://tempworks.eu"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="address">{t('settings.systemInformation.labelAddress')}</Label>
                <Input
                  id="address"
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  placeholder="e.g. 123 Business Park, London, UK"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t">
                {saved && <span className="text-sm text-green-600 font-medium">{t('settings.systemInformation.savedSuccess')}</span>}
                <Button onClick={handleSave} disabled={saving}>
                  <Save className="w-4 h-4 me-2" />
                  {saving ? t('settings.systemInformation.saving') : t('settings.systemInformation.saveChanges')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
