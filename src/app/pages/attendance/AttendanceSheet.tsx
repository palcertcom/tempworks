import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Pencil,
  Plus,
  Clock,
  Calendar,
  User,
  RefreshCw,
  ClipboardList,
  Trash2,
  Eraser,
  Lock,
  Unlock,
  Download,
  Paperclip,
  Loader2,
} from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '../../components/ui/popover';
import { toast } from 'sonner';
import { apiError } from '../../../i18n/apiError';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../components/ui/dialog';
import { Textarea } from '../../components/ui/textarea';
import { attendanceApi, companyProfilesApi, documentsApi, settingsApi } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { confirm } from '../../components/ui/ConfirmDialog';

// ─── Constants ─────────────────────────────────────────────────────────────────

// Strip the `/api/v1` suffix so we can build a direct link to a stored
// file (served statically by the backend at its raw fileUrl path).
const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const YEARS = Array.from({ length: 11 }, (_, i) => 2020 + i);

const STATUS_OPTIONS = [
  { value: 'PRESENT',      label: 'Present (Odpracované)' },
  { value: 'ABSENT',       label: 'Absent (absencia)' },
  { value: 'VACATION',     label: 'Vacation (dovolenka)' },
  { value: 'HOLIDAY',      label: 'Public Holiday (sviatok)' },
  { value: 'SICK',         label: 'Sick Leave (lekár)' },
  { value: 'PAID_LEAVE',   label: 'Paid Leave (Platené voľno)' },
  { value: 'UNPAID_LEAVE', label: 'Unpaid Leave (neplatené voľno)' },
];

const INTERRUPTION_STATUS_OPTIONS = STATUS_OPTIONS.filter((o) => o.value !== 'PRESENT');

const statusColors: Record<string, string> = {
  PRESENT:      'bg-green-100 text-green-700 border-green-200',
  ABSENT:       'bg-orange-100 text-orange-700 border-orange-200',
  VACATION:     'bg-cyan-100 text-cyan-700 border-cyan-200',
  HOLIDAY:      'bg-purple-100 text-purple-700 border-purple-200',
  SICK:         'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200',
  PAID_LEAVE:   'bg-amber-100 text-amber-700 border-amber-200',
  UNPAID_LEAVE: 'bg-red-100 text-red-700 border-red-200',
  OFF:          'bg-orange-100 text-orange-700 border-orange-200',
  LATE:         'bg-amber-100 text-amber-700 border-amber-200',
  ON_LEAVE:     'bg-blue-100 text-blue-700 border-blue-200',
  HALF_DAY:     'bg-purple-100 text-purple-700 border-purple-200',
};

const statusLabels: Record<string, string> = {
  PRESENT: 'Present', ABSENT: 'Absent', VACATION: 'Vacation', HOLIDAY: 'Public Holiday',
  SICK: 'Sick Leave', PAID_LEAVE: 'Paid Leave', UNPAID_LEAVE: 'Unpaid Leave',
  OFF: 'Absent', LATE: 'Late', ON_LEAVE: 'On Leave', HALF_DAY: 'Half Day',
};

const LEAVE_STATUSES = new Set(['ABSENT', 'VACATION', 'HOLIDAY', 'SICK', 'UNPAID_LEAVE', 'PAID_LEAVE', 'OFF']);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function calcHours(
  checkIn: string, checkOut: string,
  breakIn: string, breakOut: string,
  interruptionIn: string = '', interruptionOut: string = '',
): string {
  if (!checkIn || !checkOut) return '';
  const toMin = (s: string) => {
    if (!s) return NaN;
    const [h, m] = s.split(':').map(Number);
    return isNaN(h) ? NaN : h * 60 + (m || 0);
  };
  const inMin = toMin(checkIn);
  const outMin = toMin(checkOut);
  if (isNaN(inMin) || isNaN(outMin) || outMin <= inMin) return '';
  let work = outMin - inMin;
  if (breakIn && breakOut) {
    const bIn = toMin(breakIn);
    const bOut = toMin(breakOut);
    if (!isNaN(bIn) && !isNaN(bOut) && bOut > bIn) work -= (bOut - bIn);
  }
  if (interruptionIn && interruptionOut) {
    const iIn = toMin(interruptionIn);
    const iOut = toMin(interruptionOut);
    if (!isNaN(iIn) && !isNaN(iOut) && iOut > iIn) work -= (iOut - iIn);
  }
  // Clamp at zero — when a whole-day interruption (or break) consumes the
  // shift, working hours should resolve to '0', not be left blank. Returning
  // '' here was the bug: handleFormChange's `if (calculated) …` then skipped
  // the assignment and the stale previous value survived, inflating the
  // monthly total.
  if (work <= 0) return '0';
  const h = Math.floor(work / 60);
  const m = work % 60;
  return m > 0 ? (h + m / 60).toFixed(2).replace(/\.?0+$/, '') : String(h);
}

function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(Number(h))) return '—';
  const n = Number(h);
  return `${n.toFixed(1).replace(/\.0$/, '')}h`;
}

/**
 * Day count derived from hours, since interruptions add partial-day
 * leave time that the integer status counter doesn't see. 1 day = 8h.
 * Returns `undefined` for zero/missing values so the tile sub-label
 * hides cleanly. Two-decimal precision drops trailing zeros so 1.25,
 * 1.5, 2 all render naturally.
 */
function fmtDays(hours: number | null | undefined): string | undefined {
  if (hours == null || !Number.isFinite(Number(hours))) return undefined;
  const h = Number(hours);
  if (h <= 0) return undefined;
  const days = Math.round((h / 8) * 100) / 100;
  return `${days} days`;
}

