import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

/** Hono's default handler prints the complete exception, including its cause. */
export const contentFreeErrorHandler: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error('[http] Unhandled request error');
  return c.text('Internal Server Error', 500);
};
