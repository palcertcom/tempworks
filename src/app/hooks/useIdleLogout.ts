/** Auto-logout after N minutes of user inactivity.
 *
 *  The timeout (in minutes) is read from the server-side SystemSetting
 *  SESSION_IDLE_TIMEOUT_MINUTES and surfaced on /auth/me so every tab
 *  uses the current value without needing admin access to /settings.
 *
 *  Activity tracking uses low-frequency DOM events (mousemove, keydown,
 *  click, scroll, touchstart). The last-activity timestamp is stored
 *  in localStorage so multiple tabs share the same idle clock — typing
 *  in one tab postpones logout in all of them.
 *
 *  A warning toast fires 60 seconds before expiry so the user can
 *  extend the session by interacting with the page.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import i18n from '../../i18n';
import { authApi } from '../services/api';

const ACTIVITY_KEY   = 'last-activity-ts';
const EVENTS: (keyof DocumentEventMap)[] = [
  'mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click',
];
const WARN_BEFORE_MS = 60_000;    // Warn 60s before logout
const THROTTLE_MS    = 1_000;     // At most one write per second

export function useIdleLogout(timeoutMinutes: number | null | undefined) {
  const navigate   = useNavigate();
  const warnedRef  = useRef(false);
  const lastWriteRef = useRef(0);

  useEffect(() => {
    const minutes = Number(timeoutMinutes);
    if (!minutes || minutes <= 0 || !Number.isFinite(minutes)) return;

    const timeoutMs = minutes * 60_000;

    // Seed activity so a fresh login doesn't instantly logout if the
    // stored value is stale from a prior session.
    const now = Date.now();
    localStorage.setItem(ACTIVITY_KEY, String(now));
    lastWriteRef.current = now;
    warnedRef.current = false;

    const touch = () => {
      const t = Date.now();
      if (t - lastWriteRef.current < THROTTLE_MS) return;
      lastWriteRef.current = t;
      localStorage.setItem(ACTIVITY_KEY, String(t));
      warnedRef.current = false;
    };

    EVENTS.forEach(ev => window.addEventListener(ev, touch, { passive: true }));

    const tick = window.setInterval(async () => {
      const last = Number(localStorage.getItem(ACTIVITY_KEY) || 0);
      if (!last) return;
      const idleMs = Date.now() - last;

      if (idleMs >= timeoutMs) {
        // Stop reacting to further ticks / events before we navigate.
        localStorage.removeItem(ACTIVITY_KEY);
        try { await authApi.logout(); } catch { /* already gone */ }
        toast.warning(i18n.t('toast.idleSignedOut', { ns: 'common' }));
        navigate('/login', { replace: true });
        return;
      }

      if (!warnedRef.current && idleMs >= timeoutMs - WARN_BEFORE_MS) {
        warnedRef.current = true;
        toast.warning(i18n.t('toast.idleWarning', { ns: 'common' }));
      }
    }, 15_000);

    return () => {
      EVENTS.forEach(ev => window.removeEventListener(ev, touch));
      window.clearInterval(tick);
    };
    // navigate is stable from react-router; intentionally not a dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeoutMinutes]);
}
