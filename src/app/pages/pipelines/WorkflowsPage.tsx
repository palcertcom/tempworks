import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { useTranslation } from 'react-i18next';
import { workflowApi, usersApi } from '../../services/api';
import { confirm } from '../../components/ui/ConfirmDialog';
import { toast } from 'sonner';
import { apiError } from '../../../i18n/apiError';
import { ErrorBanner } from '../../components/ui/error-banner';
import {
  Layers,
  Plus,
  ChevronRight,
  Star,
  Archive,
  Users,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Flag,
  MoreVertical,
  Trash2,
  Settings2,
  Globe,
  Lock,
  Copy,
} from 'lucide-react';
import { formatDate } from '../../../i18n/formatters';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function WorkflowCard({
  workflow,
  stats,
  onSelect,
  onConfigure,
  onCopy,
  onArchive,
  onDelete,
  onManageAccess,
}: {
  workflow: any;
  stats: any;
  onSelect: () => void;
  onConfigure: () => void;
  onCopy: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onManageAccess: () => void;
}) {
  const { t } = useTranslation('pages');
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="bg-card border border-border rounded-xl p-5 hover:border-primary/40 hover:shadow-md transition-all cursor-pointer group relative"
      onClick={onSelect}
    >
      {/* Color stripe */}
      <div className="absolute top-0 start-0 end-0 h-1 rounded-t-xl" style={{ background: workflow.color }} />

      <div className="flex items-start justify-between mt-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {workflow.isDefault && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                <Star className="w-2.5 h-2.5" /> {t('pipelines.list.default')}
              </span>
            )}
            {workflow.status === 'ARCHIVED' && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-500 border border-slate-200">
                <Archive className="w-2.5 h-2.5" /> {t('pipelines.list.archived')}
              </span>
            )}
            {workflow.isPublic ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <Globe className="w-2.5 h-2.5" /> {t('pipelines.list.public')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-50 text-slate-700 border border-slate-200">
                <Lock className="w-2.5 h-2.5" /> {t('pipelines.list.private')}
              </span>
            )}
          </div>
          <h3 className="font-semibold text-foreground text-base leading-tight">{workflow.name}</h3>
          {workflow.description && (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{workflow.description}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 ms-3" onClick={(e) => e.stopPropagation()}>
          {/* Configure button — always visible on hover */}
          <button
            onClick={onConfigure}
            title={t('pipelines.list.configureStagesTitle')}
            className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Settings2 className="w-4 h-4" />
          </button>

          {/* More menu */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div className="absolute end-0 mt-1 w-40 bg-popover border border-border rounded-lg shadow-lg z-10 py-1" onMouseLeave={() => setMenuOpen(false)}>
                <button
                  onClick={() => { setMenuOpen(false); onConfigure(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted"
                >
                  <Settings2 className="w-3.5 h-3.5" /> {t('pipelines.list.configure')}
                </button>
                {!workflow.isPublic && (
                  <button
                    onClick={() => { setMenuOpen(false); onManageAccess(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted"
                  >
                    <Lock className="w-3.5 h-3.5" /> {t('pipelines.list.manageAccess')}
                  </button>
                )}
                <button
                  onClick={() => { setMenuOpen(false); onCopy(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted"
                >
                  <Copy className="w-3.5 h-3.5" /> {t('pipelines.list.duplicate')}
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onArchive(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted"
                >
                  <Archive className="w-3.5 h-3.5" /> {t('pipelines.list.archive')}
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onDelete(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="w-3.5 h-3.5" /> {t('pipelines.list.delete')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stage pills */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {(workflow.stages || []).slice(0, 5).map((s: any) => (
          <span
            key={s.id}
            className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
            style={{ background: s.color }}
          >
            {s.name}
          </span>
        ))}
        {(workflow.stages?.length ?? 0) > 5 && (
          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
            {t('pipelines.list.stagesMore', { count: workflow.stages.length - 5 })}
          </span>
        )}
        {(workflow.stages?.length ?? 0) === 0 && (
          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground italic">
            {t('pipelines.list.noStagesYet')}
          </span>
        )}
      </div>

      {/* Stats row */}
      <div className="mt-4 pt-4 border-t border-border flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {t('pipelines.list.activeCount', { count: stats?.totalActive ?? workflow._count?.assignments ?? 0 })}</span>
        <span className="flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> {t('pipelines.list.completedCount', { count: stats?.totalCompleted ?? 0 })}</span>
        {(stats?.flaggedCount ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-amber-600"><Flag className="w-3.5 h-3.5" /> {t('pipelines.list.flaggedCount', { count: stats.flaggedCount })}</span>
        )}
        {(stats?.slaBreached ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-red-600"><AlertTriangle className="w-3.5 h-3.5" /> {t('pipelines.list.slaBreachedCount', { count: stats.slaBreached })}</span>
        )}
      </div>

      {/* Open board CTA */}
      <div className="mt-3 flex items-center gap-1 text-xs text-primary font-medium opacity-0 group-hover:opacity-100 transition-opacity">
        {t('pipelines.list.openBoard')} <ChevronRight className="w-3.5 h-3.5" />
      </div>
    </div>
  );
}

// ─── Create workflow modal ─────────────────────────────────────────────────

function CreateWorkflowModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [form, setForm] = useState({ name: '', description: '', isDefault: false, isPublic: true, color: '#2563EB' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const colors = ['#2563EB', '#7C3AED', '#059669', '#D97706', '#DC2626', '#0891B2', '#BE185D', '#374151'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError(tc('form.fieldRequired')); return; }
    setSaving(true);
    try {
      const created = await workflowApi.create(form);
      onCreated(created.id);
      onClose();
    } catch (err: any) {
      setError(apiError(err, t('pipelines.errors.createFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        <h2 className="text-lg font-semibold text-foreground mb-1">{t('pipelines.list.newWorkflowTitle')}</h2>
        <p className="text-sm text-muted-foreground mb-4">{t('pipelines.list.newWorkflowBody')}</p>
        <ErrorBanner message={error} className="mb-3" />
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">{t('pipelines.list.nameRequired')}</label>
            <input
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('pipelines.list.namePlaceholder')}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">{t('pipelines.list.description')}</label>
            <textarea
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={t('pipelines.list.descriptionPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">{t('pipelines.list.color')}</label>
            <div className="flex gap-2 flex-wrap">
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm({ ...form, color: c })}
                  className="w-7 h-7 rounded-full border-2 transition-transform"
                  style={{ background: c, borderColor: form.color === c ? '#000' : 'transparent', transform: form.color === c ? 'scale(1.2)' : 'scale(1)' }}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} className="rounded" />
              <span className="text-foreground">{t('pipelines.list.setAsDefault')}</span>
            </label>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-border rounded-lg px-4 py-2 text-sm text-foreground hover:bg-muted transition-colors">{tc('actions.cancel')}</button>
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {saving ? t('pipelines.list.creating') : t('pipelines.list.createAndConfigure')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function WorkflowsPage() {
  const navigate = useNavigate();
  const tenantVersion = useTenantSyncVersion();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenant = useSuperUserTenantFilter();
  const { t } = useTranslation('pages');
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  // Manage-access dialog — null when closed. Holds the workflow
  // whose private-access list we're editing.
  const [accessWorkflow, setAccessWorkflow] = useState<any | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await workflowApi.list(showArchived, tenant.applyToParams({}));
      setWorkflows(data);
      const statsResults = await Promise.allSettled(data.map((p: any) => workflowApi.stats(p.id)));
      const map: Record<string, any> = {};
      statsResults.forEach((r, i) => {
        if (r.status === 'fulfilled') map[data[i].id] = r.value;
      });
      setStatsMap(map);
    } catch (err: any) {
      setError(apiError(err, t('pipelines.errors.loadWorkflowsFailed')));
    } finally {
      setLoading(false);
    }
  }, [showArchived, tenantVersion, tenant.tenantFilter]);

  useEffect(() => { load(); }, [load]);

  const handleArchive = async (id: string) => {
    try { await workflowApi.archive(id); load(); } catch {}
  };

  const handleCopy = async (workflow: any) => {
    if (!(await confirm({
      title: t('pipelines.confirm.duplicateTitle'),
      description: t('pipelines.confirm.duplicateBody', { name: workflow.name }),
      confirmText: t('pipelines.confirm.duplicateConfirm'),
    }))) return;
    try {
      const copied = await workflowApi.copy(workflow.id);
      toast.success(t('pipelines.toast.duplicated', { name: copied.name }));
      load();
    } catch (err: any) {
      toast.error(apiError(err, t('pipelines.errors.duplicateFailed')));
    }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirm({
      title: t('common:confirm.deleteWorkflowTitle'),
      description: t('common:confirm.deleteWorkflowBody'),
      confirmText: t('common:actions.delete'), tone: 'destructive',
    }))) return;
    try { await workflowApi.delete(id); load(); } catch {}
  };

  // After creation, go directly to the configuration page
  const handleCreated = (id: string) => {
    navigate(`/dashboard/settings/workflows/${id}`);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Layers className="w-6 h-6 text-primary" /> {t('pipelines.list.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('pipelines.list.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tenant.isPlatformSuper && (
            <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
          )}
          <button onClick={() => setShowArchived(!showArchived)} className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${showArchived ? 'bg-muted text-foreground border-border' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {showArchived ? t('pipelines.list.hideArchived') : t('pipelines.list.showArchived')}
          </button>
          <button onClick={load} className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" /> {t('pipelines.list.addButton')}
          </button>
        </div>
      </div>

      <ErrorBanner message={error} autoFocus={false} />

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-card border border-border rounded-xl p-5 animate-pulse">
              <div className="h-4 bg-muted rounded w-2/3 mb-3" />
              <div className="h-3 bg-muted rounded w-full mb-2" />
              <div className="h-3 bg-muted rounded w-4/5" />
            </div>
          ))}
        </div>
      ) : workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Layers className="w-16 h-16 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">{t('pipelines.list.noWorkflowsTitle')}</h3>
          <p className="text-sm text-muted-foreground mb-6">{t('pipelines.list.noWorkflowsBody')}</p>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" /> {t('pipelines.list.createWorkflow')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {workflows.map((p) => (
            <WorkflowCard
              key={p.id}
              workflow={p}
              stats={statsMap[p.id]}
              onSelect={() => navigate(`/dashboard/workflows/${p.id}`)}
              onConfigure={() => navigate(`/dashboard/settings/workflows/${p.id}`)}
              onCopy={() => handleCopy(p)}
              onArchive={() => handleArchive(p.id)}
              onDelete={() => handleDelete(p.id)}
              onManageAccess={() => setAccessWorkflow(p)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateWorkflowModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}

      {accessWorkflow && (
        <ManageAccessModal
          workflow={accessWorkflow}
          onClose={() => setAccessWorkflow(null)}
        />
      )}
    </div>
  );
}

// ─── Manage Access Modal ─────────────────────────────────────────────────────
// Shown for private workflows only. Admins add / remove users that
// are allowed to use the workflow for candidate assignments. The
// backend still persists the list even for public workflows, so
// toggling public ↔ private later preserves the previously-configured
// access without retyping.
function ManageAccessModal({
  workflow,
  onClose,
}: {
  workflow: any;
  onClose: () => void;
}) {
  const { t } = useTranslation('pages');
  const [access, setAccess] = useState<any[]>([]);
  const [users, setUsers]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [list, allUsers] = await Promise.all([
        workflowApi.listAccessUsers(workflow.id),
        usersApi.list({ limit: 500 }).then((r: any) => r?.data ?? []).catch(() => []),
      ]);
      setAccess(Array.isArray(list) ? list : []);
      setUsers(allUsers);
    } catch (err: any) {
      toast.error(apiError(err, t('pipelines.errors.loadAccessFailed')));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [workflow.id]);

  const accessIds = new Set(access.map(a => a.userId));
  const candidates = users.filter((u: any) =>
    !accessIds.has(u.id) &&
    !u.deletedAt &&
    (!search.trim() ||
      `${u.firstName ?? ''} ${u.lastName ?? ''} ${u.email ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())),
  );

  const handleAdd = async () => {
    if (!selectedUserId) return;
    setAdding(true);
    try {
      await workflowApi.addAccessUser(workflow.id, selectedUserId);
      toast.success(t('pipelines.toast.accessGranted'));
      setSelectedUserId('');
      load();
    } catch (err: any) {
      toast.error(apiError(err, t('pipelines.errors.grantFailed')));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (userId: string, name: string) => {
    const ok = await confirm({
      title: t('pipelines.confirm.revokeTitle'),
      description: t('pipelines.confirm.revokeBody', { name, workflow: workflow.name }),
      confirmText: t('pipelines.confirm.revokeConfirm'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await workflowApi.removeAccessUser(workflow.id, userId);
      toast.success(t('pipelines.toast.accessRevoked'));
      load();
    } catch (err: any) {
      toast.error(apiError(err, t('pipelines.errors.revokeFailed')));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl w-full max-w-xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Lock className="w-5 h-5 text-slate-600 shrink-0" />
            <div className="min-w-0">
              <h3 className="font-semibold text-base truncate">{t('pipelines.list.manageAccess')}</h3>
              <p className="text-xs text-muted-foreground truncate">
                {t('pipelines.list.usersAllowedTo')} <strong className="text-foreground">{workflow.name}</strong>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground">
            <Trash2 className="hidden" />
            <span aria-hidden>×</span>
          </button>
        </div>

        {/* Add user row */}
        <div className="p-5 border-b space-y-2">
          <label className="text-xs font-medium text-muted-foreground">{t('pipelines.list.addUser')}</label>
          <input
            type="text"
            placeholder={t('pipelines.list.searchUsersPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 rounded-md border bg-background text-sm"
          />
          <div className="flex items-center gap-2">
            <select
              className="flex-1 px-3 py-2 rounded-md border bg-background text-sm"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
            >
              <option value="">
                {candidates.length === 0 ? t('pipelines.list.noMatchingUsers') : t('pipelines.list.selectUserPlaceholder')}
              </option>
              {candidates.slice(0, 100).map((u: any) => (
                <option key={u.id} value={u.id}>
                  {[u.firstName, u.lastName].filter(Boolean).join(' ') || u.email}
                  {u.userNumber && ` · ${u.userNumber}`}
                  {u.email && ` · ${u.email}`}
                </option>
              ))}
            </select>
            <button
              onClick={handleAdd}
              disabled={!selectedUserId || adding}
              className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              <Plus className="w-4 h-4 inline me-1" />{adding ? t('pipelines.list.adding') : t('pipelines.list.add')}
            </button>
          </div>
        </div>

        {/* Current access list */}
        <div className="p-5 flex-1 overflow-y-auto">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            {loading ? t('pipelines.list.loading') : t('pipelines.list.currentAccess', { count: access.length })}
          </p>
          {!loading && access.length === 0 ? (
            <div className="text-sm text-muted-foreground italic py-4 text-center">
              {t('pipelines.list.noAccessYet')}
            </div>
          ) : (
            <ul className="divide-y">
              {access.map((a: any) => {
                const name = [a.user?.firstName, a.user?.lastName].filter(Boolean).join(' ') || a.user?.email || a.userId;
                return (
                  <li key={a.userId} className="flex items-center gap-3 py-2">
                    <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{name}</p>
                      {a.user?.email && <p className="text-xs text-muted-foreground truncate">{a.user.email}</p>}
                    </div>
                    <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                      {t('pipelines.list.grantedOn', { date: formatDate(a.grantedAt) })}
                    </span>
                    <button
                      onClick={() => handleRemove(a.userId, name)}
                      className="p-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50"
                      title={t('pipelines.list.revokeAccess')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="p-4 border-t flex justify-end">
          <button onClick={onClose} className="px-3 py-2 rounded-md border text-sm hover:bg-muted">
            {t('pipelines.list.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
