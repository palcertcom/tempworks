/**
 * Server-side user-facing date formatting — `dd.MM.yyyy`.
 *
 * Mirrors the frontend src/i18n/formatters.ts so exported files (Excel,
 * PDF, Word, CSV) and any server-rendered date read the same Slovak-style
 * `24.05.2026` the UI shows. We deliberately avoid `toLocaleDateString`
 * here because it renders in the SERVER's system locale (usually US:
 * `5/24/2026`) and varies per host.
 *
 * Date-only ISO strings (`YYYY-MM-DD`, optionally with a time part) are
 * read field-by-field so a value like `2026-05-24` always renders
 * `24.05.2026` regardless of the server timezone — `new Date('2026-05-24')`
 * is UTC-midnight and would drift a day west of UTC. Full timestamps and
 * Date objects use UTC components so exports are stable across hosts.
 */

export const DISPLAY_DATE_FORMAT = 'dd.MM.yyyy';

const pad2 = (n: number): string => String(n).padStart(2, '0');

function parts(
  value: Date | string | number,
): { y: number; mo: number; d: number; h: number; mi: number } | null {
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) {
      return {
        y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
        h: m[4] ? Number(m[4]) : 0, mi: m[5] ? Number(m[5]) : 0,
      };
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // UTC components: exports must not vary with the server's local zone.
  return {
    y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate(),
    h: date.getUTCHours(), mi: date.getUTCMinutes(),
  };
}

/** `dd.MM.yyyy`, or '' for null/empty/invalid input. */
export function formatDisplayDate(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const p = parts(value);
  if (!p) return '';
  return `${pad2(p.d)}.${pad2(p.mo)}.${p.y}`;
}

/** `dd.MM.yyyy HH:mm` (24h, UTC), or '' for null/empty/invalid input. */
export function formatDisplayDateTime(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const p = parts(value);
  if (!p) return '';
  return `${pad2(p.d)}.${pad2(p.mo)}.${p.y} ${pad2(p.h)}:${pad2(p.mi)}`;
}
