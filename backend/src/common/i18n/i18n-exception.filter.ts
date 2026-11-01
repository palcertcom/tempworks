import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Coded error envelope thrown by the backend.
 *
 * The frontend looks up `code` in its `errors.json` and renders the
 * locale-appropriate message (with `params` interpolated). `message` is
 * the canonical English fallback so non-i18n consumers (Swagger, scripts,
 * legacy clients) keep working unchanged.
 */
export interface CodedErrorBody {
  code: string;
  message: string;
  params?: Record<string, unknown>;
  /**
   * Validation-specific: per-field error envelope produced by the global
   * `ValidationPipe.exceptionFactory`. Forwarded verbatim by the filter so
   * the frontend can render inline form errors.
   */
  fields?: Array<{
    field: string;
    code: string;
    message: string;
    params?: Record<string, unknown>;
  }>;
}

const PRISMA_TO_HTTP: Record<string, { status: HttpStatus; code: string; message: string }> = {
  P2002: {
    status: HttpStatus.CONFLICT,
    code: 'GENERIC.UNIQUE_VIOLATION',
    message: 'A record with this data already exists',
  },
  P2025: {
    status: HttpStatus.NOT_FOUND,
    code: 'GENERIC.NOT_FOUND',
    message: 'Record not found',
  },
};

/**
 * Catches every exception thrown by a controller/service and emits a
 * uniform `{ statusCode, code, message, params, error, timestamp, path }`
 * response. Existing controllers that throw plain `HttpException("text")`
 * are still supported — they get assigned a stable `code` derived from the
 * HTTP status.
 */
@Catch()
export class I18nExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(I18nExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'GENERIC.UNEXPECTED';
    let message = 'Internal server error';
    let params: Record<string, unknown> | undefined;
    let fields: CodedErrorBody['fields'] | undefined;
    let errorLabel = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      errorLabel = httpStatusLabel(status);
      if (typeof body === 'string') {
        message = body;
        code = defaultCodeForStatus(status);
      } else if (body && typeof body === 'object') {
        const obj = body as Record<string, any>;
        // Already-coded shape: { code, message, params, fields, ... }
        if (typeof obj.code === 'string') {
          code = obj.code;
          message = typeof obj.message === 'string'
            ? obj.message
            : Array.isArray(obj.message)
            ? obj.message.join(', ')
            : message;
          if (obj.params && typeof obj.params === 'object') params = obj.params;
          if (Array.isArray(obj.fields)) fields = obj.fields as CodedErrorBody['fields'];
        } else {
          // Plain Nest body: { statusCode, message, error }
          message = Array.isArray(obj.message)
            ? obj.message.join(', ')
            : (typeof obj.message === 'string' ? obj.message : message);
          code = defaultCodeForStatus(status);
        }
        if (typeof obj.error === 'string') errorLabel = obj.error;
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled exception: ${exception.message}`, exception.stack);
      const prismaCode = (exception as any).code as string | undefined;
      if (prismaCode && PRISMA_TO_HTTP[prismaCode]) {
        const mapped = PRISMA_TO_HTTP[prismaCode];
        status = mapped.status;
        code = mapped.code;
        message = mapped.message;
        errorLabel = httpStatusLabel(status);
      }
    }

    response.status(status).json({
      statusCode: status,
      error: errorLabel,
      code,
      message,
      ...(params ? { params } : {}),
      ...(fields ? { fields } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}

function defaultCodeForStatus(status: HttpStatus): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:        return 'GENERIC.BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:       return 'GENERIC.UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:          return 'GENERIC.FORBIDDEN';
    case HttpStatus.NOT_FOUND:          return 'GENERIC.NOT_FOUND';
    case HttpStatus.CONFLICT:           return 'GENERIC.CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY: return 'VALIDATION_FAILED';
    case HttpStatus.TOO_MANY_REQUESTS:  return 'GENERIC.RATE_LIMITED';
    default:                            return 'GENERIC.UNEXPECTED';
  }
}

function httpStatusLabel(status: HttpStatus): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:        return 'Bad Request';
    case HttpStatus.UNAUTHORIZED:       return 'Unauthorized';
    case HttpStatus.FORBIDDEN:          return 'Forbidden';
    case HttpStatus.NOT_FOUND:          return 'Not Found';
    case HttpStatus.CONFLICT:           return 'Conflict';
    case HttpStatus.UNPROCESSABLE_ENTITY: return 'Unprocessable Entity';
    case HttpStatus.TOO_MANY_REQUESTS:  return 'Too Many Requests';
    default:                            return 'Internal Server Error';
  }
}
