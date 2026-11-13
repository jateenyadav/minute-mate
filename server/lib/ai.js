// shared-kit v1.2 — AI client with provider fallback.
// v1.2: image cache key hashes the image bytes (was: only the length); transcribe() (Whisper);
// embed() (embeddings); dev/fake-ai.mjs for keyless local dev + tests.
// v1.2.1: GEMINI_REASONING_EFFORT (e.g. "none" = no thinking, fits Netlify's 10 s limit).
// Grown from Exam-AI/lib/ai/index.ts (generateJson + zod + fallback). Every provider here speaks the
// OpenAI chat-completions format, so one code path covers Groq, Gemini (OpenAI-compatible endpoint)
// and OpenRouter. Model output is untrusted input: JSON is schema-checked before use.

import { createHash } from 'node:crypto';

export class AiUnavailableError extends Error {
  constructor(message = 'The AI is busy right now. Please try again in a minute.') {
    super(message);
    this.status = 503;
  }
}

const PRESETS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', audioModel: 'whisper-large-v3-turbo' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', vision: true, embedModel: 'gemini-embedding-001' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
};

/**
 * Build the provider list from env. Only providers with a key are included.
 * Model names come from env so they can change without a code change:
 * GROQ_MODEL, GROQ_VISION_MODEL, GROQ_AUDIO_MODEL, GEMINI_MODEL, GEMINI_EMBED_MODEL, OPENROUTER_MODEL,
 * OPENROUTER_VISION_MODEL, GEMINI_REASONING_EFFORT. Set GROQ_AUDIO_MODEL=off or GEMINI_EMBED_MODEL=off to disable those.
 * Base URLs can be overridden too (GROQ_BASE_URL, GEMINI_BASE_URL, OPENROUTER_BASE_URL): used in
 * local development to point at dev/fake-ai.mjs, so AI screens can be built without real keys.
 */
/** GEMINI_REASONING_EFFORT=none|low|medium|high → sent as reasoning_effort ("none" turns Gemini 2.5 Flash thinking off: much faster). */
const reasoning = (v) => (v && v !== 'off' ? { reasoning_effort: v } : undefined);

export function providersFromEnv(env = process.env) {
  const list = [];
  if (env.GROQ_API_KEY) {
    list.push({ name: 'groq', ...PRESETS.groq, baseUrl: env.GROQ_BASE_URL || PRESETS.groq.baseUrl, apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL || PRESETS.groq.model, visionModel: env.GROQ_VISION_MODEL || null, audioModel: optional(env.GROQ_AUDIO_MODEL, PRESETS.groq.audioModel), embedModel: null });
  }
  if (env.GEMINI_API_KEY) {
    const model = env.GEMINI_MODEL || PRESETS.gemini.model;
    list.push({ name: 'gemini', ...PRESETS.gemini, baseUrl: env.GEMINI_BASE_URL || PRESETS.gemini.baseUrl, apiKey: env.GEMINI_API_KEY, model, visionModel: model, audioModel: null, embedModel: optional(env.GEMINI_EMBED_MODEL, PRESETS.gemini.embedModel), extraBody: reasoning(env.GEMINI_REASONING_EFFORT) });
  }
  if (env.OPENROUTER_API_KEY) {
    list.push({ name: 'openrouter', ...PRESETS.openrouter, baseUrl: env.OPENROUTER_BASE_URL || PRESETS.openrouter.baseUrl, apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || PRESETS.openrouter.model, visionModel: env.OPENROUTER_VISION_MODEL || null, audioModel: null, embedModel: null });
  }
  return list;
}

/** env value → model name; 'off' disables; empty → preset default. */
function optional(value, fallback) {
  if (value === 'off') return null;
  return value || fallback;
}

/** Models often wrap JSON in ``` fences or add prose — pull out the JSON value. */
export function extractJson(text) {
  const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('AI response was not JSON');
  }
}

const hashKey = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Hash of the image bytes, so two different images never share a cache entry. */
const imageKey = (image) => (image ? `${image.mimeType}:${createHash('sha256').update(String(image.base64)).digest('hex')}` : null);

