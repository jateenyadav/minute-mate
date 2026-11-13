// shared-kit v1 — atomic counters for rate limits and AI daily caps.
// Fixes the read-then-write race in Exam-AI/lib/rate-limit.ts: one atomic increment per hit,
// so parallel serverless instances can't both slip under the limit.

import { ApiError } from './http.js';

/**
 * A counter store has one method: hit(key, windowMs) -> count after this hit.
 * The window is fixed: it starts at the first hit and the counter expires at its end.
 */
export function memoryCounterStore() {
  const map = new Map();
  return {
    async hit(key, windowMs, now = Date.now()) {
      const cur = map.get(key);
      if (!cur || cur.expiresAt <= now) {
        map.set(key, { n: 1, expiresAt: now + windowMs });
        return 1;
      }
      cur.n += 1;
      return cur.n;
    },
  };
}

/**
 * Throw 429 when `key` was hit more than `limit` times in the window.
 * @param {{hit:(k:string,w:number)=>Promise<number>}} store
 */
export async function enforceLimit(store, key, limit, windowMs, message = 'Too many requests. Please wait a minute and try again.') {
  const n = await store.hit(key, windowMs);
  if (n > limit) {
    throw new ApiError(429, message, { retryAfterSeconds: Math.ceil(windowMs / 1000) });
  }
  return { used: n, remaining: Math.max(0, limit - n) };
}

/** Express middleware: per-IP limit for a group of routes. */
export function rateLimit(store, { name, limit, windowMs, keyFn = clientIp }) {
  return (req, _res, next) => {
    enforceLimit(store, `rl:${name}:${keyFn(req)}`, limit, windowMs).then(() => next(), next);
  };
}

/**
 * Real client IP. Behind Netlify the TCP peer is Netlify, so prefer Netlify's own header,
 * which Netlify sets (clients can't spoof it on Netlify Functions).
 */
export function clientIp(req) {
  return (
    req.headers['x-nf-client-connection-ip'] ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/** Start of the current UTC day, used for "per day" AI caps. */
export const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);
