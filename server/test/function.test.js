import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../../netlify/functions/api.mjs';

// What Netlify sends after the /api/* → /.netlify/functions/api/:splat rewrite.
const event = (path, extra = {}) => ({ path, rawUrl: `https://x.netlify.app${path}`, httpMethod: 'GET', headers: { host: 'x.netlify.app' }, multiValueHeaders: {}, queryStringParameters: {}, body: null, isBase64Encoded: false, ...extra });

test('Netlify handler serves the API on the original /api path', async () => {
  const res = await handler(event('/api/health'), {});
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('Netlify handler serves the API on the function path', async () => {
  const res = await handler(event('/.netlify/functions/api/health'), {});
  assert.equal(res.statusCode, 200);
});

test('without a database, DB routes answer a clear 503 (not a crash)', async () => {
  delete process.env.MONGODB_URI;
  const res = await handler(event('/api/auth/me'), {});
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /database/);
});
