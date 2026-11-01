/**
 * DateInput — a drop-in replacement for a native date input that
 * displays and accepts `dd.MM.yyyy` instead of the browser's locale
 * format (native date pickers render `mm/dd/yyyy` under en-US and there
 * is no JS/CSS way to override that).
 *
 * Contract is identical to the native element so it can be swapped
 * mechanically with no handler changes:
 *   • `value`    — ISO `yyyy-MM-dd` string (same as native)
 *   • `onChange` — called with `{ target: { value: <iso|''> } }`, so
 *                  existing `e.target.value` handlers keep working
 *   • `min` / `max` — ISO bounds, forwarded to the calendar
 *
 * The visible text is `dd.MM.yyyy`; users can type it directly or pick
 * from the calendar popover. Values are kept ISO end-to-end, so no
 * backend/API change and no timezone drift (we build the ISO string
 * from Y/M/D parts, never `new Date()` on a date-only value).
 */
import { useState, useRef, useEffect } from 'react';
import { CalendarIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Calendar } from './calendar';
import { Input } from './input';
import { cn } from './utils';

interface DateInputProps {
  value?: string | null;
  onChange?: (e: { target: { value: string } }) => void;
  id?: string;
  name?: string;
  className?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  /** Tolerate any extra native-input attribute (onBlur, autoFocus, …)
   *  so DateInput is a true drop-in for a native date input. */
  [key: string]: any;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** ISO `yyyy-MM-dd` → `dd.MM.yyyy` (empty in → empty out). */
function isoToDisplay(iso?: string | null): string {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** `dd.MM.yyyy` → ISO `yyyy-MM-dd`, or null when incomplete/invalid. */
function displayToIso(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]); const mo = Number(m[2]); const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Reject impossible day-for-month (e.g. 31.02) by round-tripping in UTC.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/** Parse an ISO date-only string to a local Date for the calendar. */
function isoToDate(iso?: string | null): Date | undefined {
  if (!iso) return undefined;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function DateInput({
  value,
  onChange,
  id,
  name,
  className,
  placeholder = 'dd.mm.yyyy',
  required,
  disabled,
  min,
  max,
  ...rest
}: DateInputProps) {
  const [text, setText] = useState<string>(isoToDisplay(value));
  const [open, setOpen] = useState(false);
  const lastEmitted = useRef<string>(value ?? '');

  // Keep the visible text in sync when the controlled ISO value changes
  // from outside (form reset, async load) — but don't clobber what the
  // user is mid-typing if it already represents the same ISO date.
  useEffect(() => {
    const incoming = value ?? '';
    if (incoming !== lastEmitted.current) {
      setText(isoToDisplay(incoming));
      lastEmitted.current = incoming;
    }
  }, [value]);

  const emit = (iso: string) => {
    lastEmitted.current = iso;
    onChange?.({ target: { value: iso } });
  };

  const handleText = (raw: string) => {
    setText(raw);
    if (raw.trim() === '') { emit(''); return; }
    const iso = displayToIso(raw);
    if (iso) emit(iso);
    // incomplete/invalid: hold the text, don't emit a bad value
  };

  const handlePick = (d?: Date) => {
    if (!d) { setText(''); emit(''); setOpen(false); return; }
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    setText(isoToDisplay(iso));
    emit(iso);
    setOpen(false);
  };

  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => handleText(e.target.value)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        className="pe-9"
        {...rest}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Open calendar"
            className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <CalendarIcon className="w-4 h-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={isoToDate(value)}
            onSelect={handlePick}
            defaultMonth={isoToDate(value)}
            fromDate={isoToDate(min)}
            toDate={isoToDate(max)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
