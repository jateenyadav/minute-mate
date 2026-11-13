// The whole job, run by the browser as many short API calls (each fits Netlify's ~10 s limit):
// decode → cut into pieces → upload + transcribe each → notes per transcript window → merge.
import { api, ApiError } from '../api';
import { decodeToMono, encodeWav, isSilent, splitPieces, RATE } from './audio';
import type { Meeting } from './types';

export type Progress = { stage: 'prepare' | 'transcribe' | 'notes' | 'merge'; done: number; total: number; note?: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry while the free AI is busy (503) or rate-limited per minute; stop on daily caps. */
async function withRetry<T>(fn: () => Promise<T>, onWait: (s: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const busy = e instanceof ApiError && (e.status === 503 || e.status === 502 || e.status === 504 || (e.status === 429 && !/today/i.test(e.message)));
      if (!busy || attempt >= 4) throw e;
      const s = 10 * (attempt + 1);
      onWait(s);
      await wait(s * 1000);
    }
  }
}

async function uploadPiece(id: string, i: number, offset: number, blob: Blob) {
  const res = await fetch(`/api/meetings/${id}/chunks/${i}?offset=${offset.toFixed(2)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav' }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Upload failed (${res.status})`);
  return data as { received: number; chunks: number; done: boolean };
}

export async function transcribeFile(file: Blob, info: { title: string; date: string; terms: string }, onProgress: (p: Progress) => void): Promise<string> {
  onProgress({ stage: 'prepare', done: 0, total: 1 });
  const samples = await decodeToMono(file);
  const durationSec = samples.length / RATE;
  if (durationSec < 2) throw new Error('This recording is too short.');
  if (durationSec > 90 * 60) throw new Error('Meetings can be up to 90 minutes long. Please trim the recording.');
  if (isSilent(samples)) throw new Error('This recording is silent. Check the microphone or the file.');
  const pieces = splitPieces(samples);
  const { meeting } = await api<{ meeting: Meeting }>('/meetings', { body: { ...info, durationSec, chunks: pieces.length } });
  await continueMeeting(meeting.id, pieces.map((p) => ({ offset: p.offset, blob: () => encodeWav(p.samples) })), onProgress);
  return meeting.id;
}

export async function continueMeeting(id: string, pieces: { offset: number; blob: () => Blob }[], onProgress: (p: Progress) => void) {
  for (let i = 0; i < pieces.length; i++) {
    onProgress({ stage: 'transcribe', done: i, total: pieces.length });
    await withRetry(() => uploadPiece(id, i, pieces[i].offset, pieces[i].blob()), (s) => onProgress({ stage: 'transcribe', done: i, total: pieces.length, note: `The free speech AI is busy, trying again in ${s} s…` }));
  }
  await writeMinutes(id, onProgress);
}

export async function writeMinutes(id: string, onProgress: (p: Progress) => void) {
  let total = 1;
  for (let part = 0; part < total; part++) {
    onProgress({ stage: 'notes', done: part, total });
    const out = await withRetry(() => api<{ total: number }>(`/meetings/${id}/minutes/step`, { body: { part } }), (s) => onProgress({ stage: 'notes', done: part, total, note: `The free AI is busy, trying again in ${s} s…` }));
    total = out.total;
  }
  onProgress({ stage: 'merge', done: 0, total: 1 });
  await withRetry(() => api(`/meetings/${id}/minutes/finish`, { body: {} }), (s) => onProgress({ stage: 'merge', done: 0, total: 1, note: `The free AI is busy, trying again in ${s} s…` }));
}
