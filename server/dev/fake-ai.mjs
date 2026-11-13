// shared-kit v1.2 — fake OpenAI-compatible AI server for local development and tests.
// Point the app at it with GROQ_BASE_URL / GEMINI_BASE_URL = http://127.0.0.1:<port>/v1 and any
// non-empty API keys. Nothing leaves the machine and answers are deterministic.
//
// Fixtures: { 'text to look for': reply } — the first key found in the request's messages wins.
// A reply is a string, an object (sent as JSON text) or a function (body) => string|object.
//
//   import { startFakeAi } from './dev/fake-ai.mjs';
//   const fake = await startFakeAi({ fixtures: { 'receipt': { total: 120 } } });
//   process.env.GEMINI_BASE_URL = fake.url; ...; await fake.close();
//
// CLI: node dev/fake-ai.mjs [--port 8787] [--fixtures ./fixtures.mjs]   (default export = fixtures)

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const EMBED_DIMS = 64;

/** Deterministic unit vector from text: same text → same vector, similar words → overlapping dims. */
export function fakeVector(text, dims = EMBED_DIMS) {
  const v = new Array(dims).fill(0);
  for (const word of String(text).toLowerCase().split(/\W+/).filter(Boolean)) {
    const h = createHash('sha256').update(word).digest();
    v[h[0] % dims] += 1;
    v[h[1] % dims] += 0.5;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function pickFixture(fixtures, body) {
  const haystack = JSON.stringify(body.messages || []);
  for (const [needle, reply] of Object.entries(fixtures)) {
    if (haystack.includes(needle)) return typeof reply === 'function' ? reply(body) : reply;
  }
  return undefined;
}

function lastUserText(body) {
  const m = [...(body.messages || [])].reverse().find((x) => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
}

const readBody = (req) => new Promise((ok, fail) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', fail);
});

export async function startFakeAi({ port = 0, host = '127.0.0.1', fixtures = {}, transcript } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const raw = await readBody(req);
      const path = new URL(req.url, 'http://x').pathname.replace(/^\/v1/, '');
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      if (path === '/chat/completions') {
        const body = JSON.parse(raw.toString() || '{}');
        calls.push({ path, body });
        let reply = pickFixture(fixtures, body);
        if (reply === undefined) reply = body.response_format?.type === 'json_object' ? {} : `Fake AI answer: ${lastUserText(body).slice(0, 80)}`;
        const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
        return send(200, { id: 'fake', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      }
      if (path === '/embeddings') {
        const body = JSON.parse(raw.toString() || '{}');
        calls.push({ path, body });
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return send(200, { data: inputs.map((t, index) => ({ index, embedding: fakeVector(t, body.dimensions || EMBED_DIMS) })), model: body.model });
      }
      if (path === '/audio/transcriptions') {
        calls.push({ path, bytes: raw.length });
        const t = transcript ?? {
          text: 'Welcome everyone. We decided to ship on Friday. Priya will update the docs by Thursday.',
          segments: [
            { start: 0, end: 3.2, text: 'Welcome everyone.' },
            { start: 3.2, end: 6.5, text: 'We decided to ship on Friday.' },
            { start: 6.5, end: 10.1, text: 'Priya will update the docs by Thursday.' },
          ],
          duration: 10.1,
          language: 'en',
        };
        return send(200, t);
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      return send(500, { error: String(err?.message || err) });
    }
  });
  await new Promise((ok) => server.listen(port, host, ok));
  const { port: actual } = server.address();
  return {
    url: `http://${host}:${actual}/v1`,
    port: actual,
    calls,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

// CLI mode
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const fixturesPath = arg('--fixtures');
  const fixtures = fixturesPath ? (await import(pathToFileURL(resolve(fixturesPath)).href)).default : {};
  const fake = await startFakeAi({ port: Number(arg('--port') || 8787), fixtures });
  console.log(`fake AI on ${fake.url}  (set GROQ_BASE_URL and GEMINI_BASE_URL to this, keys to anything)`);
}
