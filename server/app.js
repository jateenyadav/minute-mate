// Express app used both locally (server/dev.js) and on Netlify (netlify/functions/api.mjs).
// Each app adds its own routes in server/routes.js; everything else here is the same in every app.

import express from 'express';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import { createAi } from './lib/ai.js';
import { createAuthService, cookieConfig, authMiddleware, originCheck } from './lib/auth.js';
import { connectDb, mongoAuthStores, mongoCounterStore, mongoCache } from './lib/db.js';
import { rateLimit, enforceLimit, dayKey } from './lib/limits.js';
import { route, parse, errorHandler, log, ApiError } from './lib/http.js';
import { appRoutes, seedDemo, deleteUserData, BIG_BODY } from './routes.js';

export const APP = { slug: 'minute-mate', name: 'MinuteMate' };
// Every app keeps its own database on the shared cluster (never the one named in the URI).
process.env.MONGODB_DB ||= APP.slug;

const credentials = z.object({ email: z.string().trim().email().max(200), password: z.string().min(8).max(200) });
const registration = credentials.extend({ name: z.string().trim().min(1).max(80) });

/**
 * @param {object} [opts]
 * @param {ReturnType<typeof createAi>} [opts.ai]
 * @param {{hit: Function}} [opts.counters]
 * @param {() => Promise<unknown>} [opts.db]  connect before handling a request
 * @param {{aiPerDay?: number}} [opts.limits]
 */
export function createApp({ ai, counters, db = () => connectDb(), limits = {} } = {}) {
  const cache = mongoCache();
  ai ??= createAi({ budgetMs: Number(process.env.AI_BUDGET_MS || 8000), cache, log, appName: APP.name });
  counters ??= mongoCounterStore();
  const aiPerDay = limits.aiPerDay ?? Number(process.env.AI_PER_DAY || 60);

  const { users, sessions } = mongoAuthStores();
  const auth = createAuthService({
    users,
    sessions,
    demo: { name: 'Demo visitor', hours: 24, seed: seedDemo },
    onDeleteUser: deleteUserData,
  });
  const cookie = cookieConfig(APP.slug);
  const { requireUser, optionalUser } = authMiddleware(auth, cookie);

  /** Per-user daily AI cap. Call before every AI request. */
  const aiQuota = (user) => enforceLimit(counters, `ai:${user._id}:${dayKey()}`, aiPerDay, 86400000, `You've used today's ${aiPerDay} free AI requests. Come back tomorrow.`);

  const api = express.Router();
  // Small JSON bodies everywhere; routes listed in BIG_BODY parse their own larger bodies (after login).
  const smallJson = express.json({ limit: process.env.JSON_LIMIT || '1mb' });
  api.use((req, res, next) => (BIG_BODY.includes(req.path) ? next() : smallJson(req, res, next)));
  api.use(cookieParser());
  api.use(originCheck((process.env.WEB_ORIGINS || '').split(',').filter(Boolean)));

  api.get('/health', (_req, res) => res.json({ ok: true, app: APP.slug, ai: ai.status().providers.map((p) => p.name) }));

  // Everything below needs the database.
  api.use(route(async (_req, _res, next) => {
    try {
      await db();
    } catch (err) {
      log('error', { msg: 'database unavailable', detail: String(err?.message || err).slice(0, 200) });
      throw new ApiError(503, 'The database is not reachable right now. Please try again soon.');
    }
    next();
  }));

  const authLimit = rateLimit(counters, { name: 'auth', limit: 20, windowMs: 15 * 60000 });
  const send = (res, session, status = 200) => { cookie.set(res, session); res.status(status).json({ user: session.user }); };

  api.post('/auth/register', authLimit, route(async (req, res) => send(res, await auth.register(parse(registration, req.body)), 201)));
  api.post('/auth/login', authLimit, route(async (req, res) => send(res, await auth.login(parse(credentials, req.body)))));
  api.post('/auth/demo', rateLimit(counters, { name: 'demo', limit: 10, windowMs: 60 * 60000 }), route(async (_req, res) => send(res, await auth.demo(), 201)));
  api.post('/auth/logout', route(async (req, res) => { await auth.logout(cookie.read(req)); cookie.clear(res); res.json({ ok: true }); }));
  // 200 with user:null when signed out, so a logged-out page load doesn't log a 401 in the console.
  api.get('/auth/me', optionalUser, (req, res) => res.json({ user: req.user ? { id: String(req.user._id), name: req.user.name, demo: Boolean(req.user.demo), email: req.user.demo ? null : req.user.email } : null }));
  api.delete('/auth/account', requireUser, route(async (req, res) => {
    await auth.deleteAccount(req.user, req.body?.password);
    cookie.clear(res);
    res.json({ ok: true });
  }));

  api.use(appRoutes({ ai, aiQuota, requireUser, optionalUser, counters }));

  api.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  api.use(errorHandler);

  const app = express();
  app.disable('x-powered-by');
  // On Netlify, `/api/*` is rewritten to the function; serverless-http may see either path.
  app.use(['/api', '/.netlify/functions/api'], api);
  return app;
}
