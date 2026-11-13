import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { transcribeFile, type Progress } from '../lib/pipeline';
import { audioUrls, clock } from '../lib/types';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const STAGES: { id: Progress['stage']; label: string }[] = [
  { id: 'prepare', label: 'Preparing the audio' },
  { id: 'transcribe', label: 'Writing down what was said' },
  { id: 'notes', label: 'Taking notes' },
  { id: 'merge', label: 'Writing the minutes' },
];

export default function NewMeeting({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today);
  const [terms, setTerms] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [rec, setRec] = useState<{ recorder: MediaRecorder; started: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - rec.started > 90 * 60000) rec.recorder.stop();
    }, 500);
    return () => clearInterval(t);
  }, [rec]);

  const startRecording = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = recorder.mimeType || 'audio/webm';
        setFile(new File(chunks, `recording-${today()}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type }));
        setRec(null);
      };
      recorder.start(1000);
      setRec({ recorder, started: Date.now() });
    } catch {
      setError('Microphone access was blocked. Allow it in the browser, or upload a recording instead.');
    }
  };

  const go = async () => {
    if (!file) return;
    setError('');
    try {
      const id = await transcribeFile(file, { title, date, terms }, setProgress);
      audioUrls.set(id, URL.createObjectURL(file));
      onDone(id);
    } catch (e) {
      setProgress(null);
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  if (progress) {
    const idx = STAGES.findIndex((s) => s.id === progress.stage);
    return (
      <section className="card mx-auto max-w-xl p-6 sm:p-8" aria-live="polite">
        <h2 className="text-xl font-extrabold">Working on your meeting…</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Keep this tab open. Free AI is shared, so it can take a minute or two.</p>
        <ol className="mt-6 space-y-4">
          {STAGES.map((s, i) => {
            const state = i < idx ? 'done' : i === idx ? 'now' : 'later';
            const pct = state === 'done' ? 100 : state === 'now' && progress.total > 1 ? Math.round((progress.done / progress.total) * 100) : state === 'now' ? 30 : 0;
            return (
              <li key={s.id}>
                <div className="flex items-center gap-3">
                  <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${state === 'done' ? 'bg-brand-600 text-white' : state === 'now' ? 'bg-brand-100 text-brand-700 ring-2 ring-brand-500 dark:bg-brand-600/20 dark:text-brand-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-800'}`}>{state === 'done' ? '✓' : i + 1}</span>
                  <span className={`flex-1 text-sm font-semibold ${state === 'later' ? 'text-slate-400' : ''}`}>{s.label}{state === 'now' && progress.total > 1 ? ` (${progress.done + 1} of ${progress.total})` : ''}</span>
                </div>
                {state === 'now' && (
                  <div className="ml-10 mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500 transition-all" style={{ width: `${Math.max(8, pct)}%` }} />
                  </div>
                )}
                {state === 'now' && progress.note && <p className="ml-10 mt-1 text-xs text-amber-600 dark:text-amber-400">{progress.note}</p>}
              </li>
            );
          })}
        </ol>
      </section>
    );
  }

  return (
    <section className="card mx-auto max-w-xl overflow-hidden">
      <div className="bg-gradient-to-br from-brand-700 to-brand-500 p-6 text-white sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-wider opacity-90">New meeting</p>
        <h2 className="mt-1 text-2xl font-extrabold sm:text-3xl">Upload or record</h2>
        <p className="mt-2 text-sm opacity-90">Up to 90 minutes. The audio is only used to write the transcript and is never stored.</p>
      </div>
      <div className="space-y-4 p-5 sm:p-6">
        <input ref={input} type="file" accept="audio/*,video/mp4,video/webm,.m4a,.mp3,.wav,.ogg,.webm" className="hidden" data-testid="audio-input"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setFile(f); }} />
        {rec ? (
          <div className="flex items-center justify-between rounded-2xl bg-rose-50 p-4 dark:bg-rose-500/10">
            <span className="flex items-center gap-3 font-semibold"><span className="h-3 w-3 animate-pulse rounded-full bg-rose-500" />Recording {clock((now - rec.started) / 1000)}</span>
            <button className="btn bg-rose-600 text-white hover:bg-rose-700" onClick={() => rec.recorder.stop()}>Stop</button>
          </div>
        ) : file ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-brand-50 p-4 dark:bg-brand-600/10">
            <span className="min-w-0 truncate text-sm font-semibold">🎧 {file.name}</span>
            <button className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-400" onClick={() => setFile(null)}>Change</button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <button className="btn-primary py-4 text-base" onClick={() => input.current?.click()}>⬆ Upload a recording</button>
            <button className="btn-ghost py-4 text-base" onClick={startRecording}>🎙 Record now</button>
          </div>
        )}

        <label className="block text-sm font-medium">Title <span className="font-normal text-slate-500">(optional; the AI suggests one)</span>
          <input className="field mt-1" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly sync" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm font-medium">Date
            <input type="date" className="field mt-1" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="text-sm font-medium">Names & terms
            <input className="field mt-1" value={terms} maxLength={300} onChange={(e) => setTerms(e.target.value)} placeholder="Priya, Razorpay, KYC" />
          </label>
        </div>
        <p className="-mt-2 text-xs text-slate-500 dark:text-slate-400">Names and terms help the AI spell them right.</p>

        <div className="flex gap-3 pt-1">
          <button className="btn-accent flex-1 py-3" onClick={go} disabled={!file || Boolean(rec)}>Make the minutes</button>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
        {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
      </div>
    </section>
  );
}
