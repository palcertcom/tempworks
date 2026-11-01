import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { newRequestId, tenantALS, currentRequestContext } from '../context/als';

/**
 * Phase 0 stub: ensures every request has a stable `X-Request-Id` and an
 * ALS frame, even if the SaaS TenantContextMiddleware isn't mounted.
 *
 * Wired into AppModule in Phase 1 (TKT-13). NOT YET MOUNTED.
 *
 * If the request already has an ALS frame (from TenantContextMiddleware),
 * this middleware is a no-op for ALS — it only ensures the response
 * header is set.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : newRequestId();
    res.setHeader('X-Request-Id', requestId);

    if (currentRequestContext()) {
      // Already in an ALS frame: the SaaS middleware ran first.
      return next();
    }
    tenantALS.run({ requestId }, () => next());
  }
}
