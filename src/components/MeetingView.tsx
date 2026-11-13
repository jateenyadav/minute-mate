import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { writeMinutes, type Progress } from '../lib/pipeline';
import { audioUrls, clock, duration, parseClock, type Meeting } from '../lib/types';

type Tab = 'minutes' | 'transcript' | 'ask';
type Answer = { q: string; a: string };

export default function MeetingView({ id, onBack }: { id: string; onBack: () => void }) {
  const [m, setM] = useState<Meeting | null>(null);
  const [tab, setTab] = useState<Tab>('minutes');
  const [error, setError] = useState('');
  const [audio, setAudio] = useState<string | null>(audioUrls.get(id) ?? null);
  const [time, setTime] = useState(0);
  const [working, setWorking] = useState<Progress | null>(null);
  const player = useRef<HTMLAudioElement>(null);
  const attach = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setM((await api<{ meeting: Meeting }>(`/meetings/${id}`)).meeting);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the meeting.');
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const jump = (sec: number | null) => {
    if (sec == null) return;
    if (!player.current || !audio) {
      setTab('transcript');
      requestAnimationFrame(() => document.getElementById(`seg-${Math.floor(sec)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      return;
    }
    player.current.currentTime = Math.max(0, sec - 1);
    void player.current.play().catch(() => {});
  };

  const At = ({ at }: { at: number | null }) => (at == null ? null : (
    <button className="num rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-bold text-brand-700 hover:bg-brand-100 dark:bg-brand-600/15 dark:text-brand-400" onClick={() => jump(at)} aria-label={`Go to ${clock(at)}`}>{clock(at)}</button>
  ));

  const toggleAction = async (index: number, done: boolean) => {
    if (!m?.minutes) return;
    setM({ ...m, minutes: { ...m.minutes, actions: m.minutes.actions.map((a, i) => (i === index ? { ...a, done } : a)) } });
    await api(`/meetings/${id}`, { method: 'PATCH', body: { action: { index, done } } }).catch(() => load());
  };

  const rename = async () => {
    const title = window.prompt('Meeting title', m?.title)?.trim();
    if (!title || !m) return;
    setM((await api<{ meeting: Meeting }>(`/meetings/${id}`, { method: 'PATCH', body: { title } })).meeting);
  };

  const remove = async () => {
    if (!window.confirm('Delete this meeting and its minutes?')) return;
    await api(`/meetings/${id}`, { method: 'DELETE' });
    onBack();
  };

  const finish = async () => {
    setError('');
    try {
      await writeMinutes(id, setWorking);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not write the minutes.');
    } finally {
      setWorking(null);
    }
  };

  const emailText = useMemo(() => (m ? toEmail(m) : ''), [m]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(emailText); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { window.prompt('Copy:', emailText); }
  };

  if (error && !m) return <p role="alert" className="card p-6 text-rose-600">{error}</p>;
  if (!m) return <div className="card h-96 animate-pulse" aria-busy="true" />;
  const mins = m.minutes;

  return (
    <div className="space-y-4">
      <div className="no-print flex items-center justify-between gap-2">
        <button className="text-sm font-semibold text-slate-500 hover:text-slate-900 dark:hover:text-white" onClick={onBack}>← All meetings</button>
        <div className="flex flex-wrap justify-end gap-2">
          {mins && <button className="btn-ghost py-1.5" onClick={copy}>{copied ? 'Copied ✓' : '✉ Copy as email'}</button>}
          <a className="btn-ghost py-1.5" href={`/api/meetings/${id}/export.md`} download>⬇ Markdown</a>
          {mins && <button className="btn-ghost py-1.5" onClick={() => window.print()}>🖨 PDF</button>}
        </div>
      </div>

      <header className="card p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold tracking-tight">{m.title}</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{m.date} · {duration(m.durationSec)}{mins ? ` · ${mins.actions.length} action items` : ''}</p>
          </div>
          <div className="no-print flex shrink-0 gap-1">
            <button className="rounded-lg px-2 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onClick={rename} aria-label="Rename">✏️</button>
            <button className="rounded-lg px-2 py-1 text-sm hover:bg-rose-50 dark:hover:bg-rose-500/10" onClick={remove} aria-label="Delete meeting">🗑</button>
          </div>
        </div>
        {mins?.overview && <p className="mt-4 text-slate-700 dark:text-slate-200">{mins.overview}</p>}
        <div className="no-print mt-4">
          {audio ? (
            <audio ref={player} src={audio} controls className="w-full" onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
          ) : (
            <>
              <input ref={attach} type="file" accept="audio/*,video/mp4,video/webm" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const u = URL.createObjectURL(f); audioUrls.set(id, u); setAudio(u); } }} />
              <button className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-400" onClick={() => attach.current?.click()}>🎧 Add the recording to play it from any timestamp</button>
              <span className="block text-xs text-slate-500 dark:text-slate-400">Recordings stay on your device; MinuteMate never stores audio.</span>
            </>
          )}
        </div>
      </header>

      {m.status === 'transcribing' && <p className="card p-5 text-sm">This meeting wasn’t finished (the page was closed while it was being transcribed). Delete it and upload the recording again.</p>}
      {m.status === 'transcribed' && (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-sm">{working ? `Working: ${working.stage === 'merge' ? 'writing the minutes' : `taking notes (${working.done + 1}/${working.total})`}…` : 'The transcript is ready, but the minutes aren’t written yet.'}</p>
          <button className="btn-accent" onClick={finish} disabled={Boolean(working)}>Write the minutes</button>
          {working?.note && <p className="w-full text-xs text-amber-600">{working.note}</p>}
        </div>
      )}
      {error && <p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}

      <nav className="no-print inline-flex rounded-2xl bg-white/80 p-1 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900/80 dark:ring-slate-800" aria-label="Meeting">
        {(['minutes', 'transcript', 'ask'] as Tab[]).map((t) => (
          <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${tab === t ? 'bg-brand-600 text-white shadow' : 'text-slate-600 dark:text-slate-300'}`}>
            {t === 'ask' ? 'Ask this meeting' : t === 'minutes' ? 'Minutes' : 'Transcript'}
          </button>
        ))}
      </nav>

      {tab === 'minutes' && (mins ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-4">
            <section className="card p-5" aria-labelledby="h-actions">
              <h2 id="h-actions" className="text-lg font-extrabold">✅ Action items</h2>
              {mins.actions.length === 0 ? <p className="mt-2 text-sm text-slate-500">No action items were agreed.</p> : (
                <ul className="mt-3 space-y-2" data-testid="actions">
                  {mins.actions.map((a, i) => (
                    <li key={i} className={`flex items-start gap-3 rounded-xl border p-3 transition ${a.done ? 'border-slate-200 bg-slate-50 opacity-70 dark:border-slate-800 dark:bg-slate-900' : 'border-brand-200 dark:border-brand-600/30'}`}>
                      <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={a.done} onChange={(e) => toggleAction(i, e.target.checked)} aria-label={`Done: ${a.task}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium ${a.done ? 'line-through' : ''}`}>{a.task}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                          {a.owner && <span className="rounded-full bg-accent-500/15 px-2 py-0.5 font-semibold text-accent-600 dark:text-accent-400">👤 {a.owner}</span>}
                          {a.due && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">📅 {a.due}</span>}
                          <At at={a.at} />
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card p-5">
              <h2 className="text-lg font-extrabold">🤝 Decisions</h2>
              {mins.decisions.length === 0 ? <p className="mt-2 text-sm text-slate-500">No decisions were recorded.</p> : (
                <ul className="mt-3 space-y-2">{mins.decisions.map((d, i) => <li key={i} className="flex items-start justify-between gap-3 border-l-4 border-brand-500 pl-3"><span>{d.text}</span><At at={d.at} /></li>)}</ul>
              )}
            </section>
            <section className="card p-5">
              <h2 className="text-lg font-extrabold">📝 Summary</h2>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">{mins.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </section>
          </div>
          <aside className="space-y-4">
            {mins.topics.length > 0 && (
              <section className="card p-5">
                <h2 className="font-extrabold">Topics</h2>
                <ol className="mt-3 space-y-2 text-sm">{mins.topics.map((t, i) => <li key={i} className="flex items-center justify-between gap-2"><span>{t.title}</span><At at={t.at} /></li>)}</ol>
              </section>
            )}
            <section className="card p-5">
              <h2 className="font-extrabold">❓ Open questions</h2>
              {mins.questions.length === 0 ? <p className="mt-2 text-sm text-slate-500">None.</p> : (
                <ul className="mt-3 space-y-2 text-sm">{mins.questions.map((q, i) => <li key={i} className="flex items-start justify-between gap-2"><span>{q.text}</span><At at={q.at} /></li>)}</ul>
              )}
            </section>
          </aside>
        </div>
      ) : <p className="card p-6 text-sm text-slate-500">The minutes appear here once they’re written.</p>)}

      {tab === 'transcript' && <Transcript m={m} time={audio ? time : -1} onJump={jump} />}
      {tab === 'ask' && <Ask id={id} ready={m.segments.length > 0} onJump={jump} />}
    </div>
  );
}

function Transcript({ m, time, onJump }: { m: Meeting; time: number; onJump: (s: number) => void }) {
  const [q, setQ] = useState('');
  const shown = q.trim() ? m.segments.filter((s) => s.t.toLowerCase().includes(q.trim().toLowerCase())) : m.segments;
  return (
    <section className="card p-4 sm:p-5">
      <input className="field no-print mb-3" placeholder="Search the transcript…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the transcript" />
      {shown.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No matches.</p> : (
        <ol className="space-y-1" data-testid="transcript">
          {shown.map((s) => {
            const live = time >= s.s && time < s.e;
            return (
              <li key={s.s} id={`seg-${Math.floor(s.s)}`} className={`flex gap-3 rounded-lg px-2 py-1.5 ${live ? 'bg-brand-50 dark:bg-brand-600/15' : ''}`}>
                <button className="num shrink-0 pt-0.5 text-xs font-bold text-brand-700 hover:underline dark:text-brand-400" onClick={() => onJump(s.s)}>{clock(s.s)}</button>
                <span className="leading-relaxed">{s.t}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const SUGGESTIONS = ['What was decided?', 'Who has to do what, and by when?', 'What is still open?'];

function Ask({ id, ready, onJump }: { id: string; ready: boolean; onJump: (s: number) => void }) {
  const [q, setQ] = useState('');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { answer } = await api<{ answer: string }>(`/meetings/${id}/ask`, { body: { question } });
      setAnswers((a) => [{ q: question, a: answer }, ...a]);
      setQ('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not answer.');
    } finally {
      setBusy(false);
    }
  };

  const render = (text: string) => text.split(/(\[\d{1,2}:\d{2}(?::\d{2})?\])/g).map((part, i) => {
    const sec = /^\[.*\]$/.test(part) ? parseClock(part.slice(1, -1)) : null;
    return sec == null ? <span key={i}>{part}</span> : (
      <button key={i} className="num mx-0.5 rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-bold text-brand-700 hover:bg-brand-100 dark:bg-brand-600/15 dark:text-brand-400" onClick={() => onJump(sec)}>{part.slice(1, -1)}</button>
    );
  });

  if (!ready) return <p className="card p-6 text-sm text-slate-500">You can ask questions once the transcript is ready.</p>;
  return (
    <section className="space-y-4">
      <form className="card flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
        <input className="field" value={q} maxLength={500} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about this meeting…" aria-label="Your question" />
        <button className="btn-primary" disabled={busy || q.trim().length < 2}>{busy ? '…' : 'Ask'}</button>
      </form>
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => <button key={s} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium hover:border-brand-500 dark:border-slate-700 dark:bg-slate-900" onClick={() => ask(s)} disabled={busy}>{s}</button>)}
      </div>
      {error && <p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}
      <ul className="space-y-3" data-testid="answers">
        {answers.map((x, i) => (
          <li key={i} className="card p-4">
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400">{x.q}</p>
            <p className="mt-2 whitespace-pre-wrap leading-relaxed">{render(x.a)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function toEmail(m: Meeting) {
  const mins = m.minutes;
  if (!mins) return '';
  const sec = (title: string, items: string[]) => (items.length ? `\n${title}\n${items.map((x) => `• ${x}`).join('\n')}\n` : '');
  return `Minutes: ${m.title} (${m.date})
${mins.overview ? `\n${mins.overview}\n` : ''}${sec('Decisions', mins.decisions.map((d) => d.text))}${sec('Action items', mins.actions.map((a) => `${a.task}${a.owner ? ` (${a.owner}` : ''}${a.due ? `${a.owner ? ', ' : ' ('}by ${a.due}` : ''}${a.owner || a.due ? ')' : ''}${a.done ? ' ✓ done' : ''}`))}${sec('Open questions', mins.questions.map((q) => q.text))}
Written with MinuteMate`;
}
