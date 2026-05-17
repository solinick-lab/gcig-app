// Shared LLM client. Tries providers in priority order:
//   1. Local Ollama (free, private — tunneled from club hardware)
//   2. Anthropic Claude (best quality for financial analysis)
//   3. OpenAI (legacy fallback)
//
// Returns the `message.content` string, or null if every provider fails
// (or none is configured). Never throws.
//
// Config:
//   LOCAL_LLM_URL           Base URL of the local endpoint; blank disables.
//   LOCAL_LLM_MODEL         Defaults to qwen2.5:14b-instruct-q4_K_M.
//   LOCAL_LLM_API_KEY       Optional bearer if the tunnel is protected.
//   LOCAL_LLM_TIMEOUT_MS    Shared default timeout. Defaults to 25000.
//   ANTHROPIC_API_KEY       Enables Claude. Preferred cloud provider.
//   ANTHROPIC_MODEL         Defaults to claude-haiku-4-5-20251001.
//   OPENAI_API_KEY          Enables OpenAI fallback.
//   OPENAI_MODEL            Defaults to gpt-4.1-mini.

const DEFAULT_LOCAL_MODEL = 'qwen2.5:14b-instruct-q4_K_M';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_TIMEOUT_MS = 25_000;

function normalizeBase(raw) {
  const s = String(raw).trim().replace(/\/+$/, '');
  if (/\/v1$/.test(s)) return s;
  return `${s}/v1`;
}

// OpenAI's gpt-5 / o-series reasoning models reject non-default temperature
// and require max_completion_tokens instead of max_tokens. Detect by name
// prefix so we omit the params cleanly.
function isReasoningModel(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  return m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
}

// ── OpenAI-compatible endpoint (works for local Ollama + OpenAI) ────

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
    const body = {
      model,
      messages,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    if (!isReasoningModel(model) && temperature != null) {
      body.temperature = temperature;
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || '';
      } catch {
        detail = text.slice(0, 200);
      }
      return { ok: false, status: res.status, detail };
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    return { ok: true, content: typeof content === 'string' ? content : null };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    clearTimeout(timer);
  }
}

// ── Anthropic Messages API ──────────────────────────────────────────
// Different auth, body shape, and response format from OpenAI.
// System prompt is a top-level field, not a message.

async function callAnthropic({
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
    // Extract system message(s) — Anthropic wants them as a top-level field.
    let system;
    const filtered = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = system ? `${system}\n\n${m.content}` : m.content;
      } else {
        filtered.push({ role: m.role, content: m.content });
      }
    }

    // Ensure messages alternate user/assistant. If the first non-system
    // message is assistant, prepend a minimal user turn.
    if (filtered.length > 0 && filtered[0].role === 'assistant') {
      filtered.unshift({ role: 'user', content: '(continue)' });
    }

    const body = {
      model,
      max_tokens: 2048,
      messages: filtered,
      ...(system ? { system } : {}),
      ...(temperature != null ? { temperature } : {}),
    };

    // Anthropic doesn't have a native JSON mode, but we can nudge it
    // by appending an instruction to the system prompt.
    if (jsonMode && system) {
      body.system = system + '\n\nIMPORTANT: Respond with valid JSON only. No prose, no code fences.';
    } else if (jsonMode) {
      body.system = 'Respond with valid JSON only. No prose, no code fences.';
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || '';
      } catch {
        detail = text.slice(0, 200);
      }
      return { ok: false, status: res.status, detail };
    }

    const json = await res.json();
    // Anthropic response: { content: [{ type: 'text', text: '...' }] }
    const text = json?.content?.[0]?.text;
    return { ok: true, content: typeof text === 'string' ? text : null };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    clearTimeout(timer);
  }
}

// ── Logging ─────────────────────────────────────────────────────────

function logFailure(provider, result) {
  if (result.error) {
    if (result.error.name === 'AbortError') {
      console.warn(`llm: ${provider} timed out`);
    } else {
      console.warn(`llm: ${provider} failed:`, result.error.message);
    }
  } else if (result.status) {
    console.warn(`llm: ${provider} responded ${result.status}${result.detail ? ' — ' + result.detail : ''}`);
  }
}

