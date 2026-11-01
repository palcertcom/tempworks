import i18n from './index';

/**
 * Resolve a backend error response into a localized message.
 *
 * The backend's `I18nExceptionFilter` emits envelopes shaped
 * `{ statusCode, code, message, params? }`. This helper looks `code` up in
 * the `errors` namespace (split into `<group>.<KEY>`) and falls back to
 * the canonical English `message` if no translation is registered, and
 * finally to a generic localized "something went wrong" string.
 *
 * Use it everywhere a backend error is shown to the user. Pass the raw
 * thrown error object (the result of `await api.foo()` in a catch block).
 */
export function apiError(err: unknown, fallback?: string): string {
  if (!err) return fallback ?? i18n.t('generic.UNEXPECTED', { ns: 'errors', defaultValue: 'Something went wrong.' });

  const e = err as Record<string, any>;
  const code: string | undefined =
    typeof e.code === 'string' ? e.code :
    typeof e.body?.code === 'string' ? e.body.code :
    typeof e.response?.code === 'string' ? e.response.code :
    typeof e.response?.data?.code === 'string' ? e.response.data.code :
    undefined;

  const params: Record<string, unknown> | undefined =
    e.params && typeof e.params === 'object' ? e.params :
    e.body?.params && typeof e.body.params === 'object' ? e.body.params :
    e.response?.data?.params && typeof e.response.data.params === 'object' ? e.response.data.params :
    undefined;

  const englishFallback: string =
    typeof e.message === 'string' ? e.message :
    Array.isArray(e.message) ? e.message.join(', ') :
    typeof e.body?.message === 'string' ? e.body.message :
    typeof e.response?.data?.message === 'string' ? e.response.data.message :
    fallback ?? '';

  if (code) {
    // The backend code uses `<GROUP>.<KEY>` (e.g. `AUTH.INVALID_CREDENTIALS`).
    // i18next reads it as a nested key when we lower-case the group.
    const [group, key] = code.includes('.') ? code.split('.', 2) : ['generic', code];
    const lookupKey = `${group.toLowerCase()}.${key}`;
    const translated = i18n.t(lookupKey, {
      ns: 'errors',
      defaultValue: '',
      ...(params ?? {}),
    });
    if (translated) return translated as string;
  }

  if (englishFallback) return englishFallback;
  return i18n.t('generic.UNEXPECTED', { ns: 'errors', defaultValue: 'Something went wrong.' });
}

/**
 * Field-level validation envelope emitted by the backend's
 * `validationExceptionFactory`. The frontend renders these inline next to
 * each form input.
 */
export interface BackendFieldError {
  field: string;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

/**
 * Resolve the backend `fields[]` envelope into a `{ fieldPath: localizedString }`
 * dictionary. Skips non-validation errors and returns an empty object when
 * the envelope is absent — callers can spread the result into form state
 * without branching.
 *
 * Field paths are dotted (`address.zipCode`, `workHistory.0.role`) so
 * components attaching errors to nested form state can pluck them with the
 * same path they use to read the value.
 *
 * Translation lookup follows the same `<group>.<KEY>` convention as
 * `apiError()`: `errors.validation.<KEY>` with `params` interpolated.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  const e = err as Record<string, any> | null | undefined;
  if (!e) return {};

  const list: BackendFieldError[] | undefined =
    Array.isArray(e.fields) ? e.fields :
    Array.isArray(e.body?.fields) ? e.body.fields :
    Array.isArray(e.response?.data?.fields) ? e.response.data.fields :
    undefined;

  if (!list) return {};

  const out: Record<string, string> = {};
  for (const f of list) {
    if (!f || typeof f.field !== 'string') continue;
    const code = typeof f.code === 'string' ? f.code : 'VALIDATION.INVALID';
    const [group, key] = code.includes('.') ? code.split('.', 2) : ['validation', code];
    const lookupKey = `${group.toLowerCase()}.${key}`;
    const translated = i18n.t(lookupKey, {
      ns: 'errors',
      defaultValue: '',
      ...(f.params ?? {}),
    });
    out[f.field] = (translated as string) || f.message || i18n.t('validation.INVALID', {
      ns: 'errors',
      defaultValue: 'This value is invalid.',
    });
  }
  return out;
}

/**
 * Convenience: returns true when the error is a validation envelope
 * (top-level `code === 'VALIDATION.FAILED'` and a non-empty `fields[]`).
 * Useful for branching between toast-style and inline-style rendering.
 */
export function isValidationError(err: unknown): boolean {
  const e = err as Record<string, any> | null | undefined;
  if (!e) return false;
  const code: string | undefined =
    typeof e.code === 'string' ? e.code :
    typeof e.body?.code === 'string' ? e.body.code :
    typeof e.response?.data?.code === 'string' ? e.response.data.code :
    undefined;
  if (code !== 'VALIDATION.FAILED') return false;
  const list =
    Array.isArray(e.fields) ? e.fields :
    Array.isArray(e.body?.fields) ? e.body.fields :
    Array.isArray(e.response?.data?.fields) ? e.response.data.fields :
    [];
  return list.length > 0;
}
