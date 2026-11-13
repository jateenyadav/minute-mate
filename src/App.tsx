import { useEffect, useState } from 'react';
import { api, type User } from './api';
import Home from './components/Home';
import NewMeeting from './components/NewMeeting';
import MeetingView from './components/MeetingView';

type View = { kind: 'home' } | { kind: 'new' } | { kind: 'meeting'; id: string };

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem('mm:theme');
      if (saved) return saved === 'dark';
    } catch { /* storage blocked */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('mm:theme', dark ? 'dark' : 'light'); } catch { /* storage blocked */ }
  }, [dark]);
  return [dark, () => setDark((d) => !d)] as const;
}

function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-lg text-white shadow-md shadow-brand-500/30" aria-hidden>≋</span>
      <span className="text-lg font-extrabold tracking-tight">Minute<span className="text-brand-600 dark:text-brand-400">Mate</span></span>
    </span>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>({ kind: 'home' });
  const [dark, toggleTheme] = useTheme();
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ user: User | null }>('/auth/me').then((d) => setUser(d.user), () => {}).finally(() => setLoading(false));
  }, []);

  const signOut = async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    setUser(null);
    setView({ kind: 'home' });
  };

  const deleteAccount = async () => {
    const password = user?.demo ? undefined : window.prompt('Type your password to delete your account and all meetings:');
    if (!user?.demo && !password) return;
    if (user?.demo && !window.confirm('Delete this demo account and its meetings?')) return;
    try {
      await api('/auth/account', { method: 'DELETE', body: { password } });
      setUser(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the account.');
    }
  };

  const themeButton = (
    <button className="grid h-9 w-9 place-items-center rounded-xl text-lg hover:bg-white/70 dark:hover:bg-slate-800" onClick={toggleTheme} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}>{dark ? '☀️' : '🌙'}</button>
  );

  if (loading) return <div className="grid min-h-dvh place-items-center"><Logo /></div>;
  if (!user) return <Landing onUser={setUser} themeButton={themeButton} />;

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 pb-10">
      <header className="no-print flex items-center justify-between gap-3 py-4">
        <Logo />
        <div className="flex items-center gap-1">
          {themeButton}
          <details className="relative">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-xl px-2 text-sm font-semibold hover:bg-white/70 dark:hover:bg-slate-800">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-600/20 dark:text-brand-400">{user.name.slice(0, 1).toUpperCase()}</span>
              <span className="hidden sm:inline">{user.demo ? 'Demo' : user.name}</span>
            </summary>
            <div className="card absolute right-0 z-20 mt-2 w-56 p-2 text-sm">
              {user.demo && <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">Demo account: everything is deleted after 24 hours.</p>}
              <button className="w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={signOut}>Sign out</button>
              <button className="w-full rounded-lg px-3 py-2 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10" onClick={deleteAccount}>Delete account</button>
            </div>
          </details>
        </div>
      </header>

      {error && <p role="alert" className="mb-3 text-sm font-medium text-rose-600">{error}</p>}
      <main className="flex-1">
        {view.kind === 'home' && <Home onNew={() => setView({ kind: 'new' })} onOpen={(id) => setView({ kind: 'meeting', id })} />}
        {view.kind === 'new' && <NewMeeting onDone={(id) => setView({ kind: 'meeting', id })} onCancel={() => setView({ kind: 'home' })} />}
        {view.kind === 'meeting' && <MeetingView id={view.id} onBack={() => setView({ kind: 'home' })} />}
      </main>

    </div>
  );
}

