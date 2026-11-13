// Local API server. Uses MONGODB_URI if set, otherwise an in-memory Mongo.
// With no AI keys it starts the fake AI (server/dev/fake-ai.mjs), so every screen works offline.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env (and the shared secrets file outside the repo) without a dependency.
for (const file of [resolve('.env'), resolve(process.env.HOME || '', 'Desktop/RND/.secrets/shared.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]] && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { APP } = await import('./app.js');
process.env.MONGODB_DB ||= APP.slug;
// The Vite dev proxy rewrites Host, so allow the local web origins explicitly.
process.env.WEB_ORIGINS ||= 'http://localhost:5173,http://localhost:4173';

if (!process.env.MONGODB_URI) {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mem = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mem.getUri();
  console.log('Using an in-memory database (set MONGODB_URI to use Atlas).');
}

if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY) {
  const { startFakeAi } = await import('./dev/fake-ai.mjs');
  const fixtures = existsSync(resolve('server/dev/fixtures.mjs')) ? (await import(resolve('server/dev/fixtures.mjs'))).default : {};
  const fake = await startFakeAi({ fixtures });
  Object.assign(process.env, { GROQ_API_KEY: 'fake', GROQ_BASE_URL: fake.url, GEMINI_API_KEY: 'fake', GEMINI_BASE_URL: fake.url });
  console.log(`No AI keys found: using the fake AI at ${fake.url}`);
}

const { createApp } = await import('./app.js');
const port = Number(process.env.PORT || 8888);
createApp().listen(port, () => console.log(`${APP.name} API on http://localhost:${port}/api/health`));