/**
 * @param {object} opts
 * @param {Array} [opts.providers]  from providersFromEnv()
 * @param {number} [opts.timeoutMs] per provider attempt
 * @param {number} [opts.budgetMs] total time for one request across all providers. Set it below the
 *   host's request limit (serverless functions are cut off hard), so the user gets a friendly
 *   "AI is busy" answer instead of a gateway timeout.
 * @param {{get:(k:string)=>Promise<any>, set:(k:string,v:any,ttlMs:number)=>Promise<void>}} [opts.cache]
 * @param {(level:string,data:object)=>void} [opts.log]
 * @param {typeof fetch} [opts.fetch]
 * @param {string} [opts.appName]  sent to OpenRouter as X-Title
 */
/** An attempt shorter than this is not worth starting. */
const MIN_ATTEMPT_MS = 1200;

export function createAi({ providers = providersFromEnv(), timeoutMs = 30000, budgetMs, cache, log = () => {}, fetch: fetchImpl = globalThis.fetch, appName = 'app' } = {}) {
  /** Providers able to serve this request, in try order. Images go to vision-capable models first. */
  function order(needsVision) {
    if (!needsVision) return providers.map((p) => ({ ...p, use: p.model }));
    return providers
      .filter((p) => p.visionModel)
      .sort((a, b) => (b.vision ? 1 : 0) - (a.vision ? 1 : 0))
      .map((p) => ({ ...p, use: p.visionModel }));
  }

  function buildMessages({ system, messages, prompt, image }) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    if (messages) out.push(...messages);
    if (prompt !== undefined) {
      out.push({
        role: 'user',
        content: image
          ? [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
            ]
          : prompt,
      });
    }
    return out;
  }

  async function callOnce(p, body, signal) {
    const res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${p.apiKey}`,
        'Content-Type': 'application/json',
        ...(p.name === 'openrouter' ? { 'X-Title': appName } : {}),
      },
      body: JSON.stringify({ ...body, ...(p.extraBody || {}), model: p.use }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`${p.name} ${res.status} ${detail.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** Try each provider until one returns a result that passes `accept` (which may throw). */
  async function withFallback(label, req, body, accept) {
    const list = order(Boolean(req.image));
    if (!list.length) throw new AiUnavailableError(req.image ? 'No AI model that can read images is configured.' : 'AI is not configured on this server.');
    const budget = req.budgetMs ?? budgetMs;
    const deadline = req.deadline ?? (budget ? Date.now() + budget : null);
    let lastError;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const started = Date.now();
      let attemptMs = req.timeoutMs ?? timeoutMs;
      if (deadline) {
        const remaining = deadline - started;
        if (remaining < MIN_ATTEMPT_MS) break;
        // Leave time for the providers after this one: a hanging first provider must not eat the whole budget.
        const share = i < list.length - 1 ? Math.max(MIN_ATTEMPT_MS, remaining * 0.6) : remaining;
        attemptMs = Math.min(attemptMs, share);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptMs);
      try {
        const data = await callOnce(p, body, controller.signal);
        const result = accept(data, p);
        log('info', { ai: label, provider: p.name, model: p.use, ms: Date.now() - started, ok: true });
        return result;
      } catch (err) {
        lastError = err;
        log('warn', { ai: label, provider: p.name, model: p.use, ms: Date.now() - started, ok: false, msg: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err).slice(0, 200) });
      } finally {
        clearTimeout(timer);
      }
    }
    const e = new AiUnavailableError();
    e.cause = lastError;
    throw e;
  }

  async function cached(req, compute) {
    if (!cache || !req.cacheTtlMs) return compute();
    const key = `ai:${req.label || 'x'}:${hashKey(req.cacheKey ?? [req.system, req.messages, req.prompt, imageKey(req.image)])}`;
    const hit = await cache.get(key).catch(() => null);
    if (hit !== null && hit !== undefined) return hit;
    const value = await compute();
    await cache.set(key, value, req.cacheTtlMs).catch(() => {});
    return value;
  }

  /**
   * Plain chat. Returns { text, provider, model }.
   * req: { system, messages?, prompt?, image?: {mimeType, base64}, maxTokens?, temperature?, label?, cacheTtlMs?, cacheKey? }
   */
  async function chat(req) {
    return cached(req, () =>
      withFallback(
        req.label || 'chat',
        req,
        { messages: buildMessages(req), max_tokens: req.maxTokens ?? 1200, temperature: req.temperature ?? 0.4 },
        (data, p) => {
          const text = data?.choices?.[0]?.message?.content;
          if (!text || !String(text).trim()) throw new Error('empty answer');
          return { text: String(text).trim(), provider: p.name, model: p.use };
        },
      ),
    );
  }

  /**
   * Ask for JSON matching a zod schema. A provider "fails" if it errors, times out or returns
   * output that doesn't match — then the next provider is tried.
   */
  async function json(schema, req) {
    const system = `${req.system || ''}\n\nReply with ONLY valid JSON. No markdown, no commentary.`.trim();
    return cached(req, () =>
      withFallback(
        req.label || 'json',
        req,
        {
          messages: buildMessages({ ...req, system }),
          max_tokens: req.maxTokens ?? 2000,
          temperature: req.temperature ?? 0.2,
          response_format: { type: 'json_object' },
        },
        (data) => {
          const parsed = schema.safeParse(extractJson(data?.choices?.[0]?.message?.content));
          if (!parsed.success) throw new Error(`schema mismatch: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
          return parsed.data;
        },
      ),
    );
  }

  /**
   * Small agent loop with tool calling.
   * tools: { name: { description, parameters (JSON Schema), run: async (args, ctx) => result } }
   * Returns { text, steps: [{tool, args, result}] }. Tool results are sent back to the model as JSON.
   * A tool can return { confirm: true, preview } to stop the loop and ask the user first.
   * The whole loop shares one time budget (budgetMs), not one per step.
   */
  async function agent({ system, messages, tools, maxSteps = 4, label = 'agent', ctx, budgetMs: loopBudget = budgetMs }) {
    const deadline = loopBudget ? Date.now() + loopBudget : undefined;
    const toolDefs = Object.entries(tools).map(([name, t]) => ({
      type: 'function',
      function: { name, description: t.description, parameters: t.parameters },
    }));
    const convo = buildMessages({ system, messages });
    const steps = [];
    for (let i = 0; i < maxSteps; i++) {
      const msg = await withFallback(label, { deadline }, { messages: convo, tools: toolDefs, tool_choice: 'auto', max_tokens: 1200, temperature: 0.2 }, (data) => {
        const m = data?.choices?.[0]?.message;
        if (!m) throw new Error('empty answer');
        return m;
      });
      const calls = msg.tool_calls || [];
      if (!calls.length) return { text: String(msg.content || '').trim(), steps };
      convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
      for (const call of calls) {
        const tool = tools[call.function?.name];
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* bad args → tool sees {} */ }
        let result;
        if (!tool) result = { error: 'unknown tool' };
        else {
          try { result = await tool.run(args, ctx); } catch (err) { result = { error: String(err?.message || err) }; }
        }
        steps.push({ tool: call.function?.name, args, result });
        if (result && result.confirm) return { text: result.message || '', steps, pending: result };
        convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
      }
    }
    return { text: 'I could not finish that in a few steps. Try asking in a simpler way.', steps };
  }

  /** Run `fn(provider, signal)` on each provider in `list` until one succeeds, inside the time budget. */
  async function tryEach(label, list, req, fn) {
    const budget = req.budgetMs ?? budgetMs;
    const deadline = budget ? Date.now() + budget : null;
    let lastError;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const started = Date.now();
      let attemptMs = req.timeoutMs ?? timeoutMs;
      if (deadline) {
        const remaining = deadline - started;
        if (remaining < MIN_ATTEMPT_MS) break;
        attemptMs = Math.min(attemptMs, i < list.length - 1 ? Math.max(MIN_ATTEMPT_MS, remaining * 0.6) : remaining);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptMs);
      try {
        const out = await fn(p, controller.signal);
        log('info', { ai: label, provider: p.name, ms: Date.now() - started, ok: true });
        return out;
      } catch (err) {
        lastError = err;
        log('warn', { ai: label, provider: p.name, ms: Date.now() - started, ok: false, msg: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err).slice(0, 200) });
      } finally {
        clearTimeout(timer);
      }
    }
    const e = new AiUnavailableError();
    e.cause = lastError;
    throw e;
  }

  async function failOnHttpError(res, p) {
    if (res.ok) return;
    const detail = await res.text().catch(() => '');
    const err = new Error(`${p.name} ${res.status} ${detail.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }

  /**
   * Speech to text (Whisper, OpenAI-compatible /audio/transcriptions). Send short chunks: serverless
   * hosts cap request size (Netlify ~6 MB) and time.
   * req: { audio: Uint8Array|Buffer|Blob, mimeType, filename?, language?, prompt?, budgetMs?, timeoutMs? }
   * Returns { text, segments: [{start, end, text}], duration, language, provider, model }.
   */
  async function transcribe(req) {
    const list = providers.filter((p) => p.audioModel);
    if (!list.length) throw new AiUnavailableError('No speech-to-text model is configured.');
    const blob = req.audio instanceof Blob ? req.audio : new Blob([req.audio], { type: req.mimeType || 'audio/mpeg' });
    return tryEach(req.label || 'transcribe', list, req, async (p, signal) => {
      const form = new FormData();
      form.append('file', blob, req.filename || 'audio.mp3');
      form.append('model', p.audioModel);
      form.append('response_format', 'verbose_json');
      if (req.language) form.append('language', req.language);
      if (req.prompt) form.append('prompt', req.prompt);
      const res = await fetchImpl(`${p.baseUrl}/audio/transcriptions`, { method: 'POST', signal, headers: { Authorization: `Bearer ${p.apiKey}` }, body: form });
      await failOnHttpError(res, p);
      const data = await res.json();
      if (typeof data?.text !== 'string') throw new Error('no transcript in answer');
      return {
        text: data.text.trim(),
        segments: (data.segments || []).map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() })),
        duration: Number(data.duration) || null,
        language: data.language || req.language || null,
        provider: p.name,
        model: p.audioModel,
      };
    });
  }

  /**
   * Text embeddings (OpenAI-compatible /embeddings). Each text is cached on its own when a cache is set.
   * req: { input: string|string[], dimensions?, cacheTtlMs?, budgetMs? }
   * Returns { vectors: number[][], provider, model }. Vectors from different models must not be mixed;
   * store `model` next to each vector.
   */
  async function embed(req) {
    const list = providers.filter((p) => p.embedModel);
    if (!list.length) throw new AiUnavailableError('No embedding model is configured.');
    const inputs = (Array.isArray(req.input) ? req.input : [req.input]).map((t) => String(t ?? ''));
    const ttl = cache && req.cacheTtlMs;
    const keyOf = (p, text) => `emb:${p.embedModel}:${req.dimensions || 0}:${hashKey(text)}`;
    return tryEach(req.label || 'embed', list, req, async (p, signal) => {
      const vectors = new Array(inputs.length).fill(null);
      if (ttl) await Promise.all(inputs.map(async (t, i) => { vectors[i] = (await cache.get(keyOf(p, t)).catch(() => null)) ?? null; }));
      const missing = inputs.map((t, i) => (vectors[i] ? -1 : i)).filter((i) => i >= 0);
      if (missing.length) {
        const res = await fetchImpl(`${p.baseUrl}/embeddings`, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: p.embedModel, input: missing.map((i) => inputs[i]), ...(req.dimensions ? { dimensions: req.dimensions } : {}) }),
        });
        await failOnHttpError(res, p);
        const data = await res.json();
        const rows = [...(data?.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== missing.length || rows.some((r) => !Array.isArray(r.embedding))) throw new Error('bad embeddings answer');
        missing.forEach((idx, j) => { vectors[idx] = rows[j].embedding; });
        if (ttl) await Promise.all(missing.map((idx) => cache.set(keyOf(p, inputs[idx]), vectors[idx], req.cacheTtlMs).catch(() => {})));
      }
      return { vectors, provider: p.name, model: p.embedModel };
    });
  }

  return {
    chat,
    json,
    agent,
    transcribe,
    embed,
    status: () => ({ providers: providers.map((p) => ({ name: p.name, model: p.model, vision: Boolean(p.visionModel), audio: Boolean(p.audioModel), embeddings: Boolean(p.embedModel) })) }),
    configured: () => providers.length > 0,
  };
}

/** Cosine similarity of two equal-length vectors (0 when either is all zeros). */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
