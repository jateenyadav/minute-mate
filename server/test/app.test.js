import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { startFakeAi } from '../dev/fake-ai.mjs';
import fixtures from '../dev/fixtures.mjs';
import { createAi, providersFromEnv } from '../lib/ai.js';
import { memoryCounterStore } from '../lib/limits.js';
import { connectDb } from '../lib/db.js';
import { createApp } from '../app.js';

let mem, fake, app;
const wav = Buffer.alloc(4000, 1);

before(async () => {
  mem = await MongoMemoryServer.create();
  fake = await startFakeAi({ fixtures });
  const ai = createAi({ providers: providersFromEnv({ GROQ_API_KEY: 'x', GROQ_BASE_URL: fake.url }) });
  app = createApp({ ai, counters: memoryCounterStore(), db: () => connectDb(mem.getUri(), 'minute-mate-test'), limits: { aiPerDay: 20 } });
});
after(async () => { await mongoose.disconnect(); await mem.stop(); await fake.close(); });

const demo = async () => {
  const agent = request.agent(app);
  await agent.post('/api/auth/demo').send({}).expect(201);
  return agent;
};
const create = (agent, extra = {}) => agent.post('/api/meetings').send({ date: '2026-11-13', durationSec: 180, chunks: 2, ...extra });
const upload = (agent, id, i, offset) => agent.post(`/api/meetings/${id}/chunks/${i}?offset=${offset}`).set('Content-Type', 'audio/wav').send(wav);

test('health and the Netlify path', async () => {
  await request(app).get('/api/health').expect(200);
  await request(app).get('/.netlify/functions/api/health').expect(200);
});

test('everything needs a login', async () => {
  await request(app).get('/api/meetings').expect(401);
  await request(app).post('/api/meetings/abc/chunks/0?offset=0').set('Content-Type', 'audio/wav').send(wav).expect(401);
});

test('demo account comes with a finished sample meeting', async () => {
  const agent = await demo();
  const { body } = await agent.get('/api/meetings').expect(200);
  assert.equal(body.meetings.length, 1);
  assert.equal(body.meetings[0].status, 'ready');
  const full = await agent.get(`/api/meetings/${body.meetings[0].id}`).expect(200);
  assert.ok(full.body.meeting.segments.length > 10);
  assert.equal(full.body.meeting.minutes.actions.length, 5);
});

test('upload pieces → transcript with offsets → notes → minutes → ask → export', async () => {
  const agent = await demo();
  const { body: { meeting } } = await create(agent, { terms: 'Priya, Pocket Wallet' }).expect(201);
  assert.equal(meeting.title, 'Untitled meeting');

  await agent.post(`/api/meetings/${meeting.id}/minutes/step`).send({ part: 0 }).expect(409);
  const a = await upload(agent, meeting.id, 1, 90).expect(200); // out of order is fine
  assert.equal(a.body.done, false);
  const b = await upload(agent, meeting.id, 0, 0).expect(200);
  assert.equal(b.body.done, true);
  await upload(agent, meeting.id, 0, 0).expect(409);

  const audioCalls = fake.calls.filter((c) => c.path === '/audio/transcriptions');
  assert.ok(audioCalls.length >= 2);

  const t = (await agent.get(`/api/meetings/${meeting.id}`).expect(200)).body.meeting;
  assert.equal(t.status, 'transcribed');
  assert.equal(t.segments.length, 6);
  assert.equal(t.segments[0].s, 0);
  assert.equal(t.segments[3].s, 90); // second piece shifted by its offset
  assert.ok(t.segments.every((s, i, all) => !i || all[i - 1].s <= s.s));

  await agent.post(`/api/meetings/${meeting.id}/minutes/finish`).send({}).expect(409);
  const step = await agent.post(`/api/meetings/${meeting.id}/minutes/step`).send({ part: 0 }).expect(200);
  assert.equal(step.body.total, 1);
  await agent.post(`/api/meetings/${meeting.id}/minutes/step`).send({ part: 5 }).expect(400);
  const fin = await agent.post(`/api/meetings/${meeting.id}/minutes/finish`).send({}).expect(200);
  const m = fin.body.meeting;
  assert.equal(m.status, 'ready');
  assert.equal(m.title, 'Release planning'); // AI title replaces "Untitled meeting"
  assert.equal(m.minutes.decisions.length, 1); // empty decision dropped
  assert.equal(m.minutes.actions[0].owner, 'Priya');
  assert.equal(m.minutes.actions[0].at, 6);
  assert.equal(m.minutes.actions[1].at, null); // timestamp past the end of the meeting dropped

  const ask = await agent.post(`/api/meetings/${meeting.id}/ask`).send({ question: 'What will Priya do?' }).expect(200);
  assert.match(ask.body.answer, /\[00:06\]/);
  assert.doesNotMatch(ask.body.answer, /42:00/); // invented citation removed

  await agent.patch(`/api/meetings/${meeting.id}`).send({ action: { index: 0, done: true } }).expect(200);
  await agent.patch(`/api/meetings/${meeting.id}`).send({ action: { index: 9, done: true } }).expect(404);
  const md = await agent.get(`/api/meetings/${meeting.id}/export.md`).expect(200);
  assert.match(md.headers['content-disposition'], /Release-planning\.md/);
  assert.match(md.text, /- \[x\] Update the docs — \*\*Priya\*\* \(due Thursday\)/);
  assert.match(md.text, /\*\*\[01:30\]\*\*/);
});

test('validation: length limit, bad piece index, empty audio', async () => {
  const agent = await demo();
  const long = await create(agent, { durationSec: 3 * 3600 }).expect(400);
  assert.match(long.body.error, /90 minutes/);
  const { body: { meeting } } = await create(agent).expect(201);
  await upload(agent, meeting.id, 7, 0).expect(400);
  await agent.post(`/api/meetings/${meeting.id}/chunks/0?offset=0`).set('Content-Type', 'audio/wav').send(Buffer.alloc(10)).expect(400);
  await agent.post(`/api/meetings/${meeting.id}/ask`).send({ question: 'x' }).expect(400);
});

test('demo accounts get a daily transcription cap', async () => {
  const agent = await demo();
  const { body: { meeting } } = await create(agent, { chunks: 20, durationSec: 1800 }).expect(201);
  for (let i = 0; i < 16; i++) await upload(agent, meeting.id, i, i * 90).expect(200);
  const res = await upload(agent, meeting.id, 16, 16 * 90).expect(429);
  assert.match(res.body.error, /today/);
});

test('meetings are private, and deleting the account removes them', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ name: 'Asha', email: 'asha@example.com', password: 'longpassword' }).expect(201);
  const { body: { meeting } } = await create(owner).expect(201);
  const stranger = await demo();
  await stranger.get(`/api/meetings/${meeting.id}`).expect(404);
  await upload(stranger, meeting.id, 0, 0).expect(404);
  await stranger.delete(`/api/meetings/${meeting.id}`).expect(404);
  await stranger.get('/api/meetings/not-an-id').expect(404);
  await owner.delete('/api/auth/account').send({ password: 'longpassword' }).expect(200);
  assert.equal(await mongoose.connection.collection('meetings').countDocuments({ _id: new mongoose.Types.ObjectId(meeting.id) }), 0);
});

test('cross-site writes are blocked', async () => {
  await request(app).post('/api/auth/demo').set('Origin', 'https://evil.example').send({}).expect(403);
});
