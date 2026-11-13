export type Segment = { s: number; e: number; t: string };
export type Action = { task: string; owner: string | null; due: string | null; at: number | null; done: boolean };
export type Minutes = {
  title: string | null;
  overview: string;
  topics: { title: string; at: number | null }[];
  summary: string[];
  decisions: { text: string; at: number | null }[];
  actions: Action[];
  questions: { text: string; at: number | null }[];
};
export type MeetingSummary = { id: string; title: string; date: string; durationSec: number; status: 'transcribing' | 'transcribed' | 'ready'; actions: number; openActions: number };
export type Meeting = MeetingSummary & { terms: string; language: string | null; chunks: number; received: number; segments: Segment[]; minutes: Minutes | null };

/** 75 → "01:15", 3725 → "1:02:05" (same as the server's clock()). */
export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function parseClock(v: string): number | null {
  const m = v.match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export const duration = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);

/** Recordings picked this session, so timestamps can play them (audio is never uploaded for storage). */
export const audioUrls = new Map<string, string>();
