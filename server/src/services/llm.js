// Shared LLM client. Tries the local OpenAI-compatible endpoint first
// (LOCAL_LLM_URL — typically Ollama tunneled from the club's own hardware),
// then falls back to OpenAI if OPENAI_API_KEY is set. Both providers speak
// the same /chat/completions shape, so callers don't care which one served
// the request.
//
// Returns the `message.content` string, or null if both providers fail
// (or neither is configured). Never throws.
//
// Config:
//   LOCAL_LLM_URL         Base URL of the local endpoint; blank disables local.
//   LOCAL_LLM_MODEL       Defaults to qwen2.5:14b-instruct-q4_K_M.
//   LOCAL_LLM_API_KEY     Optional bearer if the tunnel is protected.
//   LOCAL_LLM_TIMEOUT_MS  Shared with OpenAI. Defaults to 25000.
//   OPENAI_API_KEY        Enables fallback.
//   OPENAI_MODEL          Defaults to gpt-4o-mini.

const DEFAULT_LOCAL_MODEL = 'qwen2.5:14b-instruct-q4_K_M';
const DEFAULT_OPENAI_MODEL = 'gpt-5-nano';
const DEFAULT_TIMEOUT_MS = 25_000;

function normalizeBase(raw) {
  const s = String(raw).trim().replace(/\/+$/, '');
  if (/\/v1$/.test(s)) return s;
  return `${s}/v1`;
}

async function callEndpoint({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  jsonMode,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: temperature ?? 0.2,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages,
      }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    return { ok: true, content: typeof content === 'string' ? content : null };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    clearTimeout(timer);
  }
}

function logFailure(provider, result) {
  if (result.error) {
    if (result.error.name === 'AbortError') {
      console.warn(`llm: ${provider} timed out`);
    } else {
      console.warn(`llm: ${provider} failed:`, result.error.message);
    }
  } else if (result.status) {
    console.warn(`llm: ${provider} responded ${result.status}`);
  }
}

export async function llmChat({ messages, temperature, jsonMode } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const timeoutMs = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  // Provider 1: local Ollama. Preferred because it's free and private.
  if (process.env.LOCAL_LLM_URL) {
    const local = await callEndpoint({
      endpoint: `${normalizeBase(process.env.LOCAL_LLM_URL)}/chat/completions`,
      apiKey: process.env.LOCAL_LLM_API_KEY,
      model: process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
      messages,
      temperature,
      jsonMode,
      timeoutMs,
    });
    if (local.ok && local.content) return local.content;
    logFailure('local', local);
  }

  // Provider 2: OpenAI fallback. Keeps AI features alive when the home
  // machine / Cloudflare tunnel is down.
  if (process.env.OPENAI_API_KEY) {
    const openai = await callEndpoint({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      messages,
      temperature,
      jsonMode,
      timeoutMs,
    });
    if (openai.ok && openai.content) return openai.content;
    logFailure('openai', openai);
  }

  return null;
}

// Live health check of each configured provider. Returns per-provider
// { configured, ok, latencyMs, error } plus an `active` field — the provider
// that would serve the next request (first reachable in priority order).
// Short timeout on purpose: this drives a UI that shouldn't hang.
export async function probeProviders({ timeoutMs = 6000 } = {}) {
  const status = {
    local: { configured: !!process.env.LOCAL_LLM_URL, ok: false, latencyMs: null, error: null, model: null },
    openai: { configured: !!process.env.OPENAI_API_KEY, ok: false, latencyMs: null, error: null, model: null },
    active: null,
  };

  const ping = { messages: [{ role: 'user', content: 'ok' }] };

  if (status.local.configured) {
    const t = Date.now();
    const r = await callEndpoint({
      endpoint: `${normalizeBase(process.env.LOCAL_LLM_URL)}/chat/completions`,
      apiKey: process.env.LOCAL_LLM_API_KEY,
      model: process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
      messages: ping.messages,
      temperature: 0,
      timeoutMs,
    });
    status.local.latencyMs = Date.now() - t;
    status.local.model = process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL;
    if (r.ok) {
      status.local.ok = true;
    } else {
      status.local.error = r.status ? `HTTP ${r.status}` : r.error?.message || 'unreachable';
    }
  }

  if (status.openai.configured) {
    const t = Date.now();
    const r = await callEndpoint({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      messages: ping.messages,
      temperature: 0,
      timeoutMs,
    });
    status.openai.latencyMs = Date.now() - t;
    status.openai.model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    if (r.ok) {
      status.openai.ok = true;
    } else {
      status.openai.error = r.status ? `HTTP ${r.status}` : r.error?.message || 'unreachable';
    }
  }

  status.active = status.local.ok ? 'local' : status.openai.ok ? 'openai' : null;
  return status;
}
