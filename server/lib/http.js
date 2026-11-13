// shared-kit v1 — http helpers (from Exam-AI/lib/http.ts and lifeos-online/server/src/auth.js ApiError)

export class ApiError extends Error {
  /** @param {number} status @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Wrap an async Express handler so thrown errors reach the error middleware. */
export const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse `input` with a zod schema or throw a 400 with the first issue. */
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    throw new ApiError(400, `${where}${issue?.message ?? 'Invalid request'}`);
  }
  return result.data;
}

/** Structured one-line logs (Netlify / Render show them as-is). */
export function log(level, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, ...data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Express error middleware: known errors keep their status, others become 500 without leaking details. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  log('error', { msg: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join(' | '), path: req.path });
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