// ── Main entry point ────────────────────────────────────────────────

export async function llmChat({ messages, temperature, jsonMode, timeoutMs } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const effectiveTimeoutMs =
    Number(timeoutMs) ||
    Number(process.env.LOCAL_LLM_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS;

  // Provider 1: local Ollama. Preferred because it's free and private.
  if (process.env.LOCAL_LLM_URL) {
    const local = await callEndpoint({
      endpoint: `${normalizeBase(process.env.LOCAL_LLM_URL)}/chat/completions`,
      apiKey: process.env.LOCAL_LLM_API_KEY,
      model: process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
      messages,
      temperature,
      jsonMode,
      timeoutMs: effectiveTimeoutMs,
    });
    if (local.ok && local.content) return local.content;
    logFailure('local', local);
  }

  // Provider 2: Anthropic Claude. Best cloud option for financial analysis.
  if (process.env.ANTHROPIC_API_KEY) {
    const claude = await callAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      messages,
      temperature,
      jsonMode,
      timeoutMs: effectiveTimeoutMs,
    });
    if (claude.ok && claude.content) return claude.content;
    logFailure('anthropic', claude);
  }

  // Provider 3: OpenAI fallback. Legacy option if everything else is down.
  if (process.env.OPENAI_API_KEY) {
    const openai = await callEndpoint({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      messages,
      temperature,
      jsonMode,
      timeoutMs: effectiveTimeoutMs,
    });
    if (openai.ok && openai.content) return openai.content;
    logFailure('openai', openai);
  }

  return null;
}

// ── Health check ────────────────────────────────────────────────────
// Live probe of each configured provider. Returns per-provider status
// plus an `active` field — the provider that would serve the next
// request (first reachable in priority order).

export async function probeProviders({ timeoutMs = 6000 } = {}) {
  const status = {
    local: { configured: !!process.env.LOCAL_LLM_URL, ok: false, latencyMs: null, error: null, model: null },
    anthropic: { configured: !!process.env.ANTHROPIC_API_KEY, ok: false, latencyMs: null, error: null, model: null },
    openai: { configured: !!process.env.OPENAI_API_KEY, ok: false, latencyMs: null, error: null, model: null },
    active: null,
  };

  const ping = [{ role: 'user', content: 'ok' }];

  if (status.local.configured) {
    const t = Date.now();
    const r = await callEndpoint({
      endpoint: `${normalizeBase(process.env.LOCAL_LLM_URL)}/chat/completions`,
      apiKey: process.env.LOCAL_LLM_API_KEY,
      model: process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
      messages: ping,
      temperature: 0,
      timeoutMs,
    });
    status.local.latencyMs = Date.now() - t;
    status.local.model = process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL;
    if (r.ok) {
      status.local.ok = true;
    } else {
      status.local.error = r.status
        ? `HTTP ${r.status}${r.detail ? ' — ' + r.detail : ''}`
        : r.error?.message || 'unreachable';
    }
  }

  if (status.anthropic.configured) {
    const t = Date.now();
    const r = await callAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      messages: ping,
      temperature: 0,
      timeoutMs,
    });
    status.anthropic.latencyMs = Date.now() - t;
    status.anthropic.model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    if (r.ok) {
      status.anthropic.ok = true;
    } else {
      status.anthropic.error = r.status
        ? `HTTP ${r.status}${r.detail ? ' — ' + r.detail : ''}`
        : r.error?.message || 'unreachable';
    }
  }

  if (status.openai.configured) {
    const t = Date.now();
    const r = await callEndpoint({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      messages: ping,
      temperature: 0,
      timeoutMs,
    });
    status.openai.latencyMs = Date.now() - t;
    status.openai.model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    if (r.ok) {
      status.openai.ok = true;
    } else {
      status.openai.error = r.status
        ? `HTTP ${r.status}${r.detail ? ' — ' + r.detail : ''}`
        : r.error?.message || 'unreachable';
    }
  }

  status.active = status.local.ok ? 'local' : status.anthropic.ok ? 'anthropic' : status.openai.ok ? 'openai' : null;
  return status;
}
