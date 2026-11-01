import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Search, MapPin, Briefcase, Clock, ChevronLeft, ChevronRight,
  ArrowRight, Filter, X, LayoutGrid, List,
} from 'lucide-react';
import { publicJobAdsApi, settingsApi, resolveAssetUrl } from '../../services/api';
import { useBranding } from '../../hooks/useBranding';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { CountrySelect } from '../../components/ui/CountrySelect';
import { Badge } from '../../components/ui/badge';
import { ErrorBanner } from '../../components/ui/error-banner';
import { Card, CardContent } from '../../components/ui/card';
import { LanguageSwitcher } from '../../../i18n/LanguageSwitcher';
import { formatDate, formatNumber } from '../../../i18n/formatters';
import { enumLabel } from '../../../i18n/enumLabel';

const CONTRACT_TYPE_COLORS: Record<string, string> = {
  'Full-time':  'bg-blue-100 text-blue-700',
  'Part-time':  'bg-purple-100 text-purple-700',
  'Contract':   'bg-orange-100 text-orange-700',
  'Temporary':  'bg-amber-100 text-amber-700',
  'Internship': 'bg-pink-100 text-pink-700',
  'Seasonal':   'bg-teal-100 text-teal-700',
};

function useFormatSalary() {
  const { t } = useTranslation('public');
  return (min: any, max: any, currency: string): string => {
    if (!min && !max) return '';
    const minStr = min ? formatNumber(Number(min)) : '';
    const maxStr = max ? formatNumber(Number(max)) : '';
    if (min && max) return t('jobs.salaryRange', { currency, min: minStr, max: maxStr });
    if (min)        return t('jobs.salaryFrom',  { currency, min: minStr });
    return            t('jobs.salaryUpTo',       { currency, max: maxStr });
  };
}

