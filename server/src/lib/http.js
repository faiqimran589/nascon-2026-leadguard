// Express helpers: an async-safe Router, HTTP errors and request validation.
import express from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);

// Router whose handlers may be async: rejected promises go to the error handler.
export function Router() {
  const r = express.Router();
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    const orig = r[m].bind(r);
    r[m] = (p, ...handlers) =>
      orig(p, ...handlers.map((h) => (req, res, next) => {
        try {
          const out = h(req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
        } catch (e) { next(e); }
      }));
  }
  return r;
}

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) throw result.error;
  return result.data;
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const fields = {};
    for (const i of err.issues) fields[i.path.join('.') || '_'] = i.message;
    const first = err.issues[0];
    return res.status(400).json({
      error: `Invalid input${first ? `: ${first.path.join('.') || 'value'} — ${first.message}` : ''}`,
      fields,
    });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.message) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err?.code === '23505') return res.status(409).json({ error: 'That value already exists (must be unique).' });
  if (err?.code === '23503') return res.status(409).json({ error: 'This record is still referenced by other records.' });
  if (err?.code === '22P02') return res.status(404).json({ error: 'Record not found' }); // malformed uuid in URL
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
}

// Pagination params: ?page=1&pageSize=25 (max 100)
export function paging(q) {
  const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
}
