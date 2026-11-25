import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const forbidden = (perm: string) => new HttpError(403, `Missing permission ${perm}`);
export const bad = (msg: string, details?: unknown) => new HttpError(400, msg, details);

/** Wrap async handlers so thrown errors reach the error middleware. */
export const h =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).then(
      (body) => {
        if (!res.headersSent) res.json(body ?? { ok: true });
      },
      next,
    );
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ errorMessages: ['Invalid request'], errors: err.flatten().fieldErrors });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ errorMessages: [err.message], errors: err.details ?? {} });
    return;
  }
  // body-parser errors carry a 4xx status (413 too large, 400 malformed JSON)
  const status = (err as { status?: number })?.status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ errorMessages: [status === 413 ? 'File or request is too large' : 'Malformed request body'] });
    return;
  }
  console.error(err);
  res.status(500).json({ errorMessages: ['Internal server error'] });
}