export function JobListings() {
  // Phase 3.18 — when reached at /t/:tenantSlug/jobs, scope the listing
  // to that tenant. The same component still serves the legacy global
  // /jobs route when the param is absent.
  // @tenant-reviewed: phase318-tenant-public-jobs
  const { tenantSlug } = useParams<{ tenantSlug?: string }>();
  const branding = useBranding();
  const { t } = useTranslation(['public', 'common']);
  const formatSalary = useFormatSalary();
  const [jobs, setJobs]     = useState<any[]>([]);
  const [meta, setMeta]     = useState({ total: 0, page: 1, limit: 20, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

  const [search, setSearch]           = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [contractFilter, setContractFilter] = useState('');
  const [categories, setCategories]   = useState<string[]>([]);
  const [viewMode, setViewMode]       = useState<'grid' | 'list'>('grid');
  const [page, setPage]               = useState(1);
  const limit = 12;

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    setError('');
    try {
      const res = await publicJobAdsApi.list({
        page: p, limit,
        ...(tenantSlug     ? { tenant:       tenantSlug }     : {}),
        ...(search         ? { search }                       : {}),
        ...(countryFilter  ? { country:      countryFilter }  : {}),
        ...(categoryFilter ? { category:     categoryFilter } : {}),
        ...(contractFilter ? { contractType: contractFilter } : {}),
      }) as any;
      setJobs(res.data ?? []);
      setMeta(res.meta ?? { total: 0, page: 1, limit, totalPages: 1 });
    } catch {
      setError(t('jobs.loadError'));
    } finally {
      setLoading(false);
    }
  }, [search, countryFilter, categoryFilter, contractFilter, tenantSlug]);

  useEffect(() => {
    settingsApi.getJobTypes()
      .then((types: any[]) => setCategories(types.filter((t: any) => t.isActive).map((t: any) => t.name)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
    load(1);
  }, [search, countryFilter, categoryFilter, contractFilter]);

  const handlePage = (p: number) => {
    setPage(p);
    load(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const hasFilters = search || countryFilter || categoryFilter || contractFilter;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white shadow-sm sticky top-0 z-30">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#2563EB] flex items-center justify-center overflow-hidden">
              {branding.logoUrl ? (
                <img src={resolveAssetUrl(branding.logoUrl)} alt="Logo" className="w-full h-full object-cover" />
              ) : (
                <Briefcase className="w-6 h-6 text-white" />
              )}
            </div>
            <div>
              <span className="text-xl font-bold text-[#0F172A]">{branding.companyName}</span>
              <p className="text-xs text-muted-foreground">{t('jobs.headerTagline')}</p>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Link to="/#contact">
              <Button variant="outline" size="sm">{t('jobs.headerContact')}</Button>
            </Link>
            <Link to={tenantSlug ? `/apply?company=${encodeURIComponent(tenantSlug)}` : '/apply'}>
              <Button size="sm">{t('jobs.headerApply')}</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <div className="bg-[#0F172A] text-white py-14">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-4xl font-bold mb-3">{t('jobs.heroTitle')}</h1>
          <p className="text-blue-200 text-lg max-w-2xl mx-auto mb-8">
            {t('jobs.heroSubtitle', { company: branding.companyName })}
          </p>
          {/* Search bar */}
          <div className="max-w-xl mx-auto flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('jobs.searchPlaceholder')}
                className="w-full ps-10 pe-4 py-3 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-10">
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Filters sidebar */}
          <aside className="w-full lg:w-64 flex-shrink-0">
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm text-foreground flex items-center gap-2">
                    <Filter className="w-4 h-4" /> {t('jobs.filters')}
                  </span>
                  {hasFilters && (
                    <button
                      onClick={() => {
                        setSearch(''); setCountryFilter('');
                        setCategoryFilter(''); setContractFilter('');
                      }}
                      className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
                    >
                      <X className="w-3 h-3" /> {t('common:actions.clearAll')}
                    </button>
                  )}
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('jobs.country')}</label>
                  <div className="mt-1.5">
                    <CountrySelect
                      value={countryFilter}
                      onChange={setCountryFilter}
                      placeholder={t('jobs.allCountries')}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('jobs.category')}</label>
                  <select
                    value={categoryFilter}
                    onChange={e => setCategoryFilter(e.target.value)}
                    className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('jobs.allCategories')}</option>
                    {categories.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('jobs.contractType')}</label>
                  <select
                    value={contractFilter}
                    onChange={e => setContractFilter(e.target.value)}
                    className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('jobs.allTypes')}</option>
                    {['Full-time','Part-time','Contract','Temporary','Internship','Seasonal'].map(c => (
                      <option key={c} value={c}>{enumLabel('contractType', c)}</option>
                    ))}
                  </select>
                </div>
              </CardContent>
            </Card>
          </aside>

          {/* Job grid */}
          <main className="flex-1">
            {/* Result count + view toggle */}
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {loading ? t('common:states.loading') : t('jobs.found', { count: meta.total })}
              </span>
              <div className="flex items-center gap-1 border rounded-md p-0.5 bg-white">
                <button
                  onClick={() => setViewMode('grid')}
                  title={t('jobs.gridView')}
                  className={`p-1.5 rounded transition-colors ${viewMode === 'grid' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  title={t('jobs.listView')}
                  className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <List className="w-4 h-4" />
                </button>
              </div>
            </div>

            <ErrorBanner message={error} onRetry={() => window.location.reload()} autoFocus={false} />

            {!loading && !error && jobs.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <Briefcase className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <p className="text-lg font-medium">{t('jobs.noJobs')}</p>
                <p className="text-sm mt-1">{t('jobs.noJobsHint')}</p>
              </div>
            )}

            {viewMode === 'grid' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {jobs.map(job => {
                  const salary = formatSalary(job.salaryMin, job.salaryMax, job.currency);
                  const adTenantSlug = tenantSlug ?? job.tenant?.slug ?? '';
                  const applyHref = `/apply?jobAdId=${encodeURIComponent(job.id)}&jobSlug=${encodeURIComponent(job.slug)}&jobTitle=${encodeURIComponent(job.title)}${job.category ? `&jobCategory=${encodeURIComponent(job.category)}` : ''}${adTenantSlug ? `&company=${encodeURIComponent(adTenantSlug)}` : ''}${Array.isArray(job.requiredDocuments) && job.requiredDocuments.length ? `&requiredDocs=${encodeURIComponent(JSON.stringify(job.requiredDocuments))}` : ''}`;
                  const detailHref = adTenantSlug ? `/t/${adTenantSlug}/jobs/${job.slug}` : `/jobs/${job.slug}`;
                  return (
                    <Card key={job.id} className="h-full hover:shadow-md hover:border-blue-300 transition-all group relative">
                      <Button asChild size="sm" className="absolute top-3 end-3 z-10">
                        <Link to={applyHref}>{t('jobs.headerApply')}</Link>
                      </Button>
                      <CardContent className="p-5 flex flex-col h-full">
                        <Link to={detailHref} className="flex flex-col flex-1">
                          <div className="flex items-start justify-between mb-3">
                            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${CONTRACT_TYPE_COLORS[job.contractType] ?? 'bg-gray-100 text-gray-700'}`}>
                              {enumLabel('contractType', job.contractType)}
                            </span>
                          </div>
                          <h3 className="font-semibold text-foreground text-base mb-1 line-clamp-2 group-hover:text-primary transition-colors">
                            {job.title}
                          </h3>
                          <p className="text-xs text-muted-foreground mb-1">{job.category}</p>
                          {!tenantSlug && job.tenant?.name && (
                            <p className="text-[11px] text-muted-foreground mb-2">
                              {t('jobs.byTenant', { defaultValue: 'by {{tenant}}', tenant: job.tenant.name })}
                            </p>
                          )}
                          <div className="space-y-1.5 mt-auto">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <MapPin className="w-3.5 h-3.5" />
                              {job.city}, {job.country}
                            </div>
                            {salary && (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Briefcase className="w-3.5 h-3.5" />
                                {salary}
                              </div>
                            )}
                            {job.publishedAt && (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Clock className="w-3.5 h-3.5" />
                                {t('jobs.posted', { date: formatDate(job.publishedAt) })}
                              </div>
                            )}
                          </div>
                        </Link>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {jobs.map(job => {
                  const salary = formatSalary(job.salaryMin, job.salaryMax, job.currency);
                  const adTenantSlug = tenantSlug ?? job.tenant?.slug ?? '';
                  const applyHref = `/apply?jobAdId=${encodeURIComponent(job.id)}&jobSlug=${encodeURIComponent(job.slug)}&jobTitle=${encodeURIComponent(job.title)}${job.category ? `&jobCategory=${encodeURIComponent(job.category)}` : ''}${adTenantSlug ? `&company=${encodeURIComponent(adTenantSlug)}` : ''}${Array.isArray(job.requiredDocuments) && job.requiredDocuments.length ? `&requiredDocs=${encodeURIComponent(JSON.stringify(job.requiredDocuments))}` : ''}`;
                  const detailHref = adTenantSlug ? `/t/${adTenantSlug}/jobs/${job.slug}` : `/jobs/${job.slug}`;
                  return (
                    <Card key={job.id} className="hover:shadow-md hover:border-blue-300 transition-all group">
                      <CardContent className="p-4 flex items-center gap-4">
                        <Link to={detailHref} className="flex items-center gap-4 flex-1 min-w-0">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${CONTRACT_TYPE_COLORS[job.contractType] ?? 'bg-gray-100 text-gray-700'}`}>
                                {enumLabel('contractType', job.contractType)}
                              </span>
                              <span className="text-xs text-muted-foreground">{job.category}</span>
                              {!tenantSlug && job.tenant?.name && (
                                <span className="text-[11px] text-muted-foreground">
                                  · {t('jobs.byTenant', { defaultValue: 'by {{tenant}}', tenant: job.tenant.name })}
                                </span>
                              )}
                            </div>
                            <h3 className="font-semibold text-foreground text-sm group-hover:text-primary transition-colors truncate">
                              {job.title}
                            </h3>
                          </div>
                          <div className="hidden sm:flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
                            <span className="flex items-center gap-1">
                              <MapPin className="w-3.5 h-3.5" />
                              {job.city}, {job.country}
                            </span>
                            {salary && (
                              <span className="flex items-center gap-1">
                                <Briefcase className="w-3.5 h-3.5" />
                                {salary}
                              </span>
                            )}
                            {job.publishedAt && (
                              <span className="flex items-center gap-1">
                                <Clock className="w-3.5 h-3.5" />
                                {formatDate(job.publishedAt)}
                              </span>
                            )}
                          </div>
                          <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all flex-shrink-0" />
                        </Link>
                        <Button asChild size="sm" className="flex-shrink-0">
                          <Link to={applyHref}>{t('jobs.headerApply')}</Link>
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Pagination */}
            {meta.totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-8">
                <Button
                  variant="outline" size="sm"
                  disabled={page <= 1}
                  onClick={() => handlePage(page - 1)}
                >
                  <ChevronLeft className="w-4 h-4 rtl:rotate-180" /> {t('jobs.previous')}
                </Button>
                <span className="text-sm text-muted-foreground px-4">
                  {t('jobs.pageOf', { current: page, total: meta.totalPages })}
                </span>
                <Button
                  variant="outline" size="sm"
                  disabled={page >= meta.totalPages}
                  onClick={() => handlePage(page + 1)}
                >
                  {t('jobs.next')} <ChevronRight className="w-4 h-4 rtl:rotate-180" />
                </Button>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Footer CTA */}
      <div className="bg-[#2563EB] text-white py-12 mt-10">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-2xl font-bold mb-3">{t('jobs.ctaTitle')}</h2>
          <p className="text-blue-100 mb-6">{t('jobs.ctaBody')}</p>
          <Link to={tenantSlug ? `/apply?company=${encodeURIComponent(tenantSlug)}` : '/apply'}>
            <Button variant="secondary" size="lg">{t('jobs.ctaButton')}</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
