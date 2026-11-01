import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { apiError } from '../../../i18n/apiError';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import {
  ArrowLeft, Users, Clock, AlertTriangle, TrendingUp,
  CheckCircle, Search, ChevronDown, ChevronUp, UserCircle, Flag,
  ThumbsUp, ThumbsDown, X, FileCheck, AlertCircle, Eye, MessageSquare,
} from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { workflowApi } from '../../services/api';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');
const photoUrl = (url?: string | null) => url ? `${API_BASE}${url}` : null;

// ─── Approve Modal ────────────────────────────────────────────────────────────

function ApproveModal({
  person,
  stageId,
  onClose,
  onDone,
}: {
  person: any;
  stageId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      if (person.personType === 'EMPLOYEE') {
        await workflowApi.approveEmployeeStage(person.personId, stageId, notes || undefined);
      } else {
        await workflowApi.submitApproval(person.progressId, { decision, notes: notes || undefined });
      }
      onDone();
    } catch (err: any) {
      setError(apiError(err, t('pipelines.errors.submitApprovalFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">{t('pipelines.stage.approvalTitle')}</h2>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-muted-foreground mb-5">
          {t('pipelines.stage.submittingApprovalFor')} <span className="font-medium text-foreground">{person.firstName} {person.lastName}</span>
        </p>

        {person.personType !== 'EMPLOYEE' && (
          <div className="flex gap-3 mb-4">
            <button
              onClick={() => setDecision('APPROVED')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                decision === 'APPROVED'
                  ? 'bg-emerald-50 border-emerald-500 text-emerald-700'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              <ThumbsUp className="w-4 h-4" /> {t('pipelines.stage.approve')}
            </button>
            <button
              onClick={() => setDecision('REJECTED')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                decision === 'REJECTED'
                  ? 'bg-red-50 border-red-400 text-red-700'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              <ThumbsDown className="w-4 h-4" /> {t('pipelines.stage.reject')}
            </button>
          </div>
        )}

        <div className="mb-4">
          <label className="block text-sm font-medium text-foreground mb-1">{t('pipelines.stage.notesOptional')}</label>
          <textarea
            className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            rows={3}
            placeholder={t('pipelines.stage.approvalNotesPlaceholder')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-destructive mb-3">{error}</p>}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>{tc('actions.cancel')}</Button>
          <Button
            className={`flex-1 ${decision === 'REJECTED' && person.personType !== 'EMPLOYEE' ? 'bg-red-600 hover:bg-red-700' : ''}`}
            onClick={submit}
            disabled={saving}
          >
            {saving ? t('pipelines.stage.submitting') : person.personType === 'EMPLOYEE' ? t('pipelines.stage.approve') : decision === 'APPROVED' ? t('pipelines.stage.approve') : t('pipelines.stage.reject')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Candidate Card Corridor ──────────────────────────────────────────────────

function CandidateCardCorridor({
  candidate,
  stageId,
  onClose,
  onApprove,
  onRefresh,
}: {
  candidate: any;
  stageId: string;
  onClose: () => void;
  onApprove: (person: any) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('pages');
  const [quickNote, setQuickNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [flagged, setFlagged] = useState(candidate.flagged);
  const [flagReason, setFlagReason] = useState(candidate.flagReason || '');
  const [togglingFlag, setTogglingFlag] = useState(false);

  const handleAddNote = async () => {
    if (!quickNote.trim()) return;
    setSavingNote(true);
    try {
      await workflowApi.addNote(candidate.progressId, {
        content: quickNote,
        isPrivate: false,
      });
      setQuickNote('');
      onRefresh();
    } catch (err) {
      console.error('Failed to add note:', err);
    } finally {
      setSavingNote(false);
    }
  };

  const handleToggleFlag = async () => {
    setTogglingFlag(true);
    try {
      await workflowApi.toggleFlag(candidate.progressId, !flagged, !flagged ? flagReason : null);
      setFlagged(!flagged);
      onRefresh();
    } catch (err) {
      console.error('Failed to toggle flag:', err);
    } finally {
      setTogglingFlag(false);
    }
  };

  const getDocStatusColor = (status: string) => {
    switch (status) {
      case 'APPROVED':
        return 'bg-emerald-50 border-emerald-200 text-emerald-700';
      case 'PENDING_REVIEW':
        return 'bg-amber-50 border-amber-200 text-amber-700';
      case 'REJECTED':
        return 'bg-red-50 border-red-200 text-red-700';
      default:
        return 'bg-gray-50 border-gray-200 text-gray-700';
    }
  };

  const getDocStatusIcon = (status: string) => {
    switch (status) {
      case 'APPROVED':
        return <CheckCircle className="w-4 h-4" />;
      case 'PENDING_REVIEW':
        return <AlertCircle className="w-4 h-4" />;
      case 'REJECTED':
        return <X className="w-4 h-4" />;
      default:
        return <FileCheck className="w-4 h-4" />;
    }
  };

  return (
    <div className="border-t border-border bg-muted/50 p-6 space-y-6">
      <div className="flex items-start justify-between">
        <h3 className="text-lg font-semibold text-foreground">
          {candidate.firstName} {candidate.lastName}
        </h3>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Quick Note Input */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">{t('pipelines.stage.addQuickNote')}</label>
        <div className="flex gap-2">
          <textarea
            className="flex-1 border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            rows={2}
            placeholder={t('pipelines.stage.addQuickNotePlaceholder')}
            value={quickNote}
            onChange={(e) => setQuickNote(e.target.value)}
          />
          <Button
            onClick={handleAddNote}
            disabled={!quickNote.trim() || savingNote}
            className="self-end"
          >
            {savingNote ? t('pipelines.stage.addingNote') : t('pipelines.stage.addBtn')}
          </Button>
        </div>
      </div>

      {/* Document Status */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">{t('pipelines.stage.documentStatus')}</label>
        <div
          className={`border rounded-lg px-4 py-3 flex items-center gap-2 ${getDocStatusColor(
            candidate.documentStatus
          )}`}
        >
          {getDocStatusIcon(candidate.documentStatus)}
          <span className="font-medium">
            {candidate.documentStatus === 'APPROVED'
              ? t('pipelines.stage.approved')
              : candidate.documentStatus === 'PENDING_REVIEW'
              ? t('pipelines.stage.pendingReview')
              : candidate.documentStatus === 'REJECTED'
              ? t('pipelines.stage.rejected')
              : t('pipelines.stage.notStarted')}
          </span>
          <span className="text-sm ms-auto">
            {t('pipelines.stage.docsCount', { uploaded: candidate.requiredDocsUploaded, total: candidate.requiredDocsTotal })}
          </span>
        </div>
      </div>

      {/* Flag Toggle */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">{t('pipelines.stage.flagStatus')}</label>
        <div className="flex gap-2 items-end">
          <div className="flex-1 space-y-1">
            <input
              type="checkbox"
              id={`flag-${candidate.progressId}`}
              checked={flagged}
              onChange={(e) => setFlagged(e.target.checked)}
              className="rounded border-border"
            />
            <label htmlFor={`flag-${candidate.progressId}`} className="text-sm text-foreground ms-2">
              {t('pipelines.stage.flagThisCandidate')}
            </label>
            {flagged && (
              <input
                type="text"
                placeholder={t('pipelines.stage.flagReasonPlaceholder')}
                value={flagReason}
                onChange={(e) => setFlagReason(e.target.value)}
                className="w-full mt-2 border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            )}
          </div>
          <Button
            variant="outline"
            onClick={handleToggleFlag}
            disabled={togglingFlag}
            className={flagged ? 'border-amber-500 text-amber-600' : ''}
          >
            {togglingFlag ? t('pipelines.stage.saving') : flagged ? t('pipelines.stage.unflag') : t('pipelines.stage.flag')}
          </Button>
        </div>
      </div>

      {/* View Full Profile */}
      <div className="flex gap-2 pt-4 border-t border-border">
        <a
          href={candidate.profileLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1"
        >
          <Button className="w-full" variant="outline">
            <Eye className="w-4 h-4 me-2" />
            {t('pipelines.stage.viewFullProfile')}
          </Button>
        </a>
        <Button
          onClick={() => onApprove(candidate)}
          className="bg-emerald-600 hover:bg-emerald-700"
        >
          <ThumbsUp className="w-4 h-4 me-2" />
          {t('pipelines.stage.approve')}
        </Button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function WorkflowStageDetailsPage() {
  const { t } = useTranslation('pages');
  const { stageId } = useParams<{ stageId: string }>();
  const navigate = useNavigate();
  // Phase 3 (#1 R-3) — refetch on SUPER tenant switch.
  const tenantVersion = useTenantSyncVersion();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<string>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterDeadline, setFilterDeadline] = useState<string>('all');
  const [filterDocStatus, setFilterDocStatus] = useState<string>('all');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [approvePerson, setApprovePerson] = useState<any>(null);

  const load = () => {
    if (!stageId) return;
    setLoading(true);
    workflowApi.getWorkflowStageDetails(stageId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [stageId, tenantVersion]);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 bg-muted rounded w-1/3" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 bg-muted rounded" />
          ))}
        </div>
        <div className="h-64 bg-muted rounded" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <AlertTriangle className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-2xl font-semibold mb-2">{t('pipelines.stage.stageNotFound')}</h2>
          <p className="text-muted-foreground mb-4">{t('pipelines.stage.stageNotFoundBody')}</p>
          <Button onClick={() => navigate(-1)}>{t('pipelines.stage.returnToWorkflow')}</Button>
        </div>
      </div>
    );
  }

  const { stage, allStages, people, stats } = data;
  const totalStages = allStages?.length ?? 0;

  // Filter and sort
  let filtered = (people ?? []).filter((p: any) => {
    const name = `${p.firstName ?? ''} ${p.lastName ?? ''} ${p.email ?? ''} ${p.applicationId ?? ''}`.toLowerCase();
    if (!name.includes(search.toLowerCase())) return false;

    if (filterDeadline !== 'all' && p.deadlineStatus !== filterDeadline) return false;
    if (filterDocStatus !== 'all' && p.documentStatus !== filterDocStatus) return false;

    return true;
  });

  filtered.sort((a: any, b: any) => {
    let aVal: any;
    let bVal: any;

    switch (sortBy) {
      case 'name':
        aVal = `${a.firstName} ${a.lastName}`.toLowerCase();
        bVal = `${b.firstName} ${b.lastName}`.toLowerCase();
        break;
      case 'applicationId':
        aVal = a.applicationId ?? '';
        bVal = b.applicationId ?? '';
        break;
      case 'enteredAt':
        aVal = new Date(a.enteredAt).getTime();
        bVal = new Date(b.enteredAt).getTime();
        break;
      case 'daysInStage':
        aVal = a.daysInStage;
        bVal = b.daysInStage;
        break;
      case 'docCompletion':
        aVal = (a.requiredDocsUploaded / (a.requiredDocsTotal || 1)) * 100;
        bVal = (b.requiredDocsUploaded / (b.requiredDocsTotal || 1)) * 100;
        break;
      case 'deadline':
        const deadlineOrder: { [key: string]: number } = {
          OVERDUE: 0,
          WARNING: 1,
          ON_TIME: 2,
          NO_DEADLINE: 3,
        };
        aVal = deadlineOrder[a.deadlineStatus] ?? 999;
        bVal = deadlineOrder[b.deadlineStatus] ?? 999;
        break;
      default:
        aVal = a[sortBy];
        bVal = b[sortBy];
    }

    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const toggleSort = (field: string) => {
    if (sortBy === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  };

  const getDeadlineColor = (status: string) => {
    switch (status) {
      case 'ON_TIME':
        return 'bg-emerald-50 border-emerald-200 text-emerald-700';
      case 'WARNING':
        return 'bg-amber-50 border-amber-200 text-amber-700';
      case 'OVERDUE':
        return 'bg-red-50 border-red-200 text-red-700';
      default:
        return 'bg-gray-50 border-gray-200 text-gray-700';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{stage.name}</h1>
          <p className="text-muted-foreground mt-1">
            {t('pipelines.stage.stageOf', { order: stage.order, total: totalStages })}
            {stage.description ? ` • ${stage.description}` : ''}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center shrink-0">
                <Users className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-3xl font-semibold text-[#0F172A]">{stats.total}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('pipelines.stage.totalInStage')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('pipelines.stage.totalSubtitle', { employees: stats.employeesCount, candidates: stats.candidatesCount })}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center shrink-0">
                <Clock className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-3xl font-semibold text-[#0F172A]">{stats.avgDays}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('pipelines.stage.avgDaysInStage')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-lg bg-[#FEF3C7] flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6 text-[#F59E0B]" />
              </div>
              <div>
                <p className="text-3xl font-semibold text-[#0F172A]">{stats.atRiskCount}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('pipelines.stage.atRisk')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center shrink-0">
                <TrendingUp className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-3xl font-semibold text-[#0F172A]">{t('pipelines.stage.stageNumber', { order: stage.order })}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('pipelines.stage.ofTotal', { total: totalStages })}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Stage Requirements + Responsible */}
      {(stage.requiredDocs?.length > 0 || stage.assignedUsers?.length > 0) && (
        <Card>
          <CardContent className="p-6">
            <h2 className="font-semibold text-lg mb-4">{t('pipelines.stage.stageRequirements')}</h2>
            <div className="space-y-3">
              {stage.requiredDocs?.map((rd: any) => (
                <div key={rd.id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-5 h-5 text-[#22C55E]" />
                    <p className="font-medium text-[#0F172A]">{rd.documentType?.name ?? rd.documentTypeId}</p>
                  </div>
                  <Badge variant="outline" className="border-[#2563EB] text-[#2563EB]">
                    {t('pipelines.stage.documentBadge')}
                  </Badge>
                </div>
              ))}

              {stage.assignedUsers?.map((au: any) => (
                <div key={au.userId} className="flex items-center justify-between p-4 border rounded-lg bg-purple-50/50">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
                      <UserCircle className="w-5 h-5 text-purple-600" />
                    </div>
                    <div>
                      <p className="font-medium text-[#0F172A]">
                        {au.user ? `${au.user.firstName} ${au.user.lastName}` : t('pipelines.list.add')}
                      </p>
                      <p className="text-xs text-muted-foreground">{au.role}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="border-[#8B5CF6] text-[#8B5CF6]">
                    {au.role}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Candidates List */}
      <Card>
        <CardContent className="p-6">
          <div className="mb-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-lg">{t('pipelines.stage.candidatesIn', { stage: stage.name })}</h2>
              <div className="text-sm text-muted-foreground">{t('pipelines.stage.resultsCount', { count: filtered.length })}</div>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={t('pipelines.stage.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="ps-9"
              />
            </div>

            {/* Filters */}
            <div className="flex gap-3">
              <Select value={filterDeadline} onValueChange={setFilterDeadline}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('pipelines.stage.deadlineStatus')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('pipelines.stage.allDeadlines')}</SelectItem>
                  <SelectItem value="ON_TIME">{t('pipelines.stage.onTime')}</SelectItem>
                  <SelectItem value="WARNING">{t('pipelines.stage.warning')}</SelectItem>
                  <SelectItem value="OVERDUE">{t('pipelines.stage.overdue')}</SelectItem>
                  <SelectItem value="NO_DEADLINE">{t('pipelines.stage.noDeadline')}</SelectItem>
                </SelectContent>
              </Select>

              <Select value={filterDocStatus} onValueChange={setFilterDocStatus}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('pipelines.stage.docStatus')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('pipelines.stage.allDocs')}</SelectItem>
                  <SelectItem value="APPROVED">{t('pipelines.stage.approved')}</SelectItem>
                  <SelectItem value="PENDING_REVIEW">{t('pipelines.stage.pendingReview')}</SelectItem>
                  <SelectItem value="REJECTED">{t('pipelines.stage.rejected')}</SelectItem>
                  <SelectItem value="NOT_STARTED">{t('pipelines.stage.notStarted')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <div className="text-center py-12">
              <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-lg font-medium">
                {(people ?? []).length === 0 ? t('pipelines.stage.noOneInStage') : t('pipelines.stage.noResultsFound')}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {(people ?? []).length === 0 ? t('pipelines.stage.peopleAppearHere') : t('pipelines.stage.tryDifferent')}
              </p>
            </div>
          ) : (
            <div className="space-y-0 border border-border rounded-lg overflow-hidden">
              {/* Table Header */}
              <div className="bg-muted/50 border-b border-border grid grid-cols-12 gap-4 px-6 py-3">
                <div className="col-span-2">
                  <button
                    onClick={() => toggleSort('name')}
                    className="flex items-center gap-2 font-semibold text-sm text-foreground hover:text-primary"
                  >
                    {t('pipelines.stage.name')} {sortBy === 'name' && (sortDir === 'asc' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />)}
                  </button>
                </div>
                <div className="col-span-1">
                  <button
                    onClick={() => toggleSort('applicationId')}
                    className="flex items-center gap-2 font-semibold text-sm text-foreground hover:text-primary"
                  >
                    {t('pipelines.stage.id')} {sortBy === 'applicationId' && (sortDir === 'asc' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />)}
                  </button>
                </div>
                <div className="col-span-1">
                  <button
                    onClick={() => toggleSort('daysInStage')}
                    className="flex items-center gap-2 font-semibold text-sm text-foreground hover:text-primary"
                  >
                    {t('pipelines.stage.days')} {sortBy === 'daysInStage' && (sortDir === 'asc' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />)}
                  </button>
                </div>
                <div className="col-span-1">
                  <button
                    onClick={() => toggleSort('docCompletion')}
                    className="flex items-center gap-2 font-semibold text-sm text-foreground hover:text-primary"
                  >
                    {t('pipelines.stage.docs')} {sortBy === 'docCompletion' && (sortDir === 'asc' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />)}
                  </button>
                </div>
                <div className="col-span-1">
                  <button
                    onClick={() => toggleSort('deadline')}
                    className="flex items-center gap-2 font-semibold text-sm text-foreground hover:text-primary"
                  >
                    {t('pipelines.stage.deadline')} {sortBy === 'deadline' && (sortDir === 'asc' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />)}
                  </button>
                </div>
                <div className="col-span-2">
                  <div className="font-semibold text-sm text-foreground">{t('pipelines.stage.status')}</div>
                </div>
                <div className="col-span-3 text-end">
                  <div className="font-semibold text-sm text-foreground">{t('pipelines.stage.actions')}</div>
                </div>
              </div>

              {/* Table Rows */}
              {filtered.map((item: any) => (
                <div key={item.progressId}>
                  <button
                    onClick={() => setExpandedRow(expandedRow === item.progressId ? null : item.progressId)}
                    className="w-full grid grid-cols-12 gap-4 px-6 py-4 border-b border-border hover:bg-muted/50 transition-colors text-start"
                  >
                    <div className="col-span-2 flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#EFF6FF] flex items-center justify-center overflow-hidden shrink-0">
                        {item.photoUrl ? (
                          <img src={photoUrl(item.photoUrl)!} alt={item.firstName} className="w-full h-full object-cover" />
                        ) : (
                          <UserCircle className="w-5 h-5 text-[#2563EB]" />
                        )}
                      </div>
                      <div className="text-start">
                        <p className="font-medium text-foreground text-sm">{item.firstName} {item.lastName}</p>
                        <p className="text-xs text-muted-foreground">{item.email}</p>
                      </div>
                    </div>

                    <div className="col-span-1 flex items-center">
                      <span className="text-sm text-foreground font-medium">{item.applicationId || '—'}</span>
                    </div>

                    <div className="col-span-1 flex items-center">
                      <span className="text-sm text-foreground font-medium">{t('pipelines.stage.daysSuffix', { days: item.daysInStage })}</span>
                    </div>

                    <div className="col-span-1 flex items-center">
                      <span className="text-sm text-foreground font-medium">
                        {item.requiredDocsUploaded}/{item.requiredDocsTotal}
                      </span>
                    </div>

                    <div className="col-span-1 flex items-center">
                      <Badge className={`text-xs ${getDeadlineColor(item.deadlineStatus)}`}>
                        {item.deadlineStatus === 'ON_TIME'
                          ? t('pipelines.stage.onTime')
                          : item.deadlineStatus === 'WARNING'
                          ? t('pipelines.stage.warning')
                          : item.deadlineStatus === 'OVERDUE'
                          ? t('pipelines.stage.overdue')
                          : t('pipelines.stage.noDeadline')}
                      </Badge>
                    </div>

                    <div className="col-span-2 flex items-center gap-2">
                      {item.flagged && (
                        <Badge variant="outline" className="border-amber-500 text-amber-600 bg-amber-50">
                          <Flag className="w-3 h-3 me-1" /> {t('pipelines.stage.flaggedBadge')}
                        </Badge>
                      )}
                      {item.latestApproval && (
                        <Badge
                          className={
                            item.latestApproval.decision === 'APPROVED'
                              ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                              : 'bg-red-50 border border-red-200 text-red-700'
                          }
                        >
                          {item.latestApproval.decision}
                        </Badge>
                      )}
                    </div>

                    <div className="col-span-3 flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setApprovePerson(item);
                        }}
                      >
                        <ThumbsUp className="w-3.5 h-3.5 me-1" /> {t('pipelines.stage.approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedRow(expandedRow === item.progressId ? null : item.progressId);
                        }}
                      >
                        {expandedRow === item.progressId ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </Button>
                    </div>
                  </button>

                  {/* Expanded Card Corridor */}
                  {expandedRow === item.progressId && (
                    <CandidateCardCorridor
                      candidate={item}
                      stageId={stageId!}
                      onClose={() => setExpandedRow(null)}
                      onApprove={setApprovePerson}
                      onRefresh={load}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Approve Modal */}
      {approvePerson && stageId && (
        <ApproveModal
          person={approvePerson}
          stageId={stageId}
          onClose={() => setApprovePerson(null)}
          onDone={() => {
            setApprovePerson(null);
            load();
          }}
        />
      )}
    </div>
  );
}
