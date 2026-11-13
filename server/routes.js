// MinuteMate API. The browser cuts audio into ~90 s WAV chunks and uploads them one by one
// (each call fits Netlify's ~10 s / 6 MB limits); then it asks for notes window by window and a final merge.

import express from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { route, parse, ApiError } from './lib/http.js';
import { enforceLimit, dayKey } from './lib/limits.js';
import { SYSTEM, askPrompt, cleanMinutes, joinParts, mergePrompt, minutesSchema, notesPrompt, notesSchema, search, toMarkdown, windows, clock } from './minutes.js';
import { demoMeeting } from './demo.js';

export const BIG_BODY = [];

const MAX_SECONDS = 90 * 60;
const MAX_CHUNKS = 80;
const MAX_MEETINGS = 200;
const CHUNKS_PER_DAY = { user: 100, demo: 16 }; // ~2.5 h and ~24 min of audio per day
const AI_CACHE_MS = 3 * 86400000;

/* ---------- model ---------- */

function meetingModel() {
  if (mongoose.models.Meeting) return mongoose.models.Meeting;
  const seg = new mongoose.Schema({ s: Number, e: Number, t: String }, { _id: false });
  const schema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    title: { type: String, default: 'Untitled meeting' },
    date: String,
    durationSec: Number,
    chunks: Number,
    terms: { type: String, default: '' },
    language: String,
    status: { type: String, default: 'transcribing' }, // transcribing → transcribed → ready
    parts: [{ _id: false, i: Number, segments: [seg] }],
    segments: [seg],
    notes: [mongoose.Schema.Types.Mixed],
    minutes: mongoose.Schema.Types.Mixed,
  }, { timestamps: true });
  return mongoose.model('Meeting', schema);
}

const summaryView = (m) => ({
  id: String(m._id), title: m.title, date: m.date, durationSec: m.durationSec, status: m.status,
  actions: m.minutes?.actions?.length ?? 0, openActions: m.minutes?.actions?.filter((a) => !a.done).length ?? 0,
});
const fullView = (m) => ({ ...summaryView(m), terms: m.terms, language: m.language, chunks: m.chunks, received: m.parts?.length ?? 0, segments: m.segments, minutes: m.minutes ?? null });

/* ---------- validation ---------- */

const createInput = z.object({
  title: z.string().trim().max(120).default(''),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationSec: z.number().positive().max(MAX_SECONDS, 'Meetings can be up to 90 minutes long'),
  chunks: z.number().int().min(1).max(MAX_CHUNKS),
  terms: z.string().trim().max(300).default(''),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
});
const chunkQuery = z.object({ offset: z.coerce.number().min(0).max(MAX_SECONDS + 60) });
const stepInput = z.object({ part: z.number().int().min(0).max(200) });
const askInput = z.object({ question: z.string().trim().min(2).max(500) });
const patchInput = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  action: z.object({ index: z.number().int().min(0).max(100), done: z.boolean() }).optional(),
});

/* ---------- exports used by app.js ---------- */

export async function seedDemo(user) {
  await meetingModel().create({ ...demoMeeting(), userId: String(user._id) });
}

export async function deleteUserData(userId) {
  await meetingModel().deleteMany({ userId: String(userId) });
}

