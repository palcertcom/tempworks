import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Users, Clock, AlertTriangle, TrendingUp, CheckCircle, XCircle, Search, ChevronRight, UserCircle, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { employeeWorkflowApi } from '../../services/api';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';

export function StageDetails() {
  const { t } = useTranslation('pages');
  const { stageId } = useParams<{ stageId: string }>();
  const tenantVersion = useTenantSyncVersion();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [allStages, setAllStages] = useState<any[]>([]);
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!stageId) return;
    Promise.all([
      employeeWorkflowApi.getStageDetails(stageId),
      employeeWorkflowApi.getStages(),
    ])
      .then(([details, stages]) => {
        setData(details);
        setAllStages(Array.isArray(stages) ? stages : []);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    // Phase 3 (#1 R-3) — refetch on SUPER tenant switch.
  }, [stageId, tenantVersion]);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 bg-muted rounded w-1/3" />
        <div className="grid grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <div key={i} className="h-28 bg-muted rounded" />)}
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
          <h2 className="text-2xl font-semibold mb-2">{t('workflow.stageDetails.notFound')}</h2>
          <p className="text-muted-foreground mb-4">{t('workflow.stageDetails.notFoundDesc')}</p>
          <Button asChild><Link to="/dashboard/workflow">{t('workflow.stageDetails.returnToWorkflow')}</Link></Button>
        </div>
      </div>
    );
  }

  const { stage, applicants, employees, stats } = data;
  const totalStages = allStages.length || 14;

  // Combine applicants and employees into one list for display
  const allPeople = [
    ...applicants.map((a: any) => ({
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      email: a.email,
      nationality: a.nationality,
      photo: a.photoUrl,
      type: 'Applicant',
      jobType: a.jobType?.name,
      daysInStage: a.createdAt
        ? Math.floor((Date.now() - new Date(a.createdAt).getTime()) / 86400000)
        : 0,
      linkTo: `/dashboard/applicants/${a.id}`,
      docChecklist: a.docChecklist ?? [],
    })),
    ...employees.map((e: any) => ({
      id: e.id,
      firstName: e.firstName,
      lastName: e.lastName,
      email: e.email,
      nationality: e.nationality,
      photo: e.photoUrl,
      type: 'Employee',
      daysInStage: e.startedAt
        ? Math.floor((Date.now() - new Date(e.startedAt).getTime()) / 86400000)
        : 0,
      linkTo: `/dashboard/employees/${e.id}`,
      docChecklist: e.docChecklist ?? [],
    })),
  ];

  const toggleDocs = (id: string) => {
    setExpandedDocs(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const filtered = allPeople.filter(p =>
    `${p.firstName} ${p.lastName} ${p.email}`.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const atRiskCount = allPeople.filter(p => p.daysInStage > 14).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/dashboard/workflow">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button>
          </Link>
          <div>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{stage.name}</h1>
            <p className="text-muted-foreground mt-1">
              Stage {stage.order} of {totalStages} • {stage.description || 'Manage people in this workflow stage'}
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-lg bg-[#EFF6FF] flex items-center justify-center flex-shrink-0">
                <Users className="w-6 h-6 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-3xl font-semibold text-[#0F172A]">{stats.total}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('workflow.stageDetails.totalInStage')}</p>
                <p className="text-xs text-muted-foreground">{stats.applicantsCount} applicants · {stats.employeesCount} employees</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center flex-shrink-0">
                <Clock className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-3xl font-semibold text-[#0F172A]">
                  {allPeople.length > 0
                    ? Math.round(allPeople.reduce((s, p) => s + p.daysInStage, 0) / allPeople.length)
                    : 0}
                </p>
                <p className="text-sm text-muted-foreground mt-1">{t('workflow.stageDetails.avgDaysInStage')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-lg bg-[#FEF3C7] flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-6 h-6 text-[#F59E0B]" />
              </div>
              <div>
                <p className="text-3xl font-semibold text-[#0F172A]">{atRiskCount}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('workflow.stageDetails.atRisk')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-lg bg-[#F0FDF4] flex items-center justify-center flex-shrink-0">
                <TrendingUp className="w-6 h-6 text-[#22C55E]" />
              </div>
              <div>
                <p className="text-3xl font-semibold text-[#0F172A]">Stage {stage.order}</p>
                <p className="text-sm text-muted-foreground mt-1">of {totalStages} total</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Requirements */}
      {(stage.requirementsDocuments?.length > 0 || stage.requirementsActions?.length > 0 || stage.requirementsApprovals?.length > 0) && (
        <Card>
          <CardContent className="p-6">
            <h2 className="font-semibold text-lg mb-4">{t('workflow.stageDetails.stageRequirements')}</h2>
            <div className="space-y-3">
              {[
                ...stage.requirementsDocuments.map((r: string) => ({ name: r, type: 'Document' })),
                ...stage.requirementsActions.map((r: string) => ({ name: r, type: 'Action' })),
                ...stage.requirementsApprovals.map((r: string) => ({ name: r, type: 'Approval' })),
              ].map((req, i) => (
                <div key={i} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-5 h-5 text-[#22C55E]" />
                    <p className="font-medium text-[#0F172A]">{req.name}</p>
                  </div>
                  <Badge variant="outline" className="border-[#2563EB] text-[#2563EB]">{req.type}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* People in Stage */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">People in {stage.name}</h2>
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ps-9 w-64"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="text-center py-12">
              <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-lg font-medium">
                {allPeople.length === 0 ? 'No one in this stage' : 'No results found'}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {allPeople.length === 0
                  ? 'People will appear here when assigned to this stage.'
                  : 'Try a different search term.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((person) => {
                const verifiedCount = person.docChecklist.filter((d: any) => d.status === 'VERIFIED').length;
                const totalRequired = person.docChecklist.length;
                const allDocsVerified = totalRequired > 0 && verifiedCount === totalRequired;
                const isExpanded = expandedDocs.has(person.id);

                return (
                  <div key={person.id} className="border rounded-lg overflow-hidden">
                    {/* Person row */}
                    <div className="flex items-center justify-between p-4 hover:bg-[#F8FAFC] transition-colors">
                      <div className="flex items-center gap-4">
                        {person.photo ? (
                          <img src={person.photo} alt={person.firstName} className="w-12 h-12 rounded-full object-cover" />
                        ) : (
                          <div className="w-12 h-12 rounded-full bg-[#EFF6FF] flex items-center justify-center">
                            <UserCircle className="w-7 h-7 text-[#2563EB]" />
                          </div>
                        )}
                        <div>
                          <p className="font-medium text-[#0F172A]">{person.firstName} {person.lastName}</p>
                          <p className="text-sm text-muted-foreground">
                            {person.nationality}{person.email ? ` · ${person.email}` : ''}
                            {person.jobType ? ` · ${person.jobType}` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="text-end">
                          <p className="font-medium text-[#0F172A]">{person.daysInStage}d</p>
                          <p className="text-xs text-muted-foreground">{t('workflow.stageDetails.inStage')}</p>
                        </div>

                        {person.daysInStage > 14 && (
                          <Badge variant="outline" className="border-[#F59E0B] text-[#F59E0B] bg-[#FEF3C7]">
                            At Risk
                          </Badge>
                        )}

                        {/* Document progress pill */}
                        {totalRequired > 0 && (
                          <button
                            onClick={() => toggleDocs(person.id)}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                              allDocsVerified
                                ? 'bg-[#F0FDF4] text-[#22C55E] border-[#22C55E]'
                                : 'bg-[#FEF3C7] text-[#F59E0B] border-[#F59E0B]'
                            }`}
                          >
                            <FileText className="w-3.5 h-3.5" />
                            {verifiedCount}/{totalRequired} docs
                            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                        )}

                        <Badge
                          variant="outline"
                          className={person.type === 'Applicant'
                            ? 'border-[#2563EB] text-[#2563EB] bg-[#EFF6FF]'
                            : 'border-[#22C55E] text-[#22C55E] bg-[#F0FDF4]'}
                        >
                          {person.type}
                        </Badge>

                        <Link to={person.linkTo}>
                          <Button variant="outline" size="sm">
                            View Profile <ChevronRight className="w-4 h-4 ms-1" />
                          </Button>
                        </Link>
                      </div>
                    </div>

                    {/* Expandable document checklist */}
                    {isExpanded && totalRequired > 0 && (
                      <div className="border-t bg-[#F8FAFC] px-4 py-3">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                          Required Documents
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {person.docChecklist.map((doc: any) => (
                            <div key={doc.name} className="flex items-center gap-2 text-sm">
                              {doc.status === 'VERIFIED' ? (
                                <CheckCircle className="w-4 h-4 text-[#22C55E] flex-shrink-0" />
                              ) : doc.status === 'REJECTED' ? (
                                <XCircle className="w-4 h-4 text-[#EF4444] flex-shrink-0" />
                              ) : doc.status === 'PENDING' ? (
                                <Clock className="w-4 h-4 text-[#F59E0B] flex-shrink-0" />
                              ) : (
                                <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                              )}
                              <span className={
                                doc.status === 'VERIFIED' ? 'text-[#0F172A]' :
                                doc.status === 'REJECTED' ? 'text-[#EF4444]' :
                                'text-muted-foreground'
                              }>
                                {doc.name}
                              </span>
                              <span className={`ms-auto text-xs px-1.5 py-0.5 rounded font-medium ${
                                doc.status === 'VERIFIED' ? 'bg-[#F0FDF4] text-[#22C55E]' :
                                doc.status === 'REJECTED' ? 'bg-[#FEF2F2] text-[#EF4444]' :
                                doc.status === 'PENDING' ? 'bg-[#FEF3C7] text-[#F59E0B]' :
                                'bg-muted text-muted-foreground'
                              }`}>
                                {doc.status === 'MISSING' ? 'Not uploaded' : doc.status.charAt(0) + doc.status.slice(1).toLowerCase()}
                              </span>
                            </div>
                          ))}
                        </div>
                        {allDocsVerified && (
                          <p className="text-xs text-[#22C55E] font-medium mt-2 flex items-center gap-1">
                            <CheckCircle className="w-3.5 h-3.5" />
                            All required documents verified — stage will auto-complete
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
