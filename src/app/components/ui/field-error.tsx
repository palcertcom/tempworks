import { cn } from './utils';

interface FieldErrorProps {
  /** `{ fieldPath: localizedMessage }` from `useValidationErrors()`. */
  errors?: Record<string, string>;
  /** Dotted field path (e.g. `email`, `address.zipCode`, `workHistory.0.role`). */
  name: string;
  className?: string;
}

/**
 * Inline red error message rendered below a form field.
 *
 * Renders nothing when the named field has no entry in the errors map, so
 * it's safe to drop in unconditionally next to every input. Intended to pair
 * with `aria-invalid={!!errors?.[name]}` on the input itself.
 */
export function FieldError({ errors, name, className }: FieldErrorProps) {
  const msg = errors?.[name];
  if (!msg) return null;
  return (
    <p className={cn('text-xs text-red-600 mt-1', className)} role="alert" aria-live="polite">
      {msg}
    </p>
  );
}