export function appRoutes({ ai, aiQuota, requireUser, counters }) {
  const r = express.Router();
  const Meeting = meetingModel();
  const audioBody = express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '4.5mb' });

  const own = async (req, select) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Meeting not found.');
    const m = await Meeting.findOne({ _id: req.params.id, userId: String(req.user._id) }, select);
    if (!m) throw new ApiError(404, 'Meeting not found.');
    return m;
  };

  r.get('/meetings', requireUser, route(async (req, res) => {
    const list = await Meeting.find({ userId: String(req.user._id) }, { parts: 0, segments: 0, notes: 0 }).sort({ date: -1, createdAt: -1 }).limit(200);
    res.json({ meetings: list.map(summaryView) });
  }));

  r.post('/meetings', requireUser, route(async (req, res) => {
    const body = parse(createInput, req.body);
    const userId = String(req.user._id);
    if (await Meeting.countDocuments({ userId }) >= MAX_MEETINGS) throw new ApiError(403, `You can keep up to ${MAX_MEETINGS} meetings. Delete some old ones first.`);
    const m = await Meeting.create({ ...body, title: body.title || 'Untitled meeting', userId });
    res.status(201).json({ meeting: fullView(m) });
  }));

  r.get('/meetings/:id', requireUser, route(async (req, res) => {
    res.json({ meeting: fullView(await own(req, { notes: 0 })) });
  }));

  // One ~90 s piece of audio → timestamped segments (shifted by the piece's offset).
  r.post('/meetings/:id/chunks/:i', requireUser, audioBody, route(async (req, res) => {
    const m = await own(req, { segments: 0, notes: 0 });
    const i = Number(req.params.i);
    if (!Number.isInteger(i) || i < 0 || i >= m.chunks) throw new ApiError(400, 'Unknown audio piece.');
    if (m.status !== 'transcribing') throw new ApiError(409, 'This meeting is already transcribed.');
    const { offset } = parse(chunkQuery, req.query);
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw new ApiError(400, 'No audio received.');
    const cap = req.user.demo ? CHUNKS_PER_DAY.demo : CHUNKS_PER_DAY.user;
    await enforceLimit(counters, `audio:${req.user._id}:${dayKey()}`, cap, 86400000, `You've used today's free transcription (about ${Math.round((cap * 90) / 60)} minutes of audio). Come back tomorrow.`);

    const out = await ai.transcribe({ audio: req.body, mimeType: req.get('content-type') || 'audio/wav', filename: `part-${i}.wav`, language: m.language, prompt: m.terms || undefined, label: 'chunk' });
    const segments = out.segments.length ? out.segments : [{ start: 0, end: out.duration || 0, text: out.text }];
    const shifted = segments.map((s) => ({ s: s.start + offset, e: s.end + offset, t: s.text })).filter((s) => s.t);

    const parts = [...m.parts.filter((p) => p.i !== i), { i, segments: shifted }];
    const done = parts.length === m.chunks;
    const update = { parts, ...(m.language ? {} : { language: out.language }) };
    if (done) Object.assign(update, { segments: joinParts(parts), status: 'transcribed' });
    await Meeting.updateOne({ _id: m._id }, update);
    res.json({ received: parts.length, chunks: m.chunks, done, segments: shifted.length });
  }));

  // Minutes, step 1..n: notes for one transcript window.
  r.post('/meetings/:id/minutes/step', requireUser, route(async (req, res) => {
    const { part } = parse(stepInput, req.body);
    const m = await own(req);
    if (m.status === 'transcribing') throw new ApiError(409, 'The transcript is not finished yet.');
    if (!m.segments.length) throw new ApiError(422, 'No speech was found in this recording.');
    const parts = windows(m.segments);
    if (part >= parts.length) throw new ApiError(400, 'Unknown part.');
    await aiQuota(req.user);
    const notes = await ai.json(notesSchema, { label: 'notes', system: SYSTEM, prompt: notesPrompt(parts[part], part, parts.length), maxTokens: 1500, cacheTtlMs: AI_CACHE_MS });
    await Meeting.updateOne({ _id: m._id }, { $set: { [`notes.${part}`]: notes } });
    res.json({ part, total: parts.length });
  }));

  // Minutes, last step: merge the window notes.
  r.post('/meetings/:id/minutes/finish', requireUser, route(async (req, res) => {
    const m = await own(req);
    const total = windows(m.segments).length;
    const notes = (m.notes || []).slice(0, total);
    if (!total || notes.length < total || notes.some((n) => !n)) throw new ApiError(409, 'Some parts of the meeting have no notes yet.');
    await aiQuota(req.user);
    const merged = await ai.json(minutesSchema, { label: 'merge', system: SYSTEM, prompt: mergePrompt(notes, m.durationSec), maxTokens: 2500, cacheTtlMs: AI_CACHE_MS });
    const minutes = cleanMinutes(merged, m.durationSec);
    const title = m.title === 'Untitled meeting' && minutes.title ? minutes.title : m.title;
    await Meeting.updateOne({ _id: m._id }, { minutes, title, status: 'ready' });
    res.json({ meeting: fullView({ ...m.toObject(), _id: m._id, minutes, title, status: 'ready' }) });
  }));

  r.post('/meetings/:id/ask', requireUser, route(async (req, res) => {
    const { question } = parse(askInput, req.body);
    const m = await own(req, { parts: 0, notes: 0 });
    if (!m.segments.length) throw new ApiError(409, 'The transcript is not ready yet.');
    await aiQuota(req.user);
    const found = search(m.segments, question);
    const out = await ai.chat({ label: 'ask', system: SYSTEM, prompt: askPrompt(question, found, m.minutes), maxTokens: 500, temperature: 0.2 });
    // Only keep citations that point at real moments of this meeting.
    const valid = new Set(found.flat().map((s) => clock(s.s)));
    const answer = out.text.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (all, t) => (valid.has(t) ? all : ''));
    res.json({ answer, sources: found.map((p) => p[0].s) });
  }));

  r.patch('/meetings/:id', requireUser, route(async (req, res) => {
    const body = parse(patchInput, req.body);
    const m = await own(req, { parts: 0, notes: 0 });
    if (body.title) m.title = body.title;
    if (body.action) {
      const a = m.minutes?.actions?.[body.action.index];
      if (!a) throw new ApiError(404, 'Action item not found.');
      a.done = body.action.done;
      m.markModified('minutes');
    }
    await m.save();
    res.json({ meeting: fullView(m) });
  }));

  r.delete('/meetings/:id', requireUser, route(async (req, res) => {
    const m = await own(req, { _id: 1 });
    await Meeting.deleteOne({ _id: m._id });
    res.json({ ok: true });
  }));

  r.get('/meetings/:id/export.md', requireUser, route(async (req, res) => {
    const m = await own(req, { parts: 0, notes: 0 });
    const name = m.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'meeting';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.md"`);
    res.send(toMarkdown(m));
  }));

  return r;
}
