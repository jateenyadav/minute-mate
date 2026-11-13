import { useEffect, useState } from 'react';
import { api } from '../api';
import { duration, type MeetingSummary } from '../lib/types';

export default function Home({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [list, setList] = useState<MeetingSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ meetings: MeetingSummary[] }>('/meetings').then((d) => setList(d.meetings), (e) => { setError(e instanceof Error ? e.message : 'Could not load meetings.'); setList([]); });
  }, []);

  const open = list?.reduce((n, m) => n + m.openActions, 0) ?? 0;

  return (
    <section className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-4 bg-gradient-to-br from-brand-600 via-brand-500 to-accent-500 p-5 text-white sm:p-6">
        <div>
          <h1 className="text-2xl font-extrabold">Your meetings</h1>
          <p className="text-sm opacity-90">{list ? `${list.length} meeting${list.length === 1 ? '' : 's'} · ${open} open action item${open === 1 ? '' : 's'}` : 'Loading…'}</p>
        </div>
        <button className="btn bg-white px-5 py-3 text-brand-700 shadow-lg hover:bg-brand-50" onClick={onNew}>＋ New meeting</button>
      </div>
      {error && <p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}
      {list === null ? (
        <div className="space-y-2" aria-busy="true">{[0, 1].map((i) => <div key={i} className="card h-20 animate-pulse" />)}</div>
      ) : list.length === 0 ? (
        <p className="card p-8 text-center text-slate-500 dark:text-slate-400">No meetings yet. Upload or record one to get started.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="meetings">
          {list.map((m) => (
            <li key={m.id}>
              <button className="card flex h-full w-full flex-col gap-2 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md" onClick={() => onOpen(m.id)}>
                <span className="font-bold">{m.title}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">{m.date} · {duration(m.durationSec)}</span>
                <span className="mt-auto flex flex-wrap gap-1.5 text-xs font-semibold">
                  {m.status === 'ready'
                    ? <span className="rounded-full bg-brand-50 px-2 py-0.5 text-brand-700 dark:bg-brand-600/15 dark:text-brand-400">{m.openActions ? `${m.openActions} open of ${m.actions} actions` : m.actions ? 'All actions done ✓' : 'No actions'}</span>
                    : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">{m.status === 'transcribed' ? 'Minutes not written yet' : 'Unfinished'}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
