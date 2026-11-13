// shared-kit v1.1 — Mongo for serverless: one cached connection per warm function instance.
// All apps share one Atlas cluster; each app uses its own database (MONGODB_DB).

import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

let connecting;

/** Connect once and reuse. Small pool: many short-lived function instances share Atlas's connection cap. */
export function connectDb(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB) {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  if (!connecting) {
    if (!uri) throw new Error('MONGODB_URI is not set');
    connecting = mongoose
      .connect(uri, { dbName, maxPoolSize: 5, serverSelectionTimeoutMS: 8000, autoIndex: true })
      .then(() => mongoose.connection)
      .catch((err) => { connecting = undefined; throw err; });
  }
  return connecting;
}

/* ---------- shared models (created lazily so apps that don't use them pay nothing) ---------- */

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

export function kitModels() {
  const User = model('User', new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: String,
    demo: { type: Boolean, default: false },
    demoExpiresAt: { type: Date, index: { sparse: true } }, // demo accounts are swept after this
  }, { timestamps: true }));

  const Session = model('Session', new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true, expires: 0 }, // TTL index removes expired sessions
  }));

  const Counter = model('Counter', new mongoose.Schema({
    _id: String,
    n: Number,
    expiresAt: { type: Date, expires: 0 },
  }, { versionKey: false }));

  const CacheEntry = model('CacheEntry', new mongoose.Schema({
    _id: String,
    value: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, expires: 0 },
  }, { versionKey: false }));

  return { User, Session, Counter, CacheEntry };
}

/**
 * Stores in the shape lib/auth.js expects.
 * Demo accounts are one per visitor (not one shared account): nobody sees a stranger's test data,
 * and each account is deleted when it expires (see createAuthService().sweepDemos).
 */
export function mongoAuthStores() {
  const { User, Session } = kitModels();
  const users = {
    findByEmail: (email) => User.findOne({ email }).lean(),
    findById: (id) => (mongoose.isValidObjectId(id) ? User.findById(id).lean() : null),
    create: (data) => User.create(data),
    createDemo: async ({ name, expiresAt }) => {
      const doc = await User.create({
        name,
        // .invalid is a reserved TLD: this can never collide with, or send mail to, a real address.
        email: `demo-${randomBytes(9).toString('hex')}@demo.invalid`,
        demo: true,
        demoExpiresAt: expiresAt,
      });
      return doc.toObject();
    },
    expiredDemoIds: async (now, limit) =>
      (await User.find({ demo: true, demoExpiresAt: { $lte: now } }).select('_id').limit(limit).lean()).map((u) => String(u._id)),
    deleteById: (id) => User.deleteOne({ _id: id }),
  };
  const sessions = {
    create: (s) => Session.create(s),
    findActive: (tokenHash, now) => Session.findOne({ tokenHash, expiresAt: { $gt: now } }).lean(),
    deleteByHash: (tokenHash) => Session.deleteOne({ tokenHash }),
    deleteByUser: (userId) => Session.deleteMany({ userId: String(userId) }),
  };
  return { users, sessions };
}

/** Atomic counter store for lib/limits.js — a single findOneAndUpdate with $inc. */
export function mongoCounterStore() {
  const { Counter } = kitModels();
  return {
    async hit(key, windowMs, now = Date.now()) {
      // Reset an expired window first (TTL deletion can lag up to a minute).
      await Counter.deleteOne({ _id: key, expiresAt: { $lte: new Date(now) } });
      try {
        const doc = await Counter.findOneAndUpdate(
          { _id: key },
          { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date(now + windowMs) } },
          { upsert: true, returnDocument: 'after', lean: true },
        );
        return doc.n;
      } catch (err) {
        if (err?.code === 11000) return this.hit(key, windowMs, now); // two upserts raced; retry once
        throw err;
      }
    },
  };
}

/** TTL cache for lib/ai.js and external API responses. */
export function mongoCache() {
  const { CacheEntry } = kitModels();
  return {
    async get(key) {
      const doc = await CacheEntry.findOne({ _id: key, expiresAt: { $gt: new Date() } }).lean();
      return doc ? doc.value : null;
    },
    async set(key, value, ttlMs) {
      await CacheEntry.updateOne({ _id: key }, { value, expiresAt: new Date(Date.now() + ttlMs) }, { upsert: true });
    },
  };
}

/** In-memory TTL cache with a size cap: the fallback when no database is configured. */
export function memoryCache(maxEntries = 200) {
  const map = new Map();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) { map.delete(key); return null; }
      return hit.value;
    },
    async set(key, value, ttlMs) {
      if (map.size >= maxEntries) map.delete(map.keys().next().value); // drop the oldest entry
      map.delete(key);
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}