// ─── Slovak public holidays calendar ───────────────────────────────────────────
const SLOVAK_PUBLIC_HOLIDAYS: Record<string, string> = {
  '2024-01-01': 'Day of the Establishment of the Slovak Republic',
  '2024-01-06': 'Epiphany',
  '2024-03-29': 'Good Friday',
  '2024-04-01': 'Easter Monday',
  '2024-05-01': 'Labour Day',
  '2024-05-08': 'Day of Victory over Fascism',
  '2024-07-05': 'St. Cyril and Methodius Day',
  '2024-08-29': 'Slovak National Uprising Anniversary',
  '2024-09-01': 'Constitution Day',
  '2024-09-15': 'Day of Our Lady of Sorrows',
  '2024-11-01': 'All Saints\' Day',
  '2024-11-17': 'Struggle for Freedom and Democracy Day',
  '2024-12-24': 'Christmas Eve',
  '2024-12-25': 'Christmas Day',
  '2024-12-26': 'St. Stephen\'s Day',
  '2025-01-01': 'Day of the Establishment of the Slovak Republic',
  '2025-01-06': 'Epiphany',
  '2025-04-18': 'Good Friday',
  '2025-04-21': 'Easter Monday',
  '2025-05-01': 'Labour Day',
  '2025-05-08': 'Day of Victory over Fascism',
  '2025-07-05': 'St. Cyril and Methodius Day',
  '2025-08-29': 'Slovak National Uprising Anniversary',
  '2025-09-01': 'Constitution Day',
  '2025-09-15': 'Day of Our Lady of Sorrows',
  '2025-11-01': 'All Saints\' Day',
  '2025-11-17': 'Struggle for Freedom and Democracy Day',
  '2025-12-24': 'Christmas Eve',
  '2025-12-25': 'Christmas Day',
  '2025-12-26': 'St. Stephen\'s Day',
  '2026-01-01': 'Day of the Establishment of the Slovak Republic',
  '2026-01-06': 'Epiphany',
  '2026-04-03': 'Good Friday',
  '2026-04-06': 'Easter Monday',
  '2026-05-01': 'Labour Day',
  '2026-05-08': 'Day of Victory over Fascism',
  '2026-07-05': 'St. Cyril and Methodius Day',
  '2026-08-29': 'Slovak National Uprising Anniversary',
  '2026-09-01': 'Constitution Day',
  '2026-09-15': 'Day of Our Lady of Sorrows',
  '2026-11-01': 'All Saints\' Day',
  '2026-11-17': 'Struggle for Freedom and Democracy Day',
  '2026-12-24': 'Christmas Eve',
  '2026-12-25': 'Christmas Day',
  '2026-12-26': 'St. Stephen\'s Day',
  '2027-01-01': 'Day of the Establishment of the Slovak Republic',
  '2027-01-06': 'Epiphany',
  '2027-03-26': 'Good Friday',
  '2027-03-29': 'Easter Monday',
  '2027-05-01': 'Labour Day',
  '2027-05-08': 'Day of Victory over Fascism',
  '2027-07-05': 'St. Cyril and Methodius Day',
  '2027-08-29': 'Slovak National Uprising Anniversary',
  '2027-09-01': 'Constitution Day',
  '2027-09-15': 'Day of Our Lady of Sorrows',
  '2027-11-01': 'All Saints\' Day',
  '2027-11-17': 'Struggle for Freedom and Democracy Day',
  '2027-12-24': 'Christmas Eve',
  '2027-12-25': 'Christmas Day',
  '2027-12-26': 'St. Stephen\'s Day',
  '2028-01-01': 'Day of the Establishment of the Slovak Republic',
  '2028-01-06': 'Epiphany',
  '2028-04-14': 'Good Friday',
  '2028-04-17': 'Easter Monday',
  '2028-05-01': 'Labour Day',
  '2028-05-08': 'Day of Victory over Fascism',
  '2028-07-05': 'St. Cyril and Methodius Day',
  '2028-08-29': 'Slovak National Uprising Anniversary',
  '2028-09-01': 'Constitution Day',
  '2028-09-15': 'Day of Our Lady of Sorrows',
  '2028-11-01': 'All Saints\' Day',
  '2028-11-17': 'Struggle for Freedom and Democracy Day',
  '2028-12-24': 'Christmas Eve',
  '2028-12-25': 'Christmas Day',
  '2028-12-26': 'St. Stephen\'s Day',
  '2029-01-01': 'Day of the Establishment of the Slovak Republic',
  '2029-01-06': 'Epiphany',
  '2029-03-30': 'Good Friday',
  '2029-04-02': 'Easter Monday',
  '2029-05-01': 'Labour Day',
  '2029-05-08': 'Day of Victory over Fascism',
  '2029-07-05': 'St. Cyril and Methodius Day',
  '2029-08-29': 'Slovak National Uprising Anniversary',
  '2029-09-01': 'Constitution Day',
  '2029-09-15': 'Day of Our Lady of Sorrows',
  '2029-11-01': 'All Saints\' Day',
  '2029-11-17': 'Struggle for Freedom and Democracy Day',
  '2029-12-24': 'Christmas Eve',
  '2029-12-25': 'Christmas Day',
  '2029-12-26': 'St. Stephen\'s Day',
  '2030-01-01': 'Day of the Establishment of the Slovak Republic',
  '2030-01-06': 'Epiphany',
  '2030-04-19': 'Good Friday',
  '2030-04-22': 'Easter Monday',
  '2030-05-01': 'Labour Day',
  '2030-05-08': 'Day of Victory over Fascism',
  '2030-07-05': 'St. Cyril and Methodius Day',
  '2030-08-29': 'Slovak National Uprising Anniversary',
  '2030-09-01': 'Constitution Day',
  '2030-09-15': 'Day of Our Lady of Sorrows',
  '2030-11-01': 'All Saints\' Day',
  '2030-11-17': 'Struggle for Freedom and Democracy Day',
  '2030-12-24': 'Christmas Eve',
  '2030-12-25': 'Christmas Day',
  '2030-12-26': 'St. Stephen\'s Day',
};

const isSlovakPublicHoliday = (date: string): boolean => date in SLOVAK_PUBLIC_HOLIDAYS;
const slovakPublicHolidayName = (date: string): string => SLOVAK_PUBLIC_HOLIDAYS[date] ?? '';

// ─── Bulk Fill Modal ───────────────────────────────────────────────────────────

interface BulkFillModalProps {
  open: boolean;
  onClose: () => void;
  employeeId: string | undefined;
  month: number;
  year: number;
  days: DayEntry[];
  records: any[];
  onSuccess: () => void;
}