function Landing({ onUser, themeButton }: { onUser: (u: User) => void; themeButton: React.ReactNode }) {
  const [mode, setMode] = useState<'none' | 'login' | 'register'>('none');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async (path: string, body: object) => {
    setBusy(true);
    setError('');
    try {
      onUser((await api<{ user: User }>(path, { body })).user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4">
      <header className="flex items-center justify-between py-4"><Logo />{themeButton}</header>
      <main className="grid flex-1 items-center gap-10 py-8 lg:grid-cols-2">
        <div>
          <p className="inline-block rounded-full bg-accent-500/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-accent-600 dark:text-accent-400">Free · Works in your browser</p>
          <h1 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
            Drop in a meeting.<br />
            <span className="bg-gradient-to-r from-brand-600 via-brand-500 to-accent-500 bg-clip-text text-transparent">Get the minutes.</span>
          </h1>
          <p className="mt-4 max-w-md text-lg text-slate-600 dark:text-slate-300">MinuteMate writes down what was said, then pulls out the decisions, who does what by when, and what is still open. Ask it anything and it points to the exact moment.</p>
          <ul className="mt-6 space-y-2 text-sm">
            {['Timestamped transcript of up to 90 minutes', 'Decisions, action items with owners and due dates', '“Ask this meeting” with clickable timestamps', 'Export as email, Markdown or PDF'].map((f) => (
              <li key={f} className="flex items-center gap-2"><span className="grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-[11px] text-white">✓</span>{f}</li>
            ))}
          </ul>

          <div className="mt-8 flex flex-wrap gap-3">
            <button className="btn-accent px-6 py-3 text-base" disabled={busy} onClick={() => go('/auth/demo', {})}>Try the demo</button>
            <button className="btn-ghost px-6 py-3 text-base" onClick={() => setMode(mode === 'login' ? 'none' : 'login')}>Sign in</button>
          </div>

          {mode !== 'none' && (
            <form className="card mt-5 max-w-sm space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); void go(mode === 'login' ? '/auth/login' : '/auth/register', mode === 'login' ? { email: form.email, password: form.password } : form); }}>
              {mode === 'register' && <input className="field" placeholder="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoComplete="name" />}
              <input className="field" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoComplete="email" />
              <input className="field" type="password" placeholder="Password (8+ characters)" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              <button className="btn-primary w-full" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
              <button type="button" className="w-full text-sm text-slate-500 hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
              </button>
            </form>
          )}
          {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
        </div>

        <div className="relative mx-auto w-full max-w-sm" aria-hidden>
          <div className="absolute -inset-6 -z-10 rounded-[2.5rem] bg-gradient-to-br from-brand-400/30 to-accent-400/30 blur-2xl" />
          <div className="card -rotate-1 space-y-3 p-6 shadow-xl">
            <p className="text-xs font-bold uppercase tracking-wider text-brand-600 dark:text-brand-400">Weekly sync · 24 min</p>
            <p className="font-extrabold">✅ Action items</p>
            {[['Raise the payment timeout to 30 s', 'Rahul', 'Thu', '00:37'], ['Get the cashback budget', 'Sneha', 'Mon', '01:05'], ['Share two banner designs', 'Arjun', 'Fri', '01:17']].map(([t, o, d, at]) => (
              <div key={t} className="rounded-xl border border-brand-200 p-2.5 text-sm dark:border-brand-600/30">
                <p className="font-medium">{t}</p>
                <p className="mt-1 flex gap-1.5 text-xs"><span className="rounded-full bg-accent-500/15 px-2 font-semibold text-accent-600 dark:text-accent-400">👤 {o}</span><span className="rounded-full bg-amber-100 px-2 font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">📅 {d}</span><span className="num rounded-md bg-brand-50 px-1.5 font-bold text-brand-700 dark:bg-brand-600/15 dark:text-brand-400">{at}</span></p>
              </div>
            ))}
            <div className="rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800"><b>You:</b> who owns the budget?<br /><b>MinuteMate:</b> Sneha, by Monday <span className="num rounded bg-brand-600 px-1 text-xs font-bold text-white">01:05</span></div>
          </div>
        </div>
      </main>
      <footer className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
        Built by <a className="font-semibold underline" href="https://github.com/jateenyadav">Jateen Yadav</a> · <a className="underline" href="https://github.com/jateenyadav/minute-mate">Source code</a>
      </footer>
    </div>
  );
}
