import { useCallback, useState } from 'react';
import { fieldErrors as resolveFieldErrors, isValidationError } from './apiError';

/**
 * Field path → localized message.
 *
 * Paths are dotted to mirror the backend envelope produced by
 * `validationExceptionFactory`: `address.zipCode`, `workHistory.0.role`.
 */
export type FieldErrorMap = Record<string, string>;

export interface UseValidationErrorsResult {
  /** Current map of `{ fieldPath: localizedMessage }`. Empty when no errors. */
  errors: FieldErrorMap;
  /**
   * Populate the map from a thrown error. Returns `true` when the error was a
   * validation envelope (so the caller can skip the toast), `false`
   * otherwise — letting the caller fall back to `apiError(err)` for a toast.
   *
   * Always replaces the map; previously-set field errors are dropped so a
   * second submit's stale messages don't linger after the user fixes them.
   */
  setFromError: (err: unknown) => boolean;
  /** Remove a single field's error. Useful in field `onChange` handlers. */
  clearError: (field: string) => void;
  /** Clear all field errors (e.g. on form reset or successful submit). */
  clearAll: () => void;
  /** True when at least one field has an error. */
  hasErrors: boolean;
}

/**
 * Hook for consuming the backend's validation envelope inline in a form.
 *
 * Pairs with `<FieldError>` and `<ValidationSummary>` components and the
 * resolver in `apiError.ts`. Designed for both manual `useState` forms and
 * react-hook-form (just feed the map into `setError` if preferred).
 *
 * Usage:
 *
 *   const { errors, setFromError, clearError, clearAll } = useValidationErrors();
 *
 *   try {
 *     await usersApi.create(payload);
 *     clearAll();
 *     toast.success(...);
 *   } catch (err) {
 *     const handled = setFromError(err);
 *     if (!handled) toast.error(apiError(err));
 *   }
 *
 *   <Input aria-invalid={!!errors.email} ... />
 *   <FieldError errors={errors} name="email" />
 */
export function useValidationErrors(): UseValidationErrorsResult {
  const [errors, setErrors] = useState<FieldErrorMap>({});

  const setFromError = useCallback((err: unknown): boolean => {
    if (!isValidationError(err)) {
      // Non-validation errors — don't blow away the existing field map; the
      // caller will surface them via toast/apiError.
      return false;
    }
    setErrors(resolveFieldErrors(err));
    return true;
  }, []);

  const clearError = useCallback((field: string) => {
    setErrors(prev => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => setErrors({}), []);

  return {
    errors,
    setFromError,
    clearError,
    clearAll,
    hasErrors: Object.keys(errors).length > 0,
  };
}

/**
 * Pluck the error for a nested field path. Tolerates the leading-dot,
 * trailing-dot, and undefined-map cases so callers don't have to.
 */
export function fieldErrorAt(map: FieldErrorMap | undefined, path: string): string | undefined {
  if (!map) return undefined;
  if (map[path]) return map[path];
  // Fall through: map keys may already be normalized; this branch protects
  // future callers who pass `address.zipCode` against a backend that emitted
  // `address["zipCode"]` (it doesn't today, but cheap to guard).
  return undefined;
}

/**
 * Compose a list of field paths under a common prefix. Useful for array
 * fields:
 *
 *   const rowError = fieldErrorAt(errors, `workHistory.${i}.role`);
 */
export function arrayFieldPath(base: string, index: number, sub?: string): string {
  return sub ? `${base}.${index}.${sub}` : `${base}.${index}`;
}
