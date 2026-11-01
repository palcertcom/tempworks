import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { workflowApi } from '../../services/api';
import { apiError } from '../../../i18n/apiError';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import {
  ArrowLeft,
  Layers,
  RefreshCw,
  Flag,
  AlertTriangle,
  Clock,
  ChevronRight,
  MessageSquare,
  CheckCircle2,
  XCircle,
  Plus,
  BarChart2,
  Settings2,
} from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Progress } from '../../components/ui/progress';

// ─── Add Note Modal ───────────────────────────────────────────────────────────

function NoteModal({ progressId, onClose }: { progressId: string; onClose: () => void }) {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [content, setContent] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setSaving(true);
    try {
      await workflowApi.addNote(progressId, { content, isPrivate });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5">
        <h3 className="text-base font-semibold text-foreground mb-3">{t('pipelines.board.addNote')}</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <textarea
            className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            rows={4}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('pipelines.board.noteWritePlaceholder')}
            autoFocus
          />
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="rounded" />
            <span className="text-foreground">{t('pipelines.board.privateNote')}</span>
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition-colors">{tc('actions.cancel')}</button>
            <button type="submit" disabled={saving || !content.trim()} className="flex-1 bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {saving ? t('pipelines.board.saving') : t('pipelines.board.addNote')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Advance Stage Modal ──────────────────────────────────────────────────────

function AdvanceModal({ assignmentId, workflow, onClose, onAdvanced }: { assignmentId: string; workflow: any; onClose: () => void; onAdvanced: () => void }) {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [selectedStageId, setSelectedStageId] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStageId) return;
    setSaving(true);
    try {
      await workflowApi.advanceToStage(assignmentId, selectedStageId);
      onAdvanced();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5">
        <h3 className="text-base font-semibold text-foreground mb-3">{t('pipelines.board.advanceToStage')}</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            {workflow?.stages?.map((s: any) => (
              <label key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer hover:bg-muted transition-colors" style={{ borderColor: selectedStageId === s.id ? s.color : undefined }}>
                <input type="radio" name="stage" value={s.id} checked={selectedStageId === s.id} onChange={() => setSelectedStageId(s.id)} className="sr-only" />
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                <span className="text-sm text-foreground">{s.name}</span>
                {selectedStageId === s.id && <CheckCircle2 className="w-4 h-4 ms-auto" style={{ color: s.color }} />}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition-colors">{tc('actions.cancel')}</button>
            <button type="submit" disabled={saving || !selectedStageId} className="flex-1 bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {saving ? t('pipelines.board.advancing') : t('pipelines.board.advance')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Assign Candidate Modal ───────────────────────────────────────────────────

// Phase 2B (#41) — picker row shape returned by listUnassignedCandidates.
interface UnassignedCandidate {
  id: string; firstName: string; lastName: string;
  email: string; phone: string | null; candidateNumber: string | null;
  leadNumber?: string | null;
}

function AssignModal({ workflow, onClose, onAssigned }: { workflow: any; onClose: () => void; onAssigned: () => void }) {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [candidateId, setCandidateId] = useState('');
  const [selectedLabel, setSelectedLabel] = useState('');
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<UnassignedCandidate[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  // Open the dropdown on mount so the operator sees the list of unassigned
  // candidates immediately — the previous closed-by-default flow looked
  // like a free-text 'candidate ID' field.
  const [openList, setOpenList] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Debounced search against /workflows/unassigned-candidates.
  useEffect(() => {
    let cancelled = false;
    setLoadingOptions(true);
    const handle = setTimeout(() => {
      workflowApi.listUnassignedCandidates(search, workflow.id)
        .then((rows) => { if (!cancelled) setOptions(rows ?? []); })
        .catch(() => { if (!cancelled) setOptions([]); })
        .finally(() => { if (!cancelled) setLoadingOptions(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [search]);

  const pick = (c: UnassignedCandidate) => {
    setCandidateId(c.id);
    const ref = c.candidateNumber ?? c.leadNumber ?? c.id.slice(0, 8);
    setSelectedLabel(`${c.firstName} ${c.lastName} · ${ref}`);
    setSearch('');
    setOpenList(false);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!candidateId.trim()) { setError(tc('form.fieldRequired')); return; }
    setSaving(true);
    try {
      await workflowApi.assignCandidate({ candidateId, workflowId: workflow.id, notes: notes || undefined });
      onAssigned();
      onClose();
    } catch (err: any) {
      setError(apiError(err, t('pipelines.errors.assignmentFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5">
        <h3 className="text-base font-semibold text-foreground mb-3">{t('pipelines.board.assignCandidate')}</h3>
        {error && <p className="text-sm text-destructive mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('pipelines.board.candidatePicker', { defaultValue: 'Candidate' })}
              <span className="text-destructive ms-0.5">*</span>
            </label>
            {candidateId ? (
              <div className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 text-sm bg-background">
                <span className="flex-1 truncate">{selectedLabel}</span>
                <button type="button" onClick={() => { setCandidateId(''); setSelectedLabel(''); setOpenList(true); }} className="text-xs text-muted-foreground hover:text-foreground">
                  {t('pipelines.board.change', { defaultValue: 'Change' })}
                </button>
              </div>
            ) : (
              <>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setOpenList(true); }}
                  onFocus={() => setOpenList(true)}
                  placeholder={t('pipelines.board.candidatePickerPlaceholder', { defaultValue: 'Filter list — type a name, email, or candidate ID' })}
                />
                {openList && (
                  <div className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto border border-border rounded-lg bg-card shadow-lg">
                    <p className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground border-b border-border bg-muted/30">
                      {loadingOptions
                        ? t('pipelines.board.loadingCandidates', { defaultValue: 'Loading…' })
                        : t('pipelines.board.unassignedCount', {
                            defaultValue: '{{count}} unassigned candidate(s)',
                            count: options.length,
                          })}
                    </p>
                    {!loadingOptions && options.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">{t('pipelines.board.noUnassignedCandidates', { defaultValue: 'No candidates are currently unassigned. Promote an applicant to Candidate first or remove someone from another workflow.' })}</p>
                    )}
                    {!loadingOptions && options.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => pick(c)}
                        className="w-full text-start px-3 py-2 text-sm hover:bg-muted border-b last:border-b-0 border-border"
                      >
                        <div className="font-medium text-foreground">{c.firstName} {c.lastName}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {(c.candidateNumber ?? c.leadNumber ?? c.id.slice(0, 8))}
                          {c.email ? ` · ${c.email}` : ''}
                          {c.phone ? ` · ${c.phone}` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">{t('pipelines.board.notesOptional')}</label>
            <input
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('pipelines.board.notesPlaceholder')}
            />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition-colors">{tc('actions.cancel')}</button>
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {saving ? t('pipelines.board.assigning') : t('pipelines.board.assign')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Stage Grid Card ──────────────────────────────────────────────────────────

function StageCard({ col, totalStages, totalActive }: { col: any; totalStages: number; totalActive: number }) {
  const { t } = useTranslation('pages');
  const stage       = col.stage;
  const activeCount = col.count ?? 0;
  const stageColor  = stage.color || '#2563EB';
  // Progress = percentage of total active candidates currently in this stage
  const progress    = totalActive > 0 ? Math.round((activeCount / totalActive) * 100) : 0;

  return (
    <Card className="relative hover:shadow-md transition-shadow">
      <CardContent className="p-5">
        {/* Active count badge */}
        <div className="absolute top-4 end-4">
          <Badge
            className="rounded-full w-7 h-7 flex items-center justify-center p-0 text-white text-xs font-semibold"
            style={{ backgroundColor: stageColor }}
          >
            {activeCount}
          </Badge>
        </div>

        {/* Stage name */}
        <h3 className="font-semibold text-[#0F172A] mb-4 pe-8">{stage.name}</h3>

        {/* Progress bar */}
        <div className="space-y-2 mb-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('pipelines.board.progress')}</span>
            <span className="font-medium">{progress}%</span>
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>

        {/* Stage position + candidate count */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-muted-foreground">
            {t('pipelines.board.stageOf', { order: stage.order, total: totalStages })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('pipelines.board.activeCount', { count: activeCount })}
          </p>
        </div>

        {/* View Details link */}
        <Link
          to={`/dashboard/workflows/stage/${stage.id}`}
          className="text-sm text-[#2563EB] hover:text-[#1d4ed8] flex items-center gap-1 font-medium"
        >
          {t('pipelines.board.viewDetails')}
          <ChevronRight className="w-4 h-4" />
        </Link>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function WorkflowBoardPage() {
  const { t } = useTranslation('pages');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Phase 3 (#1 R-3) — refetch on SUPER tenant switch.
  const tenantVersion = useTenantSyncVersion();
  const [board, setBoard]   = useState<any>(null);
  const [stats, setStats]   = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

  const [noteProgressId, setNoteProgressId] = useState<string | null>(null);
  const [advanceState,   setAdvanceState]   = useState<{ assignmentId: string } | null>(null);
  const [showAssign,     setShowAssign]     = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const [boardData, statsData] = await Promise.all([
        workflowApi.board(id),
        workflowApi.stats(id),
      ]);
      setBoard(boardData);
      setStats(statsData);
    } catch (err: any) {
      setError(apiError(err, t('pipelines.errors.loadWorkflowFailed')));
    } finally {
      setLoading(false);
    }
  }, [id, t, tenantVersion]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <div className="h-8 bg-muted animate-pulse rounded w-1/3" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-5 h-36 bg-muted/30" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm rounded-lg px-4 py-3">{error}</div>
      </div>
    );
  }

  // Backend returns { workflow, columns } — "pipeline" is an alias for "workflow"
  const workflowData   = board?.workflow ?? board?.pipeline;
  const columns: any[] = board?.columns ?? [];
  const totalStages    = columns.length;
  const totalActive    = stats?.totalActive ?? 0;
  const totalCompleted = stats?.totalCompleted ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/dashboard/workflows')}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ background: workflowData?.color ?? '#2563EB' }} />
              <h1 className="text-2xl font-semibold text-[#0F172A]">{workflowData?.name}</h1>
              {workflowData?.isDefault && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">{t('pipelines.board.default')}</span>
              )}
            </div>
            {workflowData?.description && (
              <p className="text-muted-foreground text-sm mt-0.5">{workflowData.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Stats */}
          <div className="flex items-center gap-4 text-sm text-muted-foreground me-2">
            <span className="flex items-center gap-1.5">
              <BarChart2 className="w-4 h-4" />
              <strong className="text-foreground">{totalActive}</strong> {t('pipelines.board.active')}
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" />
              <strong className="text-foreground">{totalCompleted}</strong> {t('pipelines.board.completed')}
            </span>
            {stats?.flaggedCount > 0 && (
              <span className="flex items-center gap-1.5 text-amber-600">
                <Flag className="w-4 h-4" />
                <strong>{stats.flaggedCount}</strong> {t('pipelines.board.flagged')}
              </span>
            )}
            {stats?.slaBreached > 0 && (
              <span className="flex items-center gap-1.5 text-red-600">
                <AlertTriangle className="w-4 h-4" />
                <strong>{stats.slaBreached}</strong> {t('pipelines.board.slaBreached')}
              </span>
            )}
          </div>

          <button
            onClick={load}
            className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <Link
            to={`/dashboard/settings/workflows/${id}`}
            className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Settings2 className="w-4 h-4" />
          </Link>
          <button
            onClick={() => setShowAssign(true)}
            className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" /> {t('pipelines.board.assignCandidateButton')}
          </button>
        </div>
      </div>

      {/* Stage Grid */}
      {columns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Layers className="w-16 h-16 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">{t('pipelines.board.noStagesConfigured')}</h3>
          <p className="text-sm text-muted-foreground mb-4">{t('pipelines.board.noStagesBody')}</p>
          <Link
            to={`/dashboard/settings/workflows/${id}`}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Settings2 className="w-4 h-4" /> {t('pipelines.board.workflowSettings')}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {columns.map((col: any) => (
            <StageCard
              key={col.stage.id}
              col={col}
              totalStages={totalStages}
              totalActive={totalActive}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {noteProgressId && (
        <NoteModal progressId={noteProgressId} onClose={() => setNoteProgressId(null)} />
      )}
      {advanceState && (
        <AdvanceModal
          assignmentId={advanceState.assignmentId}
          workflow={workflowData}
          onClose={() => setAdvanceState(null)}
          onAdvanced={load}
        />
      )}
      {showAssign && (
        <AssignModal workflow={workflowData} onClose={() => setShowAssign(false)} onAssigned={load} />
      )}
    </div>
  );
}
