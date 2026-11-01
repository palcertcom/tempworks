import { useEffect, useState } from 'react';
import { notificationsApi, type NotificationEventMeta } from '../services/api';

/**
 * Shared cache for the notification event catalogue.
 *
 * The catalogue is server-defined (NOTIF_EVENT_META) and only changes
 * on deploy, so a single in-memory copy survives every render and
 * every route navigation. Both the NotificationCenter (event-type
 * filter, row labels) and NotificationSettings (preferences matrix
 * rows) read through this hook, replacing the hardcoded copies that
 * used to live in each page.
 *
 * Render contract:
 *   - First caller triggers a single network fetch.
 *   - Subsequent callers (and re-renders) return the cached array
 *     synchronously on the very next pass.
 *   - A failure surfaces as an empty array — callers should treat
 *     that the same as "still loading" rather than crash.
 */

let cache: NotificationEventMeta[] | null = null;
let inFlight: Promise<NotificationEventMeta[]> | null = null;
const subscribers = new Set<(m: NotificationEventMeta[]) => void>();

function fetchOnce(): Promise<NotificationEventMeta[]> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = notificationsApi.getMeta()
    .then(res => {
      const arr = Array.isArray(res?.meta) ? res.meta : [];
      cache = arr;
      subscribers.forEach(fn => fn(arr));
      return arr;
    })
    .catch(() => {
      // Mark the in-flight as resolved so the next render can retry,
      // but don't pollute the cache with a partial result.
      const empty: NotificationEventMeta[] = [];
      subscribers.forEach(fn => fn(empty));
      return empty;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function useNotificationMeta(): NotificationEventMeta[] {
  const [meta, setMeta] = useState<NotificationEventMeta[]>(cache ?? []);

  useEffect(() => {
    let mounted = true;
    const apply = (m: NotificationEventMeta[]) => { if (mounted) setMeta(m); };
    subscribers.add(apply);
    if (cache) {
      apply(cache);
    } else {
      fetchOnce().then(apply);
    }
    return () => {
      mounted = false;
      subscribers.delete(apply);
    };
  }, []);

  return meta;
}

/**
 * Resolve a single event key to its display label. Falls back to the
 * raw key when the catalogue hasn't loaded yet OR the key is unknown
 * (e.g. legacy rows that pre-date a renamed event).
 */
export function eventLabel(meta: NotificationEventMeta[], key: string | undefined | null): string {
  if (!key) return '';
  const hit = meta.find(m => m.key === key);
  return hit?.label ?? key;
}
