import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Shield, Trash2, Eye, CheckCircle2, XCircle,
  RefreshCw, ArrowLeft,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { Label } from '../../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { recycleBinApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CleanupPreview {
  willRemove: Record<string, any>;
  willPreserve: {
    users: number;
    roles: string[];
    agencies: number;
    systemSettings: number;
    workflowStages: number;
    jobTypes: number;
    documentTypes: number;
    permissions: number;
  };
  totalToRemove: number;
}

interface CleanupResult {
  success: boolean;
  removed: Record<string, number>;
  preserved: Record<string, number>;
  warnings: string[];
}

const CONFIRM_PHRASE = 'CLEAN DATABASE';

// ── Component ─────────────────────────────────────────────────────────────────

export function DatabaseCleanup() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const { canDelete } = usePermissions();
  const isAdmin = canDelete('settings');

  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [secondConfirm, setSecondConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const [clearAuditLogs, setClearAuditLogs] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);

  // Only System Admin can access this page
  if (!isAdmin) {
    return (
      <div className="p-6 flex items-center justify-center min-h-64">
        <div className="text-center">
          <XCircle className="w-12 h-12 mx-auto text-red-500 mb-3" />
          <h2 className="text-lg font-semibold mb-1">{t('settings.databaseCleanup.accessDenied')}</h2>
          <p className="text-muted-foreground">{t('settings.databaseCleanup.accessDeniedBody')}</p>
        </div>
      </div>
    );
  }

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const data = await recycleBinApi.cleanupPreview();
      setPreview(data);
      setShowPreview(true);
    } catch {
      toast.error(tc('toast.loadFailed'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const openConfirmDialog = () => {
    setConfirmPhrase('');
    setSecondConfirm(false);
    setShowConfirmDialog(true);
  };

  const executeCleanup = async () => {
    if (confirmPhrase !== CONFIRM_PHRASE) {
      toast.error(tc('toast.typeExactly', { phrase: CONFIRM_PHRASE }));
      return;
    }
    if (!secondConfirm) {
      toast.error(tc('toast.secondConfirmationRequired'));
      return;
    }

    setExecuting(true);
    try {
      const res = await recycleBinApi.cleanupExecute({ confirmPhrase, reason, clearAuditLogs });
      setResult(res);
      setShowConfirmDialog(false);
      toast.success(tc('toast.savedSuccessfully'));
    } catch (e: any) {
      toast.error(apiError(e, tc('toast.operationFailed')));
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard/settings')}>
          <ArrowLeft className="w-4 h-4 me-1" />
          Back to Settings
        </Button>
      </div>

      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0">
          <Trash2 className="w-6 h-6 text-red-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('settings.databaseCleanup.headerTitle')}</h1>
          <p className="text-muted-foreground mt-1">
            Remove all business data while preserving System Admin and Super Admin users.
            This action is <strong className="text-red-600">irreversible</strong>.
          </p>
        </div>
      </div>

      {/* Warning Banner */}
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-800">
            <p className="font-semibold mb-2">{t('settings.databaseCleanup.destructiveWarning')}</p>
            <ul className="list-disc list-inside space-y-1">
              <li>All applicants, employees, documents, agencies, job ads, and financial records will be permanently deleted.</li>
              <li>All reports, notifications, workflows, and compliance data will be removed.</li>
              <li>Only System Admin and Super Admin users (and their required supporting data) will be preserved.</li>
              <li>This cannot be undone. Ensure you have a full database backup before proceeding.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* What Is Preserved */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="w-4 h-4 text-green-600" />
            What Will Be Preserved
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            {[
              { label: 'System Admin users', desc: 'All users with System Admin role' },
              { label: 'Super Admin users', desc: 'All users with Super Admin role' },
              { label: 'Admin roles & permissions', desc: 'Role definitions and permission mappings' },
              { label: 'System settings', desc: 'App configuration (branding, security, etc.)' },
              { label: 'Workflow stage definitions', desc: 'Stage configuration (not employee assignments)' },
              { label: 'Document type definitions', desc: 'Type catalog (not uploaded documents)' },
              { label: 'Job type definitions', desc: 'Job type catalog' },
              { label: 'Permissions catalog', desc: 'System permission definitions' },
            ].map(item => (
              <div key={item.label} className="flex items-start gap-2 p-2 bg-green-50 rounded">
                <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-green-900">{item.label}</p>
                  <p className="text-green-700 text-xs">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* What Will Be Removed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Trash2 className="w-4 h-4 text-red-600" />
            What Will Be Removed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            {[
              'All Applicants (leads, candidates) and their profiles',
              'All Employees and work history',
              'All uploaded Documents',
              'All Agencies (non-admin) and their user accounts',
              'All Job Ads',
              'All Financial Records and attachments',
              'All Compliance Alerts',
              'All Notifications and notification rules',
              'All Reports',
              'All Visas and Work Permits',
              'Identifier sequences (counters reset)',
              'Audit logs (optional)',
            ].map(item => (
              <div key={item} className="flex items-start gap-2 p-2 bg-red-50 rounded">
                <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <span className="text-red-800">{item}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Preview & Action Buttons */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={loadPreview} disabled={previewLoading}>
          {previewLoading ? <RefreshCw className="w-4 h-4 me-2 animate-spin" /> : <Eye className="w-4 h-4 me-2" />}
          Preview Impact
        </Button>
        <Button variant="destructive" onClick={openConfirmDialog}>
          <Trash2 className="w-4 h-4 me-2" />
          Execute Database Cleanup
        </Button>
      </div>

      {/* Preview Results */}
      {showPreview && preview && (
        <Card className="border-amber-200">
          <CardHeader>
            <CardTitle className="text-base text-amber-900">{t('settings.databaseCleanup.cleanupPreview')}</CardTitle>
            <CardDescription>
              ~{preview.totalToRemove.toLocaleString()} records will be permanently removed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h4 className="font-semibold text-sm mb-3 text-red-700">{t('settings.databaseCleanup.willRemove')}</h4>
                <div className="space-y-1">
                  {Object.entries(preview.willRemove).map(([key, count]) => (
                    <div key={key} className="flex justify-between text-sm py-1 border-b border-dashed">
                      <span className="capitalize text-muted-foreground">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                      <Badge variant="destructive" className="text-xs">{String(count)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="font-semibold text-sm mb-3 text-green-700">{t('settings.databaseCleanup.willPreserve')}</h4>
                <div className="space-y-1">
                  {[
                    ['Admin users', preview.willPreserve.users],
                    ['Admin agencies', preview.willPreserve.agencies],
                    ['Roles', preview.willPreserve.roles.join(', ')],
                    ['System settings', preview.willPreserve.systemSettings],
                    ['Workflow stages', preview.willPreserve.workflowStages],
                    ['Document types', preview.willPreserve.documentTypes],
                    ['Job types', preview.willPreserve.jobTypes],
                    ['Permissions', preview.willPreserve.permissions],
                  ].map(([key, val]) => (
                    <div key={String(key)} className="flex justify-between text-sm py-1 border-b border-dashed">
                      <span className="capitalize text-muted-foreground">{key}</span>
                      <Badge variant="secondary" className="text-xs">{String(val)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Success Result */}
      {result?.success && (
        <Card className="border-green-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-green-800">
              <CheckCircle2 className="w-5 h-5" />
              Cleanup Completed Successfully
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <h4 className="font-medium mb-2">{t('settings.databaseCleanup.recordsRemoved')}</h4>
                {Object.entries(result.removed).map(([k, v]) => (
                  <div key={k} className="flex justify-between py-0.5">
                    <span className="text-muted-foreground capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                    <span className="font-mono">{v}</span>
                  </div>
                ))}
              </div>
              <div>
                <h4 className="font-medium mb-2">{t('settings.databaseCleanup.preserved')}</h4>
                {Object.entries(result.preserved).map(([k, v]) => (
                  <div key={k} className="flex justify-between py-0.5">
                    <span className="text-muted-foreground capitalize">{k}</span>
                    <span className="font-mono">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            {result.warnings.length > 0 && (
              <div className="mt-3 space-y-1">
                {result.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-700 bg-amber-50 p-2 rounded">{w}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Confirmation Dialog ──────────────────────────────────────────── */}
      <Dialog open={showConfirmDialog} onOpenChange={open => { if (!open) setShowConfirmDialog(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Final Confirmation Required
            </DialogTitle>
            <DialogDescription>
              You are about to permanently delete all business data from this system. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
              <strong>Warning:</strong> Ensure you have a complete database backup before proceeding.
            </div>

            <div className="space-y-2">
              <Label className="text-sm">{t('settings.databaseCleanup.reasonOptional')}</Label>
              <Input
                placeholder="e.g. End of trial period, staging environment reset…"
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="clearAuditLogs"
                checked={clearAuditLogs}
                onChange={e => setClearAuditLogs(e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="clearAuditLogs" className="text-sm cursor-pointer">
                Also clear audit logs (default: audit logs are preserved)
              </Label>
            </div>

            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                id="secondConfirm"
                checked={secondConfirm}
                onChange={e => setSecondConfirm(e.target.checked)}
                className="w-4 h-4 mt-0.5"
              />
              <Label htmlFor="secondConfirm" className="text-sm cursor-pointer">
                I understand this action is irreversible and will permanently delete all business data.
              </Label>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">
                Type <code className="bg-muted px-1.5 py-0.5 rounded font-mono">{CONFIRM_PHRASE}</code> to confirm:
              </Label>
              <Input
                placeholder={CONFIRM_PHRASE}
                value={confirmPhrase}
                onChange={e => setConfirmPhrase(e.target.value)}
                className="font-mono"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirmDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={executing || confirmPhrase !== CONFIRM_PHRASE || !secondConfirm}
              onClick={executeCleanup}
            >
              {executing ? (
                <><RefreshCw className="w-4 h-4 me-2 animate-spin" />{t('settings.databaseCleanup.executing')}</>
              ) : (
                <><Trash2 className="w-4 h-4 me-2" />{t('settings.databaseCleanup.executeCleanup')}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
