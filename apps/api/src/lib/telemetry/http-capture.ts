/**
 * Request-side capture for hosted error events (error-reporter.ts).
 *
 * The error handler records the exception itself (with its stack and the
 * error reference the person sees); this middleware records any other 5xx
 * response, such as a route that caught its own error and answered 500.
 * Neither changes the response, and neither can fail the request.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { captureErrorResponse, captureRequestError } from './error-reporter.js';
import { answeringRouteTemplate } from './route-templates.js';
import { rememberIssuedReference } from './scrub.js';

declare module 'hono' {
  interface ContextVariableMap {
    telemetryCaptured: boolean;
  }
}

export function captureUnhandledRequestError(c: Context, error: unknown, reference: string): void {
  try {
    // Only references the cell really issued may later travel as request IDs (scrub.ts).
    rememberIssuedReference(reference);
    captureRequestError(error, { route: answeringRouteTemplate(c), method: c.req.method, status: 500, requestId: reference });
    c.set('telemetryCaptured', true);
  } catch {
    // Telemetry never gets in the way.
  }
}

export const telemetryResponseCapture: MiddlewareHandler = async (c, next) => {
  await next();
  try {
    if (c.res.status >= 500 && !c.get('telemetryCaptured')) {
      captureErrorResponse({ route: answeringRouteTemplate(c), method: c.req.method, status: c.res.status });
    }
  } catch {
    // Telemetry never gets in the way.
  }
};
