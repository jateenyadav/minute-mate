// shared-kit v1.1 — email/password auth with hashed sessions + private demo accounts.
// Ported from lifeos-online/server/src/auth.js (dummy-hash timing defence, SHA-256 token hashes)
// and lifeos-online/server/src/app.js:75-89 (cookie-or-Bearer token reading).

import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ApiError } from './http.js';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export const publicUser = (user) => ({
  id: String(user._id),
  name: user.name,
  email: user.demo ? null : user.email, // demo accounts have a made-up address: don't show it
  demo: Boolean(user.demo),
  ...(user.demo && user.demoExpiresAt ? { demoExpiresAt: new Date(user.demoExpiresAt).toISOString() } : {}),
});

/**
 * @param {object} deps
 * @param {{findByEmail, findById, create, createDemo?, expiredDemoIds?, deleteById?}} deps.users
 * @param {{create, findActive, deleteByHash, deleteByUser}} deps.sessions
 * @param {number} [deps.sessionDays]
 * @param {{name?: string, hours?: number, seed?: (user: object) => Promise<void>}} [deps.demo]
 *   turn on "Try the demo": each visitor gets a private account with sample data
 * @param {(userId: string) => Promise<void>} [deps.onDeleteUser] delete the app's own data for a user
 */
export function createAuthService({ users, sessions, sessionDays = 30, demo, onDeleteUser }) {
  const dummyHash = bcrypt.hash(randomBytes(32).toString('hex'), 12);

  /** App data first, then sessions, then the user: a failure part-way leaves nothing orphaned behind a live login. */
  async function removeUser(userId) {
    if (onDeleteUser) await onDeleteUser(userId);
    await sessions.deleteByUser(userId);
    if (users.deleteById) await users.deleteById(userId);
  }

  async function newSession(user, days = sessionDays) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + days * 86400000);
    await sessions.create({ tokenHash: hashToken(token), userId: String(user._id), expiresAt });
    return { token, expiresAt, user: publicUser(user) };
  }

  return {
    async register({ name, email, password }) {
      const normalized = email.trim().toLowerCase();
      if (await users.findByEmail(normalized)) throw new ApiError(409, 'This email already has an account. Please sign in.');
      const passwordHash = await bcrypt.hash(password, 12);
      let user;
      try {
        user = await users.create({ name: name.trim(), email: normalized, passwordHash });
      } catch (error) {
        if (error?.code === 11000) throw new ApiError(409, 'This email already has an account. Please sign in.');
        throw error;
      }
      return newSession(user);
    },

    async login({ email, password }) {
      const user = await users.findByEmail(email.trim().toLowerCase());
      // Always run bcrypt so a missing account takes as long as a wrong password.
      const ok = await bcrypt.compare(password, user?.passwordHash || (await dummyHash));
      if (!user?.passwordHash || !ok) throw new ApiError(401, 'Incorrect email or password.');
      return newSession(user);
    },

    /**
     * "Try the demo": a private account with sample data that expires on its own. No sign-up.
     * Old demo accounts are swept here, because serverless hosts have no background process.
     */
    async demo() {
      if (!demo || !users.createDemo) throw new ApiError(404, 'The demo is not available.');
      const hours = demo.hours ?? 24;
      await this.sweepDemos().catch(() => {}); // cleanup must never block a visitor
      const user = await users.createDemo({ name: demo.name ?? 'Demo visitor', expiresAt: new Date(Date.now() + hours * 3600000) });
      try {
        if (demo.seed) await demo.seed(user);
      } catch (error) {
        await removeUser(String(user._id)).catch(() => {});
        throw error;
      }
      return newSession(user, hours / 24);
    },

    /** Delete up to `limit` expired demo accounts and their data. Returns how many were removed. */
    async sweepDemos(limit = 10) {
      if (!users.expiredDemoIds) return 0;
      const ids = await users.expiredDemoIds(new Date(), limit);
      for (const id of ids) await removeUser(id);
      return ids.length;
    },

    /** Delete an account for good. Real accounts must confirm with their password. */
    async deleteAccount(user, password) {
      if (!user.demo) {
        const ok = await bcrypt.compare(String(password ?? ''), user.passwordHash || (await dummyHash));
        if (!user.passwordHash || !ok) throw new ApiError(403, 'That password is not correct.');
      }
      await removeUser(String(user._id));
    },

    async current(token) {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401, 'Please sign in to continue.');
      const session = await sessions.findActive(hashToken(token), new Date());
      const user = session && (await users.findById(session.userId));
      const demoOver = user?.demo && user.demoExpiresAt && new Date(user.demoExpiresAt) <= new Date();
      if (!user || demoOver) throw new ApiError(401, 'Your session has expired. Please sign in again.');
      return user;
    },

    async logout(token) {
      if (token) await sessions.deleteByHash(hashToken(token));
    },
  };
}

/** Cookie settings. `__Host-` needs Secure, so plain name on http://localhost. */
export function cookieConfig(appName, { secure = process.env.NODE_ENV === 'production' } = {}) {
  const name = secure ? `__Host-${appName}_session` : `${appName}_session`;
  const options = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
  return {
    name,
    set(res, session) {
      res.cookie(name, session.token, { ...options, expires: session.expiresAt });
    },
    clear(res) {
      res.clearCookie(name, options);
    },
    /** Token from the cookie, or from `Authorization: Bearer` for non-browser clients. */
    read(req) {
      const fromCookie = req.cookies?.[name];
      if (fromCookie) return fromCookie;
      const header = req.headers.authorization || '';
      return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    },
  };
}

/** Express middleware factory: `requireUser` sets req.user or answers 401. `optionalUser` never blocks. */
export function authMiddleware(auth, cookie) {
  const requireUser = (req, _res, next) => {
    auth.current(cookie.read(req)).then((user) => { req.user = user; next(); }, next);
  };
  const optionalUser = (req, _res, next) => {
    const token = cookie.read(req);
    if (!token) return next();
    auth.current(token).then((user) => { req.user = user; next(); }, () => next());
  };
  return { requireUser, optionalUser };
}

/**
 * Block cross-site writes: non-GET requests must come from an allowed Origin (or same host).
 * From lifeos-online/server/src/app.js:131-140.
 */
export function originCheck(allowedOrigins = []) {
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next(); // server-to-server or same-origin fetch without Origin
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let sameHost = false;
    try { sameHost = new URL(origin).host === host; } catch { /* bad origin */ }
    if (sameHost || allowedOrigins.includes(origin)) return next();
    next(new ApiError(403, 'Origin not allowed.'));
  };
}
