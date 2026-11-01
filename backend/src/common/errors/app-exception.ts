import {
  HttpException,
  HttpStatus,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';

/**
 * Coded error envelope sent over the wire.
 *
 * The `I18nExceptionFilter` re-emits this body verbatim (plus `statusCode`,
 * `error`, `path`, `timestamp`). Frontend `apiError()` then resolves
 * `errors.<code>` for the active locale and falls back to `message` if no
 * translation is registered.
 */
export interface CodedErrorPayload {
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

/**
 * Generic coded HTTP exception.
 *
 * Usage:
 *   throw new AppException(HttpStatus.NOT_FOUND, ErrorCodes.USER.NOT_FOUND,
 *     'User not found', { id });
 *
 * The four shorthand subclasses (`BadRequestAppException`,
 * `UnauthorizedAppException`, `ForbiddenAppException`, `NotFoundAppException`,
 * `ConflictAppException`) are thin wrappers preserving the matching HTTP
 * status. They exist so that legacy handlers / Nest's `instanceof
 * NotFoundException` checks keep passing.
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: string,
    message: string,
    public readonly params?: Record<string, unknown>,
  ) {
    const payload: CodedErrorPayload = { code, message, ...(params ? { params } : {}) };
    super(payload, status);
  }
}

export class BadRequestAppException extends BadRequestException {
  constructor(code: string, message: string, params?: Record<string, unknown>) {
    super({ code, message, ...(params ? { params } : {}) } as CodedErrorPayload);
  }
}

export class UnauthorizedAppException extends UnauthorizedException {
  constructor(code: string, message: string, params?: Record<string, unknown>) {
    super({ code, message, ...(params ? { params } : {}) } as CodedErrorPayload);
  }
}

export class ForbiddenAppException extends ForbiddenException {
  constructor(code: string, message: string, params?: Record<string, unknown>) {
    super({ code, message, ...(params ? { params } : {}) } as CodedErrorPayload);
  }
}

export class NotFoundAppException extends NotFoundException {
  constructor(code: string, message: string, params?: Record<string, unknown>) {
    super({ code, message, ...(params ? { params } : {}) } as CodedErrorPayload);
  }
}

export class ConflictAppException extends ConflictException {
  constructor(code: string, message: string, params?: Record<string, unknown>) {
    super({ code, message, ...(params ? { params } : {}) } as CodedErrorPayload);
  }
}

export class InternalServerAppException extends InternalServerErrorException {
  constructor(code: string, message: string, params?: Record<string, unknown>) {
    super({ code, message, ...(params ? { params } : {}) } as CodedErrorPayload);
  }
}
