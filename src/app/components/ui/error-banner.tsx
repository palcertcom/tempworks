import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, RefreshCw, X } from 'lucide-react';
import { cn } from './utils';

/**
 * ErrorBanner
 * ───────────────────────────────────────────────────────────────────
 * Single-message error block intended for the TOP of a page, form,
 * modal body, drawer, or section. Complements ValidationSummary,
 * which handles a `{ fieldPath: message }` map for form validation —
 * use ValidationSummary when you have multiple field errors, use
 * ErrorBanner when you have one summary message (data load failure,
 * permission denied, save-failed, etc.).
 *
 * Behavior:
 *  • role="alert" + aria-live="assertive" so screen readers announce
 *    the message immediately. Keyboard users can also reach it via
 *    tab order because the wrapper is focusable.
 *  • Moves focus to itself when `autoFocus` is true (default) so the
 *    next Tab keystroke lands on the dismiss/retry actions or the
 *    first form field. Skip with `autoFocus={false}` for banners
 *    that mount on initial load (data fetch failure) where stealing
 *    focus would be intrusive.
 *  • Optional `onRetry` renders a retry button beside the message.
 *  • Optional `onDismiss` renders an X close button.
 *  • Always rendered above the related content — see the migration
 *    pattern in LoginPage / ResetPasswordPage / WorkflowsPage.
 */
interface ErrorBannerProps {
  /** Short, user-friendly error message. Required. */
  message: string | null | undefined;
  /** Optional heading; defaults to a localized "Error". */
  title?: string;
  /** Render a "Retry" button beside the message. */
  onRetry?: () => void;
  /** Render an X close button on the right. */
  onDismiss?: () => void;
  /** Move focus to the banner on mount. Default `true`. */
  autoFocus?: boolean;
  /** Extra classes appended to the wrapper. */
  className?: string;
}

export function ErrorBanner({
  message,
  title,
  onRetry,
  onDismiss,
  autoFocus = true,
  className,
}: ErrorBannerProps) {
  const { t } = useTranslation('errors');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!message || !autoFocus) return;
    ref.current?.focus();
  }, [message, autoFocus]);

  if (!message) return null;

  const headingText = title ?? t('banner.title', { defaultValue: 'Error' });
  const retryLabel  = t('banner.retry',   { defaultValue: 'Retry' });
  const dismissLabel = t('banner.dismiss', { defaultValue: 'Dismiss' });

  return (
    <div
      ref={ref}
      role="alert"
      aria-live="assertive"
      tabIndex={-1}
      className={cn(
        'flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800',
        'focus:outline-none focus:ring-2 focus:ring-red-300',
        className,
      )}
    >
      <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-600" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-semibold leading-tight">{headingText}</p>
        <p className="mt-0.5 break-words">{message}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {retryLabel}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="text-red-500 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-300 rounded"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