function BulkFillModal({
  open, onClose, employeeId, month, year, days, records, onSuccess,
}: BulkFillModalProps) {
  const { t: tc } = useTranslation('common');
  const [status, setStatus] = useState('PRESENT');
  const [checkIn, setCheckIn] = useState('08:00');
  const [checkOut, setCheckOut] = useState('16:30');
  const [breakIn, setBreakIn] = useState('12:00');
  const [breakOut, setBreakOut] = useState('12:30');
  const [overwrite, setOverwrite] = useState(false);
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [saving, setSaving] = useState(false);

  const isWorkStatus = status === 'PRESENT';
  const autoHours = isWorkStatus ? calcHours(checkIn, checkOut, breakIn, breakOut) : '';

  const targetDays = days.filter((d) => {
    if (skipWeekends && d.isWeekend) return false;
    if (overwrite) return true;
    return !records.find((r) => r.date?.slice(0, 10) === d.date);
  });

  const handleBulkFill = async () => {
    if (!employeeId) return;
    if (targetDays.length === 0) {
      toast.info('No days to fill');
      return;
    }
    setSaving(true);
    try {
      await attendanceApi.bulkApply({
        employeeId,
        status,
        dates: targetDays.map((d) => d.date),
        checkIn:  isWorkStatus ? checkIn : undefined,
        checkOut: isWorkStatus ? checkOut : undefined,
        breakIn:  isWorkStatus ? breakIn : undefined,
        breakOut: isWorkStatus ? breakOut : undefined,
        overwriteExisting: overwrite,
      });
      toast.success(`Filled ${targetDays.length} days as ${statusLabels[status] ?? status}`);
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.operationFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-blue-600" />
            Fill Month — {MONTH_NAMES[month - 1]} {year}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Default Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isWorkStatus && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Check In</Label>
                  <Input type="time" lang="en-GB" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Check Out</Label>
                  <Input type="time" lang="en-GB" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Break In</Label>
                  <Input type="time" lang="en-GB" value={breakIn} onChange={(e) => setBreakIn(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Break Out</Label>
                  <Input type="time" lang="en-GB" value={breakOut} onChange={(e) => setBreakOut(e.target.value)} />
                </div>
              </div>
              <div className="text-sm text-muted-foreground bg-muted/30 rounded-md p-2.5">
                <Clock className="w-3.5 h-3.5 inline me-1.5 -mt-0.5" />
                Computed hours per day:{' '}
                <strong className="text-foreground">{autoHours || '—'}</strong>
                <span className="ms-1 text-xs">(= check-out − check-in − break)</span>
              </div>
            </>
          )}

          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={skipWeekends}
                onChange={(e) => setSkipWeekends(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300"
              />
              Skip weekends
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300"
              />
              Overwrite existing records
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            This will affect <strong>{targetDays.length}</strong> day(s).
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleBulkFill} disabled={saving || targetDays.length === 0}>
            {saving ? 'Filling…' : `Fill ${targetDays.length} Days`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Lock Period Modal ────────────────────────────────────────────────────────

function LockPeriodModal({
  open, onClose, year, month, isLocked, lockId, employeeId, employeeName, isGlobalLock, onChanged,
}: {
  open: boolean; onClose: () => void; year: number; month: number;
  isLocked: boolean; lockId?: string; employeeId?: string; employeeName?: string;
  isGlobalLock?: boolean; onChanged: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Phase 2C #33 — default new locks to per-employee. The user may
  // explicitly choose a global lock (covers every employee) when needed.
  const [globalScope, setGlobalScope] = useState(false);
  const action = isLocked ? 'unlock' : 'lock';

  const handle = async () => {
    setBusy(true);
    try {
      if (isLocked && lockId) {
        await attendanceApi.unlockPeriod(lockId);
        toast.success(
          isGlobalLock
            ? `Global lock removed — ${MONTH_NAMES[month - 1]} ${year}`
            : `Period unlocked for ${employeeName ?? 'this employee'} — ${MONTH_NAMES[month - 1]} ${year}`,
        );
      } else {
        await attendanceApi.lockPeriod({
          year,
          month,
          reason: reason || undefined,
          // employeeId is omitted when the user explicitly picks "global"
          // OR when we don't have an employee id (defensive).
          ...((!globalScope && employeeId) ? { employeeId } : {}),
        });
        toast.success(
          globalScope
            ? `Global lock applied — ${MONTH_NAMES[month - 1]} ${year}`
            : `Period locked for ${employeeName ?? 'this employee'} — ${MONTH_NAMES[month - 1]} ${year}`,
        );
      }
      onChanged();
      onClose();
    } catch (err: any) {
      toast.error(apiError(err, `Failed to ${action}`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isLocked ? <Unlock className="w-5 h-5 text-amber-600" /> : <Lock className="w-5 h-5 text-red-600" />}
            {isLocked ? 'Unlock' : 'Lock'} Period — {MONTH_NAMES[month - 1]} {year}
          </DialogTitle>
        </DialogHeader>
        <div className="py-3 space-y-3 text-sm">
          {isLocked ? (
            <>
              {/* Phase 2C #33 — clearly tell the user what scope they're unlocking. */}
              <div className={`text-xs px-2 py-1 rounded ${isGlobalLock ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-blue-50 text-blue-800 border border-blue-200'}`}>
                {isGlobalLock
                  ? `This period carries a LEGACY GLOBAL lock — it currently blocks every employee in the tenant. Unlocking will remove the lock for everyone.`
                  : `This period is locked for ${employeeName ?? 'this employee'} only.`}
              </div>
              <p className="text-muted-foreground">
                Unlocking allows attendance for this month to be edited again. Use only when you need to correct payroll data after the period was sealed.
              </p>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                Locking prevents any further additions, edits, or deletions of attendance for this month. Use this after payroll is finalized to seal the period against retrospective changes.
              </p>
              {/* Phase 2C #33 — scope toggle. Default: lock this employee only. */}
              {employeeId && (
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={globalScope}
                    onChange={(e) => setGlobalScope(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">Apply as a global lock (every employee)</span>
                    <br />
                    <span className="text-muted-foreground">Leave unchecked to lock only {employeeName ?? 'this employee'} for {MONTH_NAMES[month - 1]} {year}.</span>
                  </span>
                </label>
              )}
              <div className="space-y-1.5">
                <Label>Reason (optional)</Label>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Payroll finalized for the month" />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={isLocked ? 'outline' : 'destructive'} onClick={handle} disabled={busy}>
            {busy ? '…' : isLocked ? 'Unlock' : 'Lock Period'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Export Modal ─────────────────────────────────────────────────────────────

function ExportModal({
  open, onClose, employeeId, month, year, employeeName,
}: {
  open: boolean; onClose: () => void; employeeId: string;
  month: number; year: number; employeeName: string;
}) {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [profileId, setProfileId] = useState<string>('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    companyProfilesApi.list().then((r) => {
      setProfiles(r ?? []);
      if (r && r.length > 0 && !profileId) setProfileId(r[0].id);
    }).catch(() => setProfiles([]));
  }, [open]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await attendanceApi.exportExcel({
        employeeId, month, year,
        companyProfileId: profileId || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `timesheet-${employeeName.replace(/\s+/g, '-')}-${year}-${String(month).padStart(2, '0')}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Timesheet exported');
      onClose();
    } catch (err: any) {
      toast.error(apiError(err, 'Export failed'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="w-5 h-5 text-blue-600" />
            Export Timesheet
          </DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-3 text-sm">
          <div className="rounded-md bg-muted/40 p-3 text-xs">
            <div><strong>{employeeName}</strong></div>
            <div className="text-muted-foreground">{MONTH_NAMES[month - 1]} {year}</div>
          </div>
          <div className="space-y-1.5">
            <Label>Company Header</Label>
            <Select value={profileId || '__none__'} onValueChange={(v) => setProfileId(v === '__none__' ? '' : v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select company details" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No company header</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The selected company's details will appear in the Excel header. Manage profiles under Settings → Company Profiles.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={exporting}>Cancel</Button>
          <Button onClick={handleExport} disabled={exporting}>
            <Download className="w-4 h-4 me-1" />
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface DayEntry {
  date: string;
  dayName: string;
  dayNum: number;
  isWeekend: boolean;
}

interface EditForm {
  status: string;
  checkIn: string;
  checkOut: string;
  breakIn: string;
  breakOut: string;
  interruptionIn: string;
  interruptionOut: string;
  interruptionStatus: string;
  workingHours: string;
  notes: string;
}

// ─── Attachment clip ────────────────────────────────────────────────────────────
// Phase 2C #32 — a paperclip badge shown on any timesheet day that has
// supporting proof files. The file list is annotated server-side on
// the attendance record (record.attachments), so we don't need a
// second HTTP call — and we side-step the documents controller's
// role allowlist (which differs from attendance:read, so e.g. an
// "Officer" who can read the sheet would otherwise get 403 on
// /documents/entity and see "No attachments" here).
function AttachmentClip({
  files,
  onDelete,
  canDelete,
}: {
  files: Array<{ id: string; name: string }>;
  onDelete?: (documentId: string) => Promise<void> | void;
  canDelete?: boolean;
}) {
  const { t } = useTranslation('pages');
  const count = files.length;
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (doc: { id: string; name: string }) => {
    if (!onDelete) return;
    const ok = await confirm({
      title: t('attendance.docs.deleteTitle', { defaultValue: 'Delete attachment?' }),
      description: t('attendance.docs.deleteConfirm', {
        defaultValue: 'Remove "{{name}}" from this attendance record?',
        name: doc.name,
      }),
      confirmText: t('attendance.docs.delete', { defaultValue: 'Delete' }),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      setDeletingId(doc.id);
      await onDelete(doc.id);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground align-middle"
          title={t('attendance.docs.hasAttachments', { defaultValue: '{{count}} attached file(s)', count })}
          aria-label={t('attendance.docs.hasAttachments', { defaultValue: '{{count}} attached file(s)', count })}
        >
          <Paperclip className="w-3.5 h-3.5" />
          <span className="text-[10px] font-medium">{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <p className="text-xs font-medium text-muted-foreground px-1 pb-1">
          {t('attendance.docs.title', { defaultValue: 'Supporting Documents' })}
        </p>
        {count > 0 ? (
          <ul className="text-sm space-y-1">
            {files.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 border rounded px-2 py-1">
                <span className="truncate">{d.name}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <Link to={`/dashboard/documents/${d.id}`} className="text-xs text-blue-600 hover:underline">
                    {t('attendance.docs.view', { defaultValue: 'View' })}
                  </Link>
                  {canDelete && onDelete && (
                    <button
                      type="button"
                      className="text-red-600 hover:text-red-700 disabled:opacity-50"
                      title={t('attendance.docs.delete', { defaultValue: 'Delete' })}
                      aria-label={t('attendance.docs.delete', { defaultValue: 'Delete' })}
                      disabled={deletingId === d.id}
                      onClick={() => handleDelete(d)}
                    >
                      {deletingId === d.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground px-1 py-2">
            {t('attendance.docs.none', { defaultValue: 'No attachments.' })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

interface AttendanceSheetProps {
  /** Optional override; when omitted, the employee id comes from the
   *  route param. Lets the same screen render inside Employee Profile
   *  → Attendance & Time Sheets tab without the back button. */
  employeeId?: string;
  /** Hide the "Back to Attendance Sheets" header (used when embedded). */
  hideBackButton?: boolean;
}

export function AttendanceSheet({ employeeId: propEmployeeId, hideBackButton = false }: AttendanceSheetProps = {}) {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const params = useParams<{ id: string }>();
  const id = propEmployeeId ?? params.id;
  const navigate = useNavigate();
  const { can, canCreate, canEdit, canDelete } = usePermissions();
  const canReadAtt   = can('attendance', 'read');
  const canCreateAtt = canCreate('attendance');
  const canEditAtt   = canEdit('attendance');
  const canDelAtt    = canDelete('attendance');
  const canWriteAtt  = canCreateAtt || canEditAtt;

  const [employee, setEmployee] = useState<any>(null);
  const [resettingMonth, setResettingMonth] = useState(false);
  const [records, setRecords] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({});
  // Seed month/year from ?month= / ?year= when navigated from
  // AttendanceList so the operator keeps the same period in view.
  // Falls back to today when the params aren't present (deep link,
  // bookmark, or fresh navigation).
  const [searchParams, setSearchParams] = useSearchParams();
  const initialMonth = (() => {
    const m = Number(searchParams.get('month'));
    return Number.isFinite(m) && m >= 1 && m <= 12 ? m : new Date().getMonth() + 1;
  })();
  const initialYear = (() => {
    const y = Number(searchParams.get('year'));
    return Number.isFinite(y) && y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
  })();
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  // Keep the URL in sync as the operator changes the period inside the
  // sheet, so refresh / back-button preserves the view they were on.
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    params.set('month', String(month));
    params.set('year', String(year));
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, year]);
  const [loading, setLoading] = useState(true);

  const [lockedPeriods, setLockedPeriods] = useState<any[]>([]);

  const [editRecord, setEditRecord] = useState<any>(null);
  const [editDate, setEditDate] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [saving, setSaving] = useState(false);
  // Phase 2C #32 — supporting documents attached to the attendance record.
  const [attendanceDocs, setAttendanceDocs] = useState<any[]>([]);
  const [attendanceDocTypes, setAttendanceDocTypes] = useState<Array<{ id: string; name: string }>>([]);
  const [uploadDocTypeId, setUploadDocTypeId] = useState<string>('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    status: 'PRESENT',
    checkIn: '', checkOut: '',
    breakIn: '', breakOut: '',
    interruptionIn: '', interruptionOut: '', interruptionStatus: '',
    workingHours: '', notes: '',
  });

  const [deleteRecord, setDeleteRecord] = useState<any>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [showBulkFill, setShowBulkFill] = useState(false);
  const [showLockModal, setShowLockModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  // ── Day generation ─────────────────────────────────────────────────────────────

  const daysInMonth = new Date(year, month, 0).getDate();
  const days: DayEntry[] = Array.from({ length: daysInMonth }, (_, i) => {
    const d = new Date(year, month - 1, i + 1);
    return {
      date: `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
      dayName: d.toLocaleDateString('en', { weekday: 'short' }),
      dayNum: i + 1,
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
    };
  });

  // ── Fetch ──────────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [result, locks] = await Promise.all([
        attendanceApi.getEmployeeAttendance(id, { month, year }),
        attendanceApi.listLockedPeriods().catch(() => []),
      ]);
      setEmployee(result?.employee ?? null);
      setRecords(result?.records ?? []);
      setSummary(result?.summary ?? {});
      setLockedPeriods(locks ?? []);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load attendance');
    } finally {
      setLoading(false);
    }
  }, [id, month, year]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /** Wipe every attendance record for THIS employee in the currently
   *  selected month. Backend re-enforces tenant + period-lock + the
   *  attendance:delete permission, so a stale UI guard can't leak. */
  const handleResetMonth = async () => {
    if (!id) return;
    const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
    const ok = await confirm({
      title: t('attendance.resetMonth.title', { defaultValue: 'Reset whole month?' }),
      description: t('attendance.resetMonth.confirm', {
        name: fullName,
        month: monthLabel,
        defaultValue: 'Delete every attendance record for {{name}} in {{month}}. This cannot be undone.',
      }),
      confirmText: t('attendance.resetMonth.confirmButton', { defaultValue: 'Reset Month' }),
      tone: 'destructive',
    });
    if (!ok) return;
    setResettingMonth(true);
    try {
      const res = await attendanceApi.resetMonth(id, year, month);
      toast.success(t('attendance.resetMonth.success', {
        count: res.deleted, month: monthLabel,
        defaultValue: 'Reset {{count}} record(s) in {{month}}',
      }));
      await fetchData();
    } catch (err: any) {
      toast.error(apiError(err, t('attendance.resetMonth.failed', { defaultValue: 'Reset failed' })));
    } finally {
      setResettingMonth(false);
    }
  };

  // ── Edit helpers ───────────────────────────────────────────────────────────────

  const openEditModal = (record: any, date: string) => {
    setEditRecord(record ?? null);
    setEditDate(date);
    const fallbackStatus = !record && isSlovakPublicHoliday(date) ? 'HOLIDAY' : 'PRESENT';
    setEditForm({
      status: record?.status ?? fallbackStatus,
      checkIn:  record?.checkIn  ?? '',
      checkOut: record?.checkOut ?? '',
      breakIn:  record?.breakIn  ?? '',
      breakOut: record?.breakOut ?? '',
      interruptionIn:     record?.interruptionIn     ?? '',
      interruptionOut:    record?.interruptionOut    ?? '',
      interruptionStatus: record?.interruptionStatus ?? '',
      workingHours: record?.workingHours != null ? String(record.workingHours) : '',
      notes: record?.notes ?? '',
    });
    // Phase 2C #32 — load doc types once, and any supporting docs
    // already attached to this attendance record.
    setUploadError(null);
    setUploadFile(null);
    if (attendanceDocTypes.length === 0) {
      settingsApi.getDocumentTypes()
        .then((types: any) => {
          const list = Array.isArray(types) ? types : (types?.data ?? []);
          const opts = list.map((d: any) => ({ id: d.id, name: d.name }));
          setAttendanceDocTypes(opts);
          if (!uploadDocTypeId && opts.length) setUploadDocTypeId(opts[0].id);
        })
        .catch(() => { /* leave empty; UI shows a hint */ });
    }
    if (record?.id) {
      documentsApi.getByEntity('ATTENDANCE', record.id)
        .then((res: any) => setAttendanceDocs(res?.data ?? []))
        .catch(() => setAttendanceDocs([]));
    } else {
      setAttendanceDocs([]);
    }
    setShowEditModal(true);
  };

  // Phase 2C #32 — upload a supporting file for the currently-edited
  // attendance record. Backend tenant/agency guard + permission applies.
  const handleUploadSupportingDoc = async () => {
    if (!editRecord?.id) return;
    if (!uploadFile) { setUploadError(t('attendance.docs.fileRequired', { defaultValue: 'Please choose a file first.' })); return; }
    if (!uploadDocTypeId) { setUploadError(t('attendance.docs.typeRequired', { defaultValue: 'Pick a document type.' })); return; }
    setUploadingDoc(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('name', uploadFile.name);
      fd.append('documentTypeId', uploadDocTypeId);
      fd.append('entityType', 'ATTENDANCE');
      fd.append('entityId', editRecord.id);
      await documentsApi.upload(fd);
      setUploadFile(null);
      const res: any = await documentsApi.getByEntity('ATTENDANCE', editRecord.id);
      const docs = res?.data ?? [];
      setAttendanceDocs(docs);
      // Keep the grid's paperclip in sync so the clip and its popover
      // list update without a full month reload. Mirror the
      // backend-annotated shape: { id, name }.
      const slim = docs.map((d: any) => ({ id: d.id, name: d.name }));
      setRecords((prev) => prev.map((r) => r.id === editRecord.id
        ? { ...r, attachments: slim, attachmentCount: slim.length }
        : r));
      toast.success(t('attendance.docs.uploaded', { defaultValue: 'Supporting document uploaded' }));
    } catch (err: any) {
      setUploadError(apiError(err, t('attendance.docs.uploadFailed', { defaultValue: 'Upload failed' })));
    } finally {
      setUploadingDoc(false);
    }
  };

  const handleFormChange = (field: keyof EditForm, value: string) => {
    setEditForm((prev) => {
      const updated: EditForm = { ...prev, [field]: value };
      if (field === 'status' && LEAVE_STATUSES.has(value)) {
        updated.checkIn = '';
        updated.checkOut = '';
        updated.breakIn = '';
        updated.breakOut = '';
        updated.interruptionIn = '';
        updated.interruptionOut = '';
        updated.interruptionStatus = '';
        updated.workingHours = '0';
        return updated;
      }
      // Selecting PRESENT resets the day to the standard workday
      // defaults (08:00–16:30 with a lunch break, no interruption).
      if (field === 'status' && value === 'PRESENT') {
        updated.checkIn = '08:00';
        updated.checkOut = '16:30';
        updated.breakIn = '12:00';
        updated.breakOut = '12:30';
        // Interruption defaults to '00:00 → 00:00' (zero-length, no deduction)
        // so the operator can adjust just one end without re-entering both.
        updated.interruptionIn = '00:00';
        updated.interruptionOut = '00:00';
        updated.interruptionStatus = '';
        const calculated = calcHours(updated.checkIn, updated.checkOut, updated.breakIn, updated.breakOut);
        updated.workingHours = calculated || '8';
        return updated;
      }
      if (['checkIn', 'checkOut', 'breakIn', 'breakOut', 'interruptionIn', 'interruptionOut'].includes(field)) {
        const calculated = calcHours(
          updated.checkIn, updated.checkOut, updated.breakIn, updated.breakOut,
          updated.interruptionIn, updated.interruptionOut,
        );
        // Empty string == inputs are incomplete, leave previous value.
        // '0' is a valid result (whole-day interruption) and must overwrite.
        if (calculated !== '') updated.workingHours = calculated;
      }
      return updated;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const isLeave = LEAVE_STATUSES.has(editForm.status);
      // Treat '00:00 → 00:00' (the PRESENT-default placeholder) as "no
      // interruption" — strip it to null so DB rows don't carry a
      // misleading zero-length interruption banner.
      const interIn  = (editForm.interruptionIn  || '').trim();
      const interOut = (editForm.interruptionOut || '').trim();
      const interEmpty = (!interIn || interIn === '00:00') && (!interOut || interOut === '00:00');
      const payload: any = {
        status: editForm.status,
        checkIn:  isLeave ? null : (editForm.checkIn  || null),
        checkOut: isLeave ? null : (editForm.checkOut || null),
        breakIn:  isLeave ? null : (editForm.breakIn  || null),
        breakOut: isLeave ? null : (editForm.breakOut || null),
        interruptionIn:     isLeave || interEmpty ? null : (interIn  || null),
        interruptionOut:    isLeave || interEmpty ? null : (interOut || null),
        interruptionStatus: isLeave || interEmpty ? null : (editForm.interruptionStatus || null),
        // Phase 3 (#29) — workingHours is recomputed server-side from
        // the canonical times. The frontend preview must never be the
        // persisted value.
        notes: editForm.notes || undefined,
      };
      if (editRecord?.id) {
        await attendanceApi.update(editRecord.id, payload);
        toast.success(t('attendance.toast.recordUpdated'));
      } else {
        await attendanceApi.upsert({ employeeId: id, date: editDate, ...payload });
        toast.success(t('attendance.toast.recordSaved'));
      }
      setShowEditModal(false);
      fetchData();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteRecord?.id) return;
    setDeleting(true);
    try {
      // Roles without attendance:delete fall through to the softer
      // /clear endpoint, which does the same row removal under the
      // attendance:update permission. Same UX, no escalation.
      if (canDelAtt) {
        await attendanceApi.delete(deleteRecord.id);
      } else {
        await attendanceApi.clear(deleteRecord.id);
      }
      toast.success(t('attendance.toast.recordDeleted'));
      setShowDeleteModal(false);
      setDeleteRecord(null);
      fetchData();
    } catch (err: any) {
      toast.error(apiError(err, tc('toast.deleteFailed')));
    } finally {
      setDeleting(false);
    }
  };

  // ── Derived values ─────────────────────────────────────────────────────────────

  const fullName = employee
    ? `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim()
    : '…';
  const initials = employee
    ? `${employee.firstName?.[0] ?? ''}${employee.lastName?.[0] ?? ''}`.toUpperCase()
    : '?';

  const recordByDate = (date: string) =>
    records.find((r) => r.date?.slice(0, 10) === date);

  // Phase 2C #33 — prefer an employee-specific lock; fall back to a
  // legacy global one. Either blocks edits for this employee/month.
  const employeeLock = lockedPeriods.find((p: any) => p.year === year && p.month === month && p.employeeId === id);
  const globalLock = lockedPeriods.find((p: any) => p.year === year && p.month === month && !p.employeeId);
  // Locks are per-employee. A legacy global lock is surfaced through the
  // modal (so SUPER can clear it) but no longer blocks edits on this
  // employee's sheet — the backend mirrors the same policy.
  const currentLock = employeeLock ?? globalLock;
  const isLocked = !!employeeLock;
  const isGlobalLock = !employeeLock && !!globalLock;

  // ── Render ─────────────────────────────────────────────────────────────────────

  // Hard-gate: users without attendance:read see an access-denied panel even
  // if they navigated here directly by URL. The Employee Profile tab is
  // already gated on the same permission, but defending here too means the
  // standalone /dashboard/attendance/:id route can't be reached either.
  if (!canReadAtt) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        You don't have permission to view attendance.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back button — hidden when embedded inside Employee Profile. */}
      {!hideBackButton && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/dashboard/attendance')}
            className="text-muted-foreground hover:text-foreground -ms-2"
          >
            <ArrowLeft className="w-4 h-4 me-1" />
            Back to Attendance Sheets
          </Button>
        </div>
      )}

      {/* Toolbar card — matches AttendanceTab layout */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              {loading ? <span className="text-muted-foreground">Loading…</span> : fullName}
              {isLocked && (
                <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 ms-2">
                  <Lock className="w-3 h-3 me-1" />
                  {isGlobalLock ? 'Locked (Global)' : 'Locked (this employee)'}
                </Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES.map((name, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {YEARS.map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => setShowExportModal(true)}>
                <Download className="w-4 h-4 me-1" />Export
              </Button>
              {canCreateAtt && (
                <Button variant="outline" size="sm" onClick={() => setShowBulkFill(true)} disabled={isLocked}>
                  <ClipboardList className="w-4 h-4 me-1" />Fill Month
                </Button>
              )}
              {canDelAtt && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowLockModal(true)}
                  className={isLocked ? 'text-amber-700 hover:text-amber-800' : ''}
                >
                  {isLocked
                    ? <Unlock className="w-4 h-4 me-1" />
                    : <Lock className="w-4 h-4 me-1" />}
                  {isLocked ? 'Unlock' : 'Lock'} Period
                </Button>
              )}
              {canDelAtt && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleResetMonth}
                  disabled={isLocked || resettingMonth || loading}
                  className="text-red-600 hover:text-red-700 border-red-200 hover:bg-red-50"
                  title={t('attendance.resetMonth.title', { defaultValue: 'Reset whole month' })}
                >
                  <Trash2 className="w-4 h-4 me-1" />
                  {resettingMonth ? '…' : t('attendance.resetMonth.button', { defaultValue: 'Reset Month' })}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={fetchData} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>

        {/* Employee info + lock notice */}
        {(employee || isLocked) && (
          <CardContent className="pt-0 space-y-3">
            {employee && (
              <div className="flex items-center gap-3">
                {employee.photoUrl ? (
                  <img
                    src={
                      employee.photoUrl.startsWith('http')
                        ? employee.photoUrl
                        : `${(import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '')}${employee.photoUrl}`
                    }
                    alt={fullName}
                    className="w-9 h-9 rounded-full object-cover shrink-0"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-[#EFF6FF] flex items-center justify-center text-[#2563EB] text-sm font-bold shrink-0">
                    {initials}
                  </div>
                )}
                <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-sm text-muted-foreground">
                  {employee.status && (
                    <Badge
                      variant="outline"
                      className={
                        employee.status === 'ACTIVE'
                          ? 'bg-green-100 text-green-700 border-green-200'
                          : employee.status === 'ON_LEAVE'
                          ? 'bg-blue-100 text-blue-700 border-blue-200'
                          : employee.status === 'INACTIVE'
                          ? 'bg-gray-100 text-gray-600 border-gray-200'
                          : 'bg-amber-100 text-amber-700 border-amber-200'
                      }
                    >
                      {employee.status.replace(/_/g, ' ')}
                    </Badge>
                  )}
                  <span className="flex items-center gap-1">
                    <User className="w-3.5 h-3.5" />
                    ID: {employee.employeeNumber ?? '—'}
                  </span>
                  {(employee.agency?.name ?? employee.agencyName) && (
                    <span>Agency: {employee.agency?.name ?? employee.agencyName}</span>
                  )}
                  {employee.email && <span>{employee.email}</span>}
                </div>
              </div>
            )}
            {isLocked && (
              <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <Lock className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <strong>Period locked.</strong> Attendance edits are disabled for {MONTH_NAMES[month - 1]} {year}.
                  Use the "Unlock Period" button to reopen.
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Summary tiles — same SummaryTile style as AttendanceTab */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <SummaryTile
          label="Present"
          value={fmtHours(summary?.presentHours)}
          subValue={fmtDays(summary?.presentHours)}
          tone="emerald"
        />
        <SummaryTile
          label="Public Holiday"
          value={fmtHours(summary?.holidayHours)}
          subValue={fmtDays(summary?.holidayHours)}
          tone="purple"
        />
        <SummaryTile
          label="Vacation"
          value={fmtHours(summary?.vacationHours)}
          subValue={fmtDays(summary?.vacationHours)}
          tone="blue"
        />
        <SummaryTile
          label="Sick Leave"
          value={fmtHours(summary?.sickHours)}
          subValue={fmtDays(summary?.sickHours)}
          tone="violet"
        />
        <SummaryTile
          label="Unpaid Leave"
          value={fmtHours(summary?.unpaidLeaveHours)}
          subValue={fmtDays(summary?.unpaidLeaveHours)}
          tone="orange"
        />
        <SummaryTile
          label="Paid Leave"
          value={fmtHours(summary?.paidLeaveHours)}
          subValue={fmtDays(summary?.paidLeaveHours)}
          tone="amber"
        />
        <SummaryTile
          label="Absent"
          value={fmtHours(summary?.absentHours)}
          subValue={fmtDays(summary?.absentHours)}
          tone="red"
        />
        <SummaryTile
          label="Monthly Total"
          value={fmtHours(summary?.monthlyTotalHours)}
          tone="slate"
        />
      </div>

      {/* Daily attendance table — same table style as AttendanceTab */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-start px-3 py-2 font-medium w-10">#</th>
                  <th className="text-start px-3 py-2 font-medium">Date</th>
                  <th className="text-start px-3 py-2 font-medium">Status</th>
                  <th className="text-start px-3 py-2 font-medium">Check In</th>
                  <th className="text-start px-3 py-2 font-medium">Check Out</th>
                  <th className="text-start px-3 py-2 font-medium">Break In</th>
                  <th className="text-start px-3 py-2 font-medium">Break Out</th>
                  <th className="text-start px-3 py-2 font-medium">Interr. In</th>
                  <th className="text-start px-3 py-2 font-medium">Interr. Out</th>
                  <th className="text-end px-3 py-2 font-medium">Total</th>
                  <th className="text-start px-3 py-2 font-medium">Notes</th>
                  <th className="px-3 py-2 w-24" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={12} className="p-6 text-center text-muted-foreground">
                      Loading attendance records…
                    </td>
                  </tr>
                ) : (
                  days.map((day) => {
                    const record = recordByDate(day.date);
                    const isHoliday = isSlovakPublicHoliday(day.date);
                    return (
                      <tr
                        key={day.date}
                        className={`border-t hover:bg-muted/20 ${
                          isHoliday ? 'bg-purple-50/40' : day.isWeekend ? 'bg-muted/10' : ''
                        }`}
                      >
                        <td className="px-3 py-1.5 text-muted-foreground">{day.dayNum}</td>
                        <td className="px-3 py-1.5">
                          <div>
                            <span className="inline-flex items-center gap-1.5">
                              {day.date}
                              {day.isWeekend && (
                                <span className="text-xs text-muted-foreground ms-1">· {day.dayName}</span>
                              )}
                            </span>
                            {isHoliday && (
                              <div className="text-[10px] text-purple-700 italic">
                                {slovakPublicHolidayName(day.date)}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-1.5">
                          {record?.status ? (
                            <Badge
                              variant="outline"
                              className={`text-xs ${statusColors[record.status] ?? 'bg-gray-100 text-gray-600'}`}
                            >
                              {statusLabels[record.status] ?? record.status}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">—</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 font-mono">{record?.checkIn  ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono">{record?.checkOut ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono">{record?.breakIn  ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono">{record?.breakOut ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono">{record?.interruptionIn ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono">
                          {record?.interruptionOut ? (
                            <div className="leading-tight">
                              <div>{record.interruptionOut}</div>
                              {record.interruptionStatus && (
                                <div className="text-[10px] text-muted-foreground italic">
                                  → {statusLabels[record.interruptionStatus] ?? record.interruptionStatus}
                                </div>
                              )}
                            </div>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-end font-medium">
                          {record?.workingHours != null
                            ? `${Number(record.workingHours).toFixed(2).replace(/\.?0+$/, '')}h`
                            : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground truncate max-w-xs">
                          {record?.notes ?? ''}
                        </td>
                        <td className="px-3 py-1.5 text-end whitespace-nowrap">
                          {record ? (
                            <span className="inline-flex items-center gap-1">
                              {record.id && Array.isArray(record.attachments) && record.attachments.length > 0 && (
                                <AttachmentClip
                                  files={record.attachments}
                                  canDelete={canEditAtt && !isLocked}
                                  onDelete={async (documentId) => {
                                    try {
                                      await attendanceApi.deleteAttachment(record.id, documentId);
                                      setRecords((prev) => prev.map((r) => r.id === record.id
                                        ? {
                                            ...r,
                                            attachments: (r.attachments ?? []).filter((a: any) => a.id !== documentId),
                                            attachmentCount: Math.max(0, (r.attachmentCount ?? 0) - 1),
                                          }
                                        : r));
                                      toast.success(t('attendance.docs.deleted', { defaultValue: 'Attachment deleted' }));
                                    } catch (err: any) {
                                      toast.error(apiError(err, t('attendance.docs.deleteFailed', { defaultValue: 'Delete failed' })));
                                    }
                                  }}
                                />
                              )}
                              {canEditAtt && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2"
                                  onClick={() => openEditModal(record, day.date)}
                                  disabled={isLocked}
                                >
                                  <Pencil className="w-3.5 h-3.5 me-1" />Edit
                                </Button>
                              )}
                              {canDelAtt ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                                  onClick={() => { setDeleteRecord(record); setShowDeleteModal(true); }}
                                  disabled={isLocked}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              ) : canEditAtt && (
                                // Softer 'Clear' affordance for roles that hold attendance:update
                                // but not attendance:delete. Backend uses /attendance/:id/clear,
                                // which calls the same row-removal path under a softer
                                // permission. Same confirm modal, different label.
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                                  onClick={() => { setDeleteRecord(record); setShowDeleteModal(true); }}
                                  disabled={isLocked}
                                  title={t('attendance.clearRow.button', { defaultValue: 'Clear this day' })}
                                >
                                  <Eraser className="w-3.5 h-3.5 me-1" />
                                  {t('attendance.clearRow.label', { defaultValue: 'Clear' })}
                                </Button>
                              )}
                            </span>
                          ) : (
                            canCreateAtt && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-muted-foreground hover:text-foreground"
                                onClick={() => openEditModal(null, day.date)}
                                disabled={isLocked}
                              >
                                <Plus className="w-3.5 h-3.5 me-1" />Add
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Edit / Add Attendance Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editRecord
                ? <><Pencil className="w-5 h-5 text-blue-600" />Edit Attendance</>
                : <><Plus className="w-5 h-5 text-blue-600" />Add Attendance</>}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-muted/30 text-sm font-medium">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                {editDate}
                {isSlovakPublicHoliday(editDate) && (
                  <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-xs">
                    sviatok · {slovakPublicHolidayName(editDate)}
                  </Badge>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-status">Status</Label>
              <Select value={editForm.status} onValueChange={(v) => handleFormChange('status', v)}>
                <SelectTrigger id="edit-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {editForm.status === 'PRESENT' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-checkin">Check In</Label>
                    <Input id="edit-checkin" type="time" lang="en-GB" value={editForm.checkIn} onChange={(e) => handleFormChange('checkIn', e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-checkout">Check Out</Label>
                    <Input id="edit-checkout" type="time" lang="en-GB" value={editForm.checkOut} onChange={(e) => handleFormChange('checkOut', e.target.value)} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-breakin">Break In (zac pres)</Label>
                    <Input id="edit-breakin" type="time" lang="en-GB" value={editForm.breakIn} onChange={(e) => handleFormChange('breakIn', e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-breakout">Break Out (kon pres)</Label>
                    <Input id="edit-breakout" type="time" lang="en-GB" value={editForm.breakOut} onChange={(e) => handleFormChange('breakOut', e.target.value)} />
                  </div>
                </div>

                <div className="space-y-2 rounded-md border border-dashed border-amber-300 bg-amber-50/40 p-3">
                  <p className="text-xs font-semibold text-amber-800">
                    In-day interruption (zac prer / kon prer)
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Optional. Records hours the employee was away during the day (e.g. doctor's visit).
                    The duration is deducted from the daily total and added to the selected leave status's monthly total.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-interruption-in" className="text-xs">Interruption In (zac prer)</Label>
                      <Input id="edit-interruption-in" type="time" lang="en-GB" value={editForm.interruptionIn} onChange={(e) => handleFormChange('interruptionIn', e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-interruption-out" className="text-xs">Interruption Out (kon prer)</Label>
                      <Input id="edit-interruption-out" type="time" lang="en-GB" value={editForm.interruptionOut} onChange={(e) => handleFormChange('interruptionOut', e.target.value)} />
                    </div>
                  </div>
                  {(editForm.interruptionIn || editForm.interruptionOut) && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Attribute interruption to</Label>
                      <Select value={editForm.interruptionStatus || ''} onValueChange={(v) => handleFormChange('interruptionStatus', v)}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a leave status" />
                        </SelectTrigger>
                        <SelectContent>
                          {INTERRUPTION_STATUS_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </>
            )}

            {editForm.status !== 'PRESENT' && (
              <div className="rounded-md bg-muted/40 border p-3 text-xs text-muted-foreground">
                On non-Present statuses, all time fields are recorded as <strong>0:00</strong>. The day counts as
                <strong> 8 hours</strong> towards the monthly total for the selected status — Check-in / Check-out /
                Break inputs are intentionally hidden.
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="edit-hours">
                Total Working Hours
                <span className="text-xs text-muted-foreground ms-2">(auto-calculated)</span>
              </Label>
              <Input
                id="edit-hours"
                type="number"
                step="0.01"
                min="0"
                max="24"
                value={editForm.workingHours}
                onChange={(e) => handleFormChange('workingHours', e.target.value)}
                placeholder="e.g. 7.5"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea
                id="edit-notes"
                value={editForm.notes}
                onChange={(e) => handleFormChange('notes', e.target.value)}
                placeholder="Optional notes…"
                rows={2}
              />
            </div>

            {/* Phase 2C #32 — supporting documents for this attendance record.
                Only shown when editing an existing row (the document needs a
                stable attendance.id to attach to). */}
            {editRecord?.id && (
              <div className="space-y-2 border-t pt-3">
                <Label>{t('attendance.docs.title', { defaultValue: 'Supporting Documents' })}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('attendance.docs.help', { defaultValue: 'Attach a doctor\'s note, medical certificate, or other supporting file.' })}
                </p>
                {uploadError && (
                  <p role="alert" className="text-xs text-red-600">{uploadError}</p>
                )}
                {attendanceDocs.length > 0 && (
                  <ul className="text-sm space-y-1">
                    {attendanceDocs.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 border rounded px-2 py-1">
                        <span className="truncate">{d.name}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {d.fileUrl && (
                            <a
                              href={`${d.fileUrl?.startsWith('http') ? '' : API_BASE}${d.fileUrl}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              download
                              className="text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5"
                            >
                              <Download className="w-3 h-3" />{t('attendance.docs.download', { defaultValue: 'Download' })}
                            </a>
                          )}
                          <Link to={`/dashboard/documents/${d.id}`} className="text-xs text-blue-600 hover:underline">
                            {t('attendance.docs.view', { defaultValue: 'View' })}
                          </Link>
                          {canEditAtt && editRecord?.id && (
                            <button
                              type="button"
                              className="text-red-600 hover:text-red-700"
                              title={t('attendance.docs.delete', { defaultValue: 'Delete' })}
                              aria-label={t('attendance.docs.delete', { defaultValue: 'Delete' })}
                              onClick={async () => {
                                const ok = await confirm({
                                  title: t('attendance.docs.deleteTitle', { defaultValue: 'Delete attachment?' }),
                                  description: t('attendance.docs.deleteConfirm', {
                                    defaultValue: 'Remove "{{name}}" from this attendance record?',
                                    name: d.name,
                                  }),
                                  confirmText: t('attendance.docs.delete', { defaultValue: 'Delete' }),
                                  tone: 'destructive',
                                });
                                if (!ok) return;
                                try {
                                  await attendanceApi.deleteAttachment(editRecord.id, d.id);
                                  setAttendanceDocs((prev) => prev.filter((x) => x.id !== d.id));
                                  setRecords((prev) => prev.map((r) => r.id === editRecord.id
                                    ? {
                                        ...r,
                                        attachments: (r.attachments ?? []).filter((a: any) => a.id !== d.id),
                                        attachmentCount: Math.max(0, (r.attachmentCount ?? 0) - 1),
                                      }
                                    : r));
                                  toast.success(t('attendance.docs.deleted', { defaultValue: 'Attachment deleted' }));
                                } catch (err: any) {
                                  toast.error(apiError(err, t('attendance.docs.deleteFailed', { defaultValue: 'Delete failed' })));
                                }
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Select value={uploadDocTypeId} onValueChange={setUploadDocTypeId}>
                    <SelectTrigger className="w-full sm:w-48">
                      <SelectValue placeholder={t('attendance.docs.typePh', { defaultValue: 'Document type' })} />
                    </SelectTrigger>
                    <SelectContent>
                      {attendanceDocTypes.map((dt) => (
                        <SelectItem key={dt.id} value={dt.id}>{dt.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="file"
                    onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleUploadSupportingDoc}
                    disabled={uploadingDoc || !uploadFile || !uploadDocTypeId}
                  >
                    {uploadingDoc ? '…' : t('attendance.docs.upload', { defaultValue: 'Upload' })}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditModal(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editRecord ? 'Save Changes' : 'Add Record'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Fill Modal */}
      <BulkFillModal
        open={showBulkFill}
        onClose={() => setShowBulkFill(false)}
        employeeId={id}
        month={month}
        year={year}
        days={days}
        records={records}
        onSuccess={fetchData}
      />

      {/* Lock Period Modal */}
      <LockPeriodModal
        open={showLockModal}
        onClose={() => setShowLockModal(false)}
        year={year}
        month={month}
        isLocked={isLocked}
        lockId={currentLock?.id}
        employeeId={id}
        employeeName={fullName}
        isGlobalLock={isGlobalLock}
        onChanged={fetchData}
      />

      {/* Export Modal */}
      {id && (
        <ExportModal
          open={showExportModal}
          onClose={() => setShowExportModal(false)}
          employeeId={id}
          month={month}
          year={year}
          employeeName={fullName}
        />
      )}

      {/* Delete Confirmation Modal */}
      <Dialog
        open={showDeleteModal}
        onOpenChange={(open) => { if (!open) { setShowDeleteModal(false); setDeleteRecord(null); } }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="w-5 h-5" />
              Delete Attendance Record
            </DialogTitle>
          </DialogHeader>
          <div className="py-3">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete the attendance record for{' '}
              <strong>{deleteRecord?.date?.slice(0, 10)}</strong>?
              This action cannot be undone.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteModal(false); setDeleteRecord(null); }} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              <Trash2 className="w-4 h-4 me-1" />
              {deleting ? 'Deleting…' : 'Delete Record'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Summary Tile — same component pattern as AttendanceTab ───────────────────

function SummaryTile({
  label, value, subValue, tone,
}: {
  label: string;
  value: string;
  subValue?: string;
  tone: string;
}) {
  const palette: Record<string, string> = {
    emerald: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    blue:    'text-blue-700 bg-blue-50 border-blue-200',
    red:     'text-red-700 bg-red-50 border-red-200',
    violet:  'text-violet-700 bg-violet-50 border-violet-200',
    slate:   'text-slate-700 bg-slate-50 border-slate-200',
    purple:  'text-purple-700 bg-purple-50 border-purple-200',
    orange:  'text-orange-700 bg-orange-50 border-orange-200',
    amber:   'text-amber-700 bg-amber-50 border-amber-200',
  };
  return (
    <div className={`border rounded-md px-3 py-2 ${palette[tone] ?? palette.slate}`}>
      <p className="text-xs">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
      {subValue && <p className="text-xs opacity-70 mt-0.5">{subValue}</p>}
    </div>
  );
}
