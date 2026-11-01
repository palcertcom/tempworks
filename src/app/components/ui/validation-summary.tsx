import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { cn } from './utils';

interface ValidationSummaryProps {
  errors?: Record<string, string>;
  /**
   * Optional human-readable label per field path (e.g. `{ email: 'Email' }`).
   * When supplied, the bullet text is `Email: <message>` instead of bare
   * `email: <message>`. Falls back to humanizing the path.
   */
  labels?: Record<string, string>;
  className?: string;
  /** When true, renders the summary even with zero errors (useful for tests). */
  alwaysShow?: boolean;
}

function humanize(path: string): string {
  // address.zipCode → Address Zip Code; workHistory.0.role → Work History 0 Role
  return path
    .split('.')
    .map(seg =>
      seg
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, c => c.toUpperCase())
        .trim(),
    )
    .join(' › ');
}

/**
 * Banner-style summary of all field errors. Rendered above the form, it
 * gives screen-reader users a single point of focus and lets sighted users
 * see the whole list at a glance — particularly helpful on long forms with
 * fields below the fold.
 *
 * Pair with `useValidationErrors()`. Render unconditionally — the component
 * returns null when the map is empty.
 */
export function ValidationSummary({ errors, labels, className, alwaysShow }: ValidationSummaryProps) {
  const { t } = useTranslation('common');
  const entries = errors ? Object.entries(errors) : [];
  if (!alwaysShow && entries.length === 0) return null;

  return (
    <div
      className={cn(
        'rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800',
        className,
      )}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="font-semibold mb-1">
            {t('feedback.error', { defaultValue: 'Error' })}
          </p>
          <ul className="list-disc ms-5 space-y-0.5">
            {entries.map(([path, msg]) => (
              <li key={path}>
                <span className="font-medium">{labels?.[path] ?? humanize(path)}:</span>{' '}
                <span>{msg}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
