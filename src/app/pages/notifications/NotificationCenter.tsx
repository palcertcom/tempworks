import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';
import { useNotificationMeta, eventLabel } from '../../hooks/useNotificationMeta';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { useTranslation } from 'react-i18next';
import {
  Bell, BellOff, Check, CheckCheck, Trash2, Filter, RefreshCw,
  FileText, DollarSign, AlertTriangle, Info, Settings, ChevronDown, X, Search, Eye, EyeOff,
} from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Checkbox } from '../../components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { notificationsApi } from '../../services/api';
import { confirm } from '../../components/ui/ConfirmDialog';
import { toast } from 'sonner';
import { formatDate } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';

// ── Type helpers ─────────────────────────────────────────────────────────────

function typeColor(type: string) {
  switch (type) {
    case 'WARNING':        return 'bg-amber-500';
    case 'ERROR':          return 'bg-red-500';
    case 'SUCCESS':        return 'bg-green-500';
    case 'DOCUMENT_EXPIRY':return 'bg-orange-500';
    case 'FINANCIAL':      return 'bg-blue-600';
    case 'COMPLIANCE':     return 'bg-purple-500';
    default:               return 'bg-blue-400';
  }
}

function typeIcon(type: string, eventType?: string) {
  if (eventType?.startsWith('FINANCIAL')) return <DollarSign className="w-4 h-4" />;
  if (eventType?.startsWith('DOCUMENT'))  return <FileText className="w-4 h-4" />;
  switch (type) {
    case 'WARNING':
    case 'ERROR':          return <AlertTriangle className="w-4 h-4" />;
    default:               return <Info className="w-4 h-4" />;
  }
}

// Event labels are sourced from the backend registry via
// useNotificationMeta() in the parent component and threaded into
// NotificationRow as an `eventLabel` resolver. Keeping a stub here
// only as a documentation anchor — the parent always provides one.

// ── Notification row ─────────────────────────────────────────────────────────

