// shared-kit v1 — env validation (from lifeos-online/server/src/config.js and Exam-AI/lib/env.ts)
// Usage: const env = loadEnv(z => ({ MONGODB_URI: z.string().url(), ... }), z)

let cached;

/** Validate process.env once; throw one readable error listing every bad variable. */
export function loadEnv(shape, z, source = process.env) {
  if (cached && source === process.env) return cached;
  const result = z.object(shape(z)).safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment variables:\n${lines.join('\n')}`);
  }
  if (source === process.env) cached = result.data;
  return result.data;
}

export const resetEnvCache = () => { cached = undefined; };
