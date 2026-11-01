import { BadRequestException, ValidationError } from '@nestjs/common';

/**
 * Field-level validation error envelope.
 *
 * `path` carries the dotted path through nested DTOs (e.g. `address.zipCode`)
 * so the frontend can attach the message to the correct input. `code` is a
 * stable, namespaced identifier the frontend resolves against
 * `errors.validation.<KEY>`. `message` is the canonical English fallback for
 * non-i18n consumers.
 */
export interface FieldError {
  field: string;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

/**
 * class-validator constraint name → stable code map.
 *
 * Constraint names come from `ValidationError.constraints` keys (camelCase).
 * Anything not listed falls back to `VALIDATION.INVALID` so unknown / custom
 * validators still get a sensible code without requiring catalogue updates.
 */
const CONSTRAINT_TO_CODE: Record<string, string> = {
  // Presence
  isNotEmpty:           'VALIDATION.REQUIRED',
  isDefined:            'VALIDATION.REQUIRED',
  arrayNotEmpty:        'VALIDATION.REQUIRED',

  // Type
  isString:             'VALIDATION.STRING_EXPECTED',
  isNumber:             'VALIDATION.NUMBER_EXPECTED',
  isInt:                'VALIDATION.NUMBER_EXPECTED',
  isBoolean:            'VALIDATION.BOOLEAN_EXPECTED',
  isArray:              'VALIDATION.ARRAY_EXPECTED',
  isObject:             'VALIDATION.OBJECT_EXPECTED',
  isDate:               'VALIDATION.DATE_INVALID',
  isDateString:         'VALIDATION.DATE_INVALID',
  isISO8601:            'VALIDATION.DATE_INVALID',

  // Format
  isEmail:              'VALIDATION.EMAIL_INVALID',
  isUUID:               'VALIDATION.UUID_INVALID',
  isUrl:                'VALIDATION.URL_INVALID',
  isPhoneNumber:        'VALIDATION.PHONE_INVALID',
  matches:              'VALIDATION.PATTERN_INVALID',
  isAlpha:              'VALIDATION.ALPHA_EXPECTED',
  isAlphanumeric:       'VALIDATION.ALPHANUMERIC_EXPECTED',
  isNumberString:       'VALIDATION.NUMBER_STRING_EXPECTED',

  // Length
  minLength:            'VALIDATION.MIN_LENGTH',
  maxLength:            'VALIDATION.MAX_LENGTH',
  length:               'VALIDATION.LENGTH',
  arrayMinSize:         'VALIDATION.MIN_LENGTH',
  arrayMaxSize:         'VALIDATION.MAX_LENGTH',

  // Range
  min:                  'VALIDATION.MIN_VALUE',
  max:                  'VALIDATION.MAX_VALUE',
  isPositive:           'VALIDATION.POSITIVE_REQUIRED',
  isNegative:           'VALIDATION.NEGATIVE_REQUIRED',

  // Enums / sets
  isEnum:               'VALIDATION.ENUM_INVALID',
  isIn:                 'VALIDATION.ENUM_INVALID',
  isNotIn:              'VALIDATION.NOT_IN_REQUIRED',

  // Files
  isFile:               'VALIDATION.FILE_INVALID',
  hasMimeType:          'VALIDATION.FILE_TYPE_INVALID',
  maxFileSize:          'VALIDATION.FILE_TOO_LARGE',
};

/**
 * Pull `params` out of the constraint name when the message text encodes
 * parameter values that are useful to the client (e.g. `minLength` carries
 * the `min` integer in the message; we re-extract it as a structured field).
 *
 * Falling back to an empty `params` is always safe — the frontend simply
 * renders the canonical English string.
 */
function extractParams(constraintName: string, message: string): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  const numberMatch = message.match(/(\d+)/);
  switch (constraintName) {
    case 'minLength':
    case 'arrayMinSize':
      if (numberMatch) m.min = Number(numberMatch[1]);
      break;
    case 'maxLength':
    case 'arrayMaxSize':
    case 'maxFileSize':
      if (numberMatch) m.max = Number(numberMatch[1]);
      break;
    case 'min':
      if (numberMatch) m.min = Number(numberMatch[1]);
      break;
    case 'max':
      if (numberMatch) m.max = Number(numberMatch[1]);
      break;
    case 'length': {
      const both = message.match(/(\d+)\D+(\d+)/);
      if (both) { m.min = Number(both[1]); m.max = Number(both[2]); }
      else if (numberMatch) m.min = Number(numberMatch[1]);
      break;
    }
  }
  return m;
}

/**
 * Walk a (possibly nested) class-validator error tree and flatten it into a
 * list of `FieldError` envelopes. Nested DTOs surface as dotted paths
 * (`address.zipCode`); array indices appear as numeric segments
 * (`workHistory.0.role`).
 */
function flattenErrors(
  errors: ValidationError[],
  parentPath: string[] = [],
): FieldError[] {
  const out: FieldError[] = [];
  for (const err of errors) {
    const segment = err.property;
    const path = [...parentPath, segment];
    const fieldPath = path.join('.');
    if (err.constraints) {
      for (const [constraintName, message] of Object.entries(err.constraints)) {
        out.push({
          field: fieldPath,
          code: CONSTRAINT_TO_CODE[constraintName] ?? 'VALIDATION.INVALID',
          message,
          ...(Object.keys(extractParams(constraintName, message)).length
            ? { params: extractParams(constraintName, message) }
            : {}),
        });
      }
    }
    if (err.children && err.children.length > 0) {
      out.push(...flattenErrors(err.children, path));
    }
  }
  return out;
}

/**
 * Drop-in `exceptionFactory` for `ValidationPipe`.
 *
 * Emits a coded envelope shaped like:
 *   {
 *     code: 'VALIDATION.FAILED',
 *     message: 'Validation failed',
 *     fields: [{ field, code, message, params? }, ...]
 *   }
 *
 * The `I18nExceptionFilter` forwards `fields` to the wire response unchanged.
 * The first field's English `message` is concatenated into the top-level
 * `message` so legacy clients reading only `message` see something useful.
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const fields = flattenErrors(errors);
  const summary =
    fields.length === 0
      ? 'Validation failed'
      : fields.length === 1
      ? fields[0].message
      : `Validation failed: ${fields.map(f => f.message).join('; ')}`;
  return new BadRequestException({
    code: 'VALIDATION.FAILED',
    message: summary,
    fields,
  });
}