function NotificationRow({
  n,
  onMarkRead,
  onMarkUnread,
  onDelete,
  eventLabel,
  selected,
  onToggleSelect,
}: {
  n: any;
  onMarkRead:   (id: string) => void;
  onMarkUnread: (id: string) => void;
  onDelete:     (id: string) => void;
  /** Resolver supplied by the parent (registry-backed). */
  eventLabel: (eventType?: string) => string;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (!n.isRead) onMarkRead(n.id);
    // Navigate to related entity
    if (n.relatedEntity && n.relatedEntityId) {
      const entityRoutes: Record<string, string> = {
        EMPLOYEE:  `/dashboard/employees/${n.relatedEntityId}`,
        APPLICANT: `/dashboard/applicants/${n.relatedEntityId}`,
      };
      const route = entityRoutes[n.relatedEntity];
      if (route) navigate(route);
    }
  };

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg border transition-colors cursor-pointer group ${
        n.isRead ? 'bg-card border-border' : 'bg-blue-50 border-blue-200 dark:bg-blue-950/20 dark:border-blue-800'
      } ${selected ? 'ring-2 ring-blue-500' : ''} hover:bg-accent`}
      onClick={handleClick}
    >
      {/* Selection checkbox — bulk-action gate. */}
      <div className="flex items-center pt-0.5" onClick={e => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(n.id)}
          aria-label="Select notification"
        />
      </div>
      {/* Dot + icon */}
      <div className="flex flex-col items-center gap-1 mt-0.5 flex-shrink-0">
        <div className={`w-2 h-2 rounded-full ${n.isRead ? 'bg-muted-foreground/30' : 'bg-blue-500'}`} />
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white ${typeColor(n.type)}`}>
          {typeIcon(n.type, n.eventType)}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={`text-sm truncate ${n.isRead ? 'font-normal' : 'font-semibold'}`}>{n.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            {n.channel && (
              // Spec §4.11.3 — surface the channel(s) used on each
              // notification card. Today every row carries 'in_app';
              // when the email outbox lights up secondary channels in
              // a future commit, the same badge widens cleanly.
              <Badge
                variant="outline"
                className="text-[10px] uppercase tracking-wide whitespace-nowrap text-muted-foreground"
                title={n.channel}
              >
                {n.channel === 'in_app' ? 'In-App' : n.channel === 'email' ? 'Email' : n.channel}
              </Badge>
            )}
            {n.priority && n.priority !== 'NORMAL' && (
              // Spec §4.11.4 — surface priority so the operator can
              // spot URGENT alerts in the inbox at a glance. NORMAL
              // rows stay un-badged to keep routine traffic quiet.
              <Badge
                className={`text-[10px] uppercase tracking-wide whitespace-nowrap ${
                  n.priority === 'URGENT' ? 'bg-red-500'
                  : n.priority === 'HIGH' ? 'bg-orange-500'
                  : 'bg-slate-400'
                } text-white`}
                title={`Priority: ${n.priority}`}
              >
                {n.priority}
              </Badge>
            )}
            {n.eventType && (
              <Badge variant="outline" className="text-xs whitespace-nowrap">
                {eventLabel(n.eventType)}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatDate(n.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Actions (show on hover) */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ms-1" onClick={e => e.stopPropagation()}>
        {!n.isRead ? (
          <button
            title="Mark as read"
            onClick={() => onMarkRead(n.id)}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            title="Mark as unread"
            onClick={() => onMarkUnread(n.id)}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <EyeOff className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          title="Delete"
          onClick={() => onDelete(n.id)}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-50 dark:hover:bg-red-950/20 text-muted-foreground hover:text-red-500"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function NotificationCenter() {
  const { t } = useTranslation('pages');
  const tenantVersion = useTenantSyncVersion();
  // SPIKE-010 Phase F2/F3 — SUPER USER per-list tenant override.
  const tenant = useSuperUserTenantFilter();
  // Notification event registry — loaded once per session, shared
  // with NotificationSettings via the in-memory cache. Replaces the
  // hardcoded label table that used to live in this file.
  const notifMeta = useNotificationMeta();
  const resolveEventLabel = (eventType?: string) => eventLabel(notifMeta, eventType);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [markingAll, setMarkingAll]   = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // Filters
  const [filterIsRead, setFilterIsRead]       = useState<string>('all');   // 'all' | 'unread' | 'read'
  const [filterType, setFilterType]           = useState<string>('all');
  const [filterEventType, setFilterEventType] = useState<string>('all');
  const [filterCategory, setFilterCategory]   = useState<string>('all');
  const [filterChannel, setFilterChannel]     = useState<string>('all');
  const [filterPriority, setFilterPriority]   = useState<string>('all');
  const [filterRelatedPerson, setFilterRelatedPerson] = useState('');
  const [sortBy, setSortBy]                   = useState<'createdAt' | 'priority' | 'category'>('createdAt');
  const [sortOrder, setSortOrder]             = useState<'asc' | 'desc'>('desc');
  const [filterDateFrom, setFilterDateFrom]   = useState('');
  const [filterDateTo, setFilterDateTo]       = useState('');
  // Spec §4.11.4 — keyword search across title + message. Debounced so
  // the inbox doesn't re-fetch on every keystroke.
  const [searchInput, setSearchInput]         = useState('');
  const [searchTerm, setSearchTerm]           = useState('');
  // Bulk selection — Set keeps add/remove O(1) and the toolbar reads
  // .size for the action labels. Cleared on every page change so a
  // stale id from page N can't leak into a page N+1 bulk action.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy]       = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(id);
  }, [searchInput]);

  const LIMIT = 20;

  const buildParams = useCallback(() => {
    const p: Record<string, any> = { page, limit: LIMIT };
    if (filterIsRead === 'unread') p.isRead = false;
    if (filterIsRead === 'read')   p.isRead = true;
    if (filterType !== 'all')      p.type   = filterType;
    if (filterEventType !== 'all') p.eventType = filterEventType;
    if (filterCategory !== 'all')  p.category = filterCategory;
    if (filterChannel !== 'all')   p.channel  = filterChannel;
    if (filterPriority !== 'all')  p.priority = filterPriority;
    if (filterRelatedPerson.trim()) p.relatedPerson = filterRelatedPerson.trim();
    if (sortBy)    p.sortBy = sortBy;
    if (sortOrder) p.sortOrder = sortOrder;
    if (filterDateFrom)            p.dateFrom  = filterDateFrom;
    if (filterDateTo)              p.dateTo    = filterDateTo;
    if (searchTerm)                p.search    = searchTerm;
    tenant.applyToParams(p);
    return p;
  }, [page, filterIsRead, filterType, filterEventType, filterCategory, filterChannel, filterPriority, filterRelatedPerson, sortBy, sortOrder, filterDateFrom, filterDateTo, searchTerm, tenant.tenantFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, countRes] = await Promise.all([
        notificationsApi.list(buildParams()),
        notificationsApi.getUnreadCount(),
      ]);
      setNotifications(res?.data ?? []);
      // Backend returns { data, total } (no `meta` wrapper) — reading
      // res.meta.total was always undefined → header showed '0 total'
      // even when the list was populated.
      setTotal(res?.total ?? res?.meta?.total ?? (Array.isArray(res?.data) ? res.data.length : 0));
      setUnreadCount(countRes?.count ?? 0);
    } catch {
      toast.error(t('notifications.toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [buildParams, tenantVersion]);

  useEffect(() => { load(); }, [load]);

  // Clear bulk selection whenever the list refetches — stale ids
  // from a previous page or filter set can't be acted on.
  useEffect(() => { setSelectedIds(new Set()); }, [page, searchTerm, filterIsRead, filterType, filterEventType, filterCategory, filterChannel, filterPriority, filterRelatedPerson, filterDateFrom, filterDateTo, tenant.tenantFilter]);

  const handleMarkRead = async (id: string) => {
    try {
      await notificationsApi.markRead(id);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n));
      setUnreadCount(c => Math.max(0, c - 1));
    } catch {
      toast.error(t('notifications.toast.markReadFailed'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await notificationsApi.delete(id);
      const wasUnread = notifications.find(n => n.id === id)?.isRead === false;
      setNotifications(prev => prev.filter(n => n.id !== id));
      setTotal(t => t - 1);
      if (wasUnread) setUnreadCount(c => Math.max(0, c - 1));
    } catch {
      toast.error(t('notifications.toast.deleteFailed'));
    }
  };

  const handleMarkUnread = async (id: string) => {
    try {
      await notificationsApi.markUnread(id);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: false, readAt: null } : n));
      setUnreadCount(c => c + 1);
    } catch {
      toast.error(t('notifications.toast.markUnreadFailed', { defaultValue: 'Failed to mark as unread' }));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds(prev =>
      prev.size === notifications.length && notifications.length > 0
        ? new Set()
        : new Set(notifications.map(n => n.id)),
    );
  };
  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkMarkRead = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await notificationsApi.bulkMarkRead(ids);
      setNotifications(prev => prev.map(n => selectedIds.has(n.id) ? { ...n, isRead: true, readAt: new Date().toISOString() } : n));
      setUnreadCount(c => Math.max(0, c - (res?.updated ?? 0)));
      clearSelection();
      toast.success(t('notifications.toast.bulkMarkReadSuccess', { defaultValue: '{{count}} marked as read', count: res?.updated ?? ids.length }));
    } catch {
      toast.error(t('notifications.toast.bulkMarkReadFailed', { defaultValue: 'Bulk mark-read failed' }));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkMarkUnread = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await notificationsApi.bulkMarkUnread(ids);
      setNotifications(prev => prev.map(n => selectedIds.has(n.id) ? { ...n, isRead: false, readAt: null } : n));
      setUnreadCount(c => c + (res?.updated ?? 0));
      clearSelection();
      toast.success(t('notifications.toast.bulkMarkUnreadSuccess', { defaultValue: '{{count}} marked as unread', count: res?.updated ?? ids.length }));
    } catch {
      toast.error(t('notifications.toast.bulkMarkUnreadFailed', { defaultValue: 'Bulk mark-unread failed' }));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({
      title: t('notifications.toast.bulkDeleteTitle', { defaultValue: 'Delete selected?' }),
      description: t('notifications.toast.bulkDeleteConfirm', {
        defaultValue: 'Permanently dismiss {{count}} notification(s)?',
        count: selectedIds.size,
      }),
      confirmText: t('common.delete', { defaultValue: 'Delete' }),
      tone: 'destructive',
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await notificationsApi.bulkDelete(ids);
      const removedUnread = notifications.filter(n => selectedIds.has(n.id) && !n.isRead).length;
      setNotifications(prev => prev.filter(n => !selectedIds.has(n.id)));
      setTotal(t => Math.max(0, t - (res?.deleted ?? ids.length)));
      setUnreadCount(c => Math.max(0, c - removedUnread));
      clearSelection();
      toast.success(t('notifications.toast.bulkDeleteSuccess', { defaultValue: '{{count}} dismissed', count: res?.deleted ?? ids.length }));
    } catch {
      toast.error(t('notifications.toast.bulkDeleteFailed', { defaultValue: 'Bulk delete failed' }));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleMarkAllRead = async () => {
    setMarkingAll(true);
    try {
      await notificationsApi.markAllRead();
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true, readAt: new Date().toISOString() })));
      setUnreadCount(0);
      toast.success(t('notifications.toast.markAllReadSuccess'));
    } catch {
      toast.error(t('notifications.toast.markAllReadFailed'));
    } finally {
      setMarkingAll(false);
    }
  };

  const handleResetFilters = () => {
    setFilterIsRead('all');
    setFilterType('all');
    setFilterEventType('all');
    setFilterCategory('all');
    setFilterChannel('all');
    setFilterPriority('all');
    setFilterRelatedPerson('');
    setSortBy('createdAt');
    setSortOrder('desc');
    setFilterDateFrom('');
    setFilterDateTo('');
    setSearchInput('');
    setPage(1);
  };

  const totalPages = Math.ceil(total / LIMIT);
  const hasActiveFilters = filterIsRead !== 'all' || filterType !== 'all' || filterEventType !== 'all' || filterCategory !== 'all' || filterChannel !== 'all' || filterPriority !== 'all' || !!filterRelatedPerson.trim() || filterDateFrom || filterDateTo || !!searchTerm;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-[#0F172A]">{t('notifications.center.title')}</h1>
          <p className="text-muted-foreground mt-1">
            {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'} · {total} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tenant.isPlatformSuper && (
            <TenantFilterSelect
              value={tenant.tenantFilter}
              onChange={tenant.setTenantFilter}
              options={tenant.tenantOptions}
            />
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to="/dashboard/notifications/settings">
              <Settings className="w-4 h-4 me-2" />
              Settings
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(v => !v)}
            className={hasActiveFilters ? 'border-blue-500 text-blue-600' : ''}
          >
            <Filter className="w-4 h-4 me-2" />
            Filters {hasActiveFilters && <Badge className="ms-1 h-4 text-xs bg-blue-500">{[filterIsRead !== 'all', filterType !== 'all', filterEventType !== 'all', filterCategory !== 'all', filterChannel !== 'all', filterPriority !== 'all', !!filterRelatedPerson.trim(), !!filterDateFrom, !!filterDateTo, !!searchTerm].filter(Boolean).length}</Badge>}
          </Button>
          {unreadCount > 0 && (
            <Button size="sm" onClick={handleMarkAllRead} disabled={markingAll}>
              <CheckCheck className="w-4 h-4 me-2" />
              {markingAll ? 'Marking…' : 'Mark All Read'}
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => { setPage(1); load(); }}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Search bar — spec §4.11.4 keyword search across title + message. */}
      <div className="relative">
        <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="ps-9"
          placeholder={t('notifications.center.searchPh', { defaultValue: 'Search notifications…' })}
          value={searchInput}
          onChange={e => { setSearchInput(e.target.value); setPage(1); }}
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => { setSearchInput(''); setPage(1); }}
            className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={t('common.clear', { defaultValue: 'Clear' })}
          >
            ×
          </button>
        )}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {tenant.isPlatformSuper && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Tenant</Label>
                  <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <Select value={filterIsRead} onValueChange={v => { setFilterIsRead(v); setPage(1); }}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('notifications.center.filters.all')}</SelectItem>
                    <SelectItem value="unread">{t('notifications.center.unreadOnly')}</SelectItem>
                    <SelectItem value="read">{t('notifications.center.readOnly')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Type</Label>
                <Select value={filterType} onValueChange={v => { setFilterType(v); setPage(1); }}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('notifications.center.allTypes')}</SelectItem>
                    <SelectItem value="DOCUMENT_EXPIRY">Document</SelectItem>
                    <SelectItem value="FINANCIAL">Financial</SelectItem>
                    <SelectItem value="WARNING">Warning</SelectItem>
                    <SelectItem value="INFO">Info</SelectItem>
                    <SelectItem value="SYSTEM">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Spec §4.11.4 — Category filter mirrors the preferences
                  matrix grouping (Documents / Financial / Applicants /
                  Employees / Pipeline / System). Sourced from the
                  registry on the backend so a new category surfaces
                  automatically. */}
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.center.category', { defaultValue: 'Category' })}</Label>
                <Select value={filterCategory} onValueChange={v => { setFilterCategory(v); setPage(1); }}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('notifications.center.allCategories', { defaultValue: 'All Categories' })}</SelectItem>
                    <SelectItem value="Documents">Documents</SelectItem>
                    <SelectItem value="Financial">Financial</SelectItem>
                    <SelectItem value="Applicants">Applicants</SelectItem>
                    <SelectItem value="Employees">Employees</SelectItem>
                    <SelectItem value="Pipeline">Pipeline</SelectItem>
                    <SelectItem value="System">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Spec §4.11.4 — channel filter. Today the data model
                  stores 'in_app' on every row; the filter is here so
                  future emission paths that mark email-only or sms
                  rows surface separately. */}
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.center.channel', { defaultValue: 'Channel' })}</Label>
                <Select value={filterChannel} onValueChange={v => { setFilterChannel(v); setPage(1); }}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('notifications.center.allChannels', { defaultValue: 'All Channels' })}</SelectItem>
                    <SelectItem value="in_app">In-App</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Spec §4.11.4 — priority filter. Defaults to NORMAL for
                  every emission; admin-published events default HIGH /
                  URGENT depending on the kind. */}
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.center.priority', { defaultValue: 'Priority' })}</Label>
                <Select value={filterPriority} onValueChange={v => { setFilterPriority(v); setPage(1); }}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('notifications.center.allPriorities', { defaultValue: 'All Priorities' })}</SelectItem>
                    <SelectItem value="URGENT">Urgent</SelectItem>
                    <SelectItem value="HIGH">High</SelectItem>
                    <SelectItem value="NORMAL">Normal</SelectItem>
                    <SelectItem value="LOW">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Spec §4.11.4 — related person filter. Free-text input
                  resolved server-side against applicant / employee
                  names, emails, and business ids. */}
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.center.relatedPerson', { defaultValue: 'Related person' })}</Label>
                <Input
                  className="h-8 text-sm"
                  value={filterRelatedPerson}
                  onChange={e => { setFilterRelatedPerson(e.target.value); setPage(1); }}
                  placeholder={t('notifications.center.relatedPersonPh', { defaultValue: 'Name, email, or ID' })}
                />
              </div>
              {/* Sort by — spec §4.11.4 lists date, category, or
                  priority. Date and priority are first-class; category
                  is handled via the Category filter above. */}
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.center.sortBy', { defaultValue: 'Sort by' })}</Label>
                <Select
                  value={`${sortBy}:${sortOrder}`}
                  onValueChange={v => {
                    const [sb, so] = v.split(':') as ['createdAt' | 'priority' | 'category', 'asc' | 'desc'];
                    setSortBy(sb); setSortOrder(so); setPage(1);
                  }}
                >
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="createdAt:desc">{t('notifications.center.sortNewest', { defaultValue: 'Newest first' })}</SelectItem>
                    <SelectItem value="createdAt:asc">{t('notifications.center.sortOldest', { defaultValue: 'Oldest first' })}</SelectItem>
                    <SelectItem value="priority:asc">{t('notifications.center.sortPriorityHigh', { defaultValue: 'Highest priority first' })}</SelectItem>
                    <SelectItem value="priority:desc">{t('notifications.center.sortPriorityLow', { defaultValue: 'Lowest priority first' })}</SelectItem>
                    <SelectItem value="category:asc">{t('notifications.center.sortCategoryAZ', { defaultValue: 'Category (A → Z)' })}</SelectItem>
                    <SelectItem value="category:desc">{t('notifications.center.sortCategoryZA', { defaultValue: 'Category (Z → A)' })}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Event</Label>
                <Select value={filterEventType} onValueChange={v => { setFilterEventType(v); setPage(1); }}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('notifications.center.allEvents')}</SelectItem>
                    {/* Sourced from the backend event registry so a new
                        event surfaces in this filter automatically. */}
                    {notifMeta.map(m => (
                      <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.center.dateFrom')}</Label>
                <DateInput className="h-8 text-sm" value={filterDateFrom} onChange={e => { setFilterDateFrom(e.target.value); setPage(1); }} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notifications.center.dateTo')}</Label>
                <DateInput className="h-8 text-sm" value={filterDateTo} onChange={e => { setFilterDateTo(e.target.value); setPage(1); }} />
              </div>
              {hasActiveFilters && (
                <div className="flex items-end">
                  <Button variant="ghost" size="sm" onClick={handleResetFilters} className="h-8 text-muted-foreground">
                    <X className="w-3 h-3 me-1" /> Reset
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Select-all + bulk toolbar. The "select-all on this page" box
          stays visible whenever the list has rows; the action buttons
          only appear once at least one row is picked. */}
      {notifications.length > 0 && (
        <div className="flex items-center justify-between px-1">
          <label className="flex items-center gap-2 text-sm text-muted-foreground select-none cursor-pointer">
            <Checkbox
              checked={selectedIds.size === notifications.length && notifications.length > 0}
              onCheckedChange={toggleSelectAll}
              aria-label="Select all on this page"
            />
            {selectedIds.size > 0
              ? t('notifications.center.bulkSelected', { defaultValue: '{{count}} selected', count: selectedIds.size })
              : t('notifications.center.bulkSelectAll', { defaultValue: 'Select all on this page' })}
          </label>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={bulkBusy} onClick={handleBulkMarkRead}>
                <Eye className="w-3.5 h-3.5 me-1.5" />
                {t('notifications.center.bulkMarkRead', { defaultValue: 'Mark read' })}
              </Button>
              <Button size="sm" variant="outline" disabled={bulkBusy} onClick={handleBulkMarkUnread}>
                <EyeOff className="w-3.5 h-3.5 me-1.5" />
                {t('notifications.center.bulkMarkUnread', { defaultValue: 'Mark unread' })}
              </Button>
              <Button size="sm" variant="outline" disabled={bulkBusy} onClick={handleBulkDelete} className="text-red-600 hover:text-red-700">
                <Trash2 className="w-3.5 h-3.5 me-1.5" />
                {t('notifications.center.bulkDismiss', { defaultValue: 'Dismiss' })}
              </Button>
              <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={clearSelection}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* List */}
      <div className="space-y-2">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg border bg-muted/30 animate-pulse" />
          ))
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
            <BellOff className="w-12 h-12 opacity-30" />
            <p className="text-lg font-medium">{t('notifications.center.noNotifications')}</p>
            <p className="text-sm">
              {hasActiveFilters ? 'No results for the current filters.' : 'You\'re all caught up!'}
            </p>
          </div>
        ) : (
          notifications.map(n => (
            <NotificationRow
              key={n.id}
              n={n}
              onMarkRead={handleMarkRead}
              onMarkUnread={handleMarkUnread}
              onDelete={handleDelete}
              eventLabel={resolveEventLabel}
              selected={selectedIds.has(n.id)}
              onToggleSelect={toggleSelect}
            />
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} · {total} notifications
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
