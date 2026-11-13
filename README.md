# MinuteMate

**Live website:** https://minute-mate-jateen.netlify.app · [![CI](https://github.com/jateenyadav/minute-mate/actions/workflows/ci.yml/badge.svg)](https://github.com/jateenyadav/minute-mate/actions/workflows/ci.yml)

Drop in a meeting. Get minutes, decisions and a to-do list.

Upload or record a meeting of up to 90 minutes. MinuteMate writes a timestamped transcript. From it, it
pulls the decisions, the action items (with owner and due date) and the open questions. Then you can ask
it anything about the meeting: every answer links to the moment it was said, and clicking a timestamp
plays that moment. Click **Try the demo** for a finished sample meeting; no sign-up needed.

<!-- demo video: docs/demo.mp4 -->

## Features
- **Timestamped transcript**, searchable. While the recording plays, the current line is highlighted.
- **Minutes**: overview, topics, summary, decisions, action items (owner, due date, done ✓) and open
  questions, each with a clickable timestamp.
- **Ask this meeting**: answers cite moments like `[12:34]`. Citations that don't point to a real moment of
  the meeting are removed on the server before you see them.
- **Export** as Markdown, email-ready text, or PDF (print view).
- **"Names & terms" box**: the names and terms you type are passed to Whisper so they're spelled right
  (e.g. *Priya, Razorpay, KYC*).
- **Privacy**: audio is processed and thrown away, never stored. Only the text is saved. You can delete
  your account and everything in it at any time.

## How it works
```
Browser                                              Netlify Function (Express)            Free AI
───────                                              ──────────────────────────            ───────
recording → decode → 16 kHz mono
  → cut into ~90 s pieces at the quietest moment
  → WAV (≤ ~3 MB each)  ──POST /meetings/:id/chunks/:i──▶ daily audio cap ──────────────▶ Groq Whisper
                                                      segments + time offset → MongoDB   large-v3-turbo
  (progress bar, retries when the free AI is busy)
  ──POST /minutes/step {part} × N──▶ notes for one ~1,100-word window (zod-checked) ──▶ Llama 3.3 70B
  ──POST /minutes/finish──────────▶ merge notes → final minutes, clamp timestamps   ──▶ (Gemini fallback)
  ──POST /ask──────────────────────▶ BM25 finds the 6 best passages → answer + [mm:ss]
```
Every request is short, so the whole thing runs on Netlify's free tier: each call fits in ~10 s and 6 MB.
The long job is a sequence of small steps that the **browser** runs. This replaces the Redis + Celery
worker queue of the original project.

## Measured results
[`scripts/eval.mjs`](scripts/eval.mjs) runs the same API on real meetings from the
[AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) (CC BY 4.0). It measures the transcript's
word error rate against AMI's hand transcript, and the recall/precision of action items and decisions
against AMI's hand-written summaries. Results go in `docs/eval-results.md`. *(Not run yet: this needs a
real Groq key. No numbers are shown until there is a real run.)*

## Key decisions
- **Browser-run pipeline instead of a job queue.** No worker, no Redis, no paid plan, and the progress bar
  is honest. The trade-off: the tab must stay open while a meeting is processed.
- **Cut at silence, not at fixed times**, so words aren't split between pieces. Pieces are 16 kHz mono WAV,
  the format Whisper uses internally, so no quality is lost by shrinking the audio first.
- **Map → merge summaries**: each call only sees about 1,100 words, which keeps every call fast and within
  free-tier per-minute token limits.
- **BM25 keyword search for "Ask"**, not a vector database. For one meeting it's instant, free and
  explainable.
- **Grounding rules**: the transcript is treated as data, never as instructions. Timestamps past the end of
  the meeting are dropped, and invented citations are removed.

## Run locally
```bash
npm install
npm run dev        # API on :8888 + web on :5173. No keys needed: in-memory DB + fake AI
npm test           # 17 API + logic tests
npm run test:e2e   # Playwright: demo → actions → ask → transcript → new recording → minutes (desktop + phone)
node scripts/eval.mjs   # accuracy run on AMI meetings (needs GROQ_API_KEY)
```

## Environment variables
See [`.env.example`](.env.example). The live site needs `MONGODB_URI` and `GROQ_API_KEY`. `GEMINI_API_KEY`
is an optional text fallback.

## Credits
Inspired by [inboxpraveen/LLM-Minutes-of-Meeting](https://github.com/inboxpraveen/LLM-Minutes-of-Meeting).
This is an independent implementation. Evaluation data: AMI Meeting Corpus, CC BY 4.0. The demo meeting is
made up.

## License
MIT
