import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Bot, Send, RotateCcw, Sparkles, User, AlertTriangle } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Button from '../components/Button.jsx';

// Experimental AI chat sandbox. Wired to the same local LLM the rest of the
// app uses (article summaries, Week in Review). Super-admin only so we can
// iterate without every member hammering the home GPU.
//
// History lives in component state — no DB persistence yet. A page reload
// wipes the conversation. Good enough for a first pass; we can upgrade to
// a Conversation/Message model later.

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant for The Griffin Fund, Grace Church School's student investment club. Be concise, accurate, and professional. If asked about stocks or markets, give balanced views and note you're not a licensed advisor.";

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function AiChat() {
  const { isSuperAdmin } = useAuth();
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [systemOpen, setSystemOpen] = useState(false);
  const [messages, setMessages] = useState([]); // [{ role, content, at }]
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef(null);
  const textareaRef = useRef(null);

  // Keep the message pane pinned to the latest turn.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // Auto-grow the composer up to ~5 rows.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  if (!isSuperAdmin) return <Navigate to="/dashboard" replace />;

  async function send() {
    const text = input.trim();
    if (!text || pending) return;

    const now = new Date().toISOString();
    const nextHistory = [...messages, { role: 'user', content: text, at: now }];
    setMessages(nextHistory);
    setInput('');
    setError('');
    setPending(true);

    // Build the payload: optional system prompt, then user/assistant turns.
    const payload = [];
    if (systemPrompt.trim()) {
      payload.push({ role: 'system', content: systemPrompt.trim() });
    }
    for (const m of nextHistory) {
      payload.push({ role: m.role, content: m.content });
    }

    try {
      const res = await api.post('/ai-chat', { messages: payload });
      const reply = res.data?.reply;
      if (!reply) throw new Error('Empty response from model');
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: reply, at: new Date().toISOString() },
      ]);
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        err.message ||
        'Something went wrong — try again.';
      setError(msg);
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e) {
    // Enter sends, Shift+Enter inserts newline. Mobile keyboards that
    // emit only keydown for Enter still trigger send.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function reset() {
    setMessages([]);
    setError('');
    setInput('');
  }

  return (
    <>
      <PageHeader
        kicker="Experimental"
        title="AI Sandbox"
        subtitle="ChatGPT-style conversation powered by the club's own model. Super admin only — not yet open to the general body."
        actions={
          <Button variant="outline" onClick={reset} disabled={messages.length === 0}>
            <RotateCcw className="h-4 w-4" />
            New chat
          </Button>
        }
      />

      {/* Collapsible system prompt — lets the super admin steer tone/role
          without leaving the page. Defaults to a sensible Griffin Fund voice. */}
      <div className="mb-4 rounded-xl border border-navy-100 bg-white">
        <button
          type="button"
          onClick={() => setSystemOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-navy-400 hover:text-navy"
        >
          <span className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-gold-700" />
            System prompt
          </span>
          <span className="text-[10px] text-navy-300">
            {systemOpen ? 'Hide' : 'Show'}
          </span>
        </button>
        {systemOpen && (
          <div className="border-t border-navy-100 px-4 py-3">
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm text-navy placeholder:text-navy-300 focus:border-gold focus:outline-none"
              placeholder="Instructions that shape how the model responds…"
            />
            <p className="mt-2 text-[11px] text-navy-400">
              Applied to every turn. Edits take effect on the next send.
            </p>
          </div>
        )}
      </div>

      <div className="flex min-h-[60vh] flex-col rounded-xl border border-navy-100 bg-white">
        {/* Message list */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-4 py-5 md:px-6"
          style={{ maxHeight: 'calc(100vh - 320px)' }}
        >
          {messages.length === 0 && !pending && (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center">
              <div className="rounded-full bg-gold-100 p-4">
                <Bot className="h-8 w-8 text-navy" />
              </div>
              <h2 className="mt-4 font-serif text-xl font-semibold text-navy">
                Ask the house model
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-navy-400">
                Conversation history lives only in this tab — reload the page
                to start fresh. Responses come from the local model when the
                tunnel is up, OpenAI otherwise.
              </p>
            </div>
          )}

          <div className="space-y-5">
            {messages.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
            {pending && <ThinkingBubble />}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-navy-100 px-4 py-3 md:px-6 md:py-4">
          {error && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Message the model…  (Enter to send, Shift+Enter for newline)"
              disabled={pending}
              className="flex-1 resize-none rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm text-navy placeholder:text-navy-300 focus:border-gold focus:outline-none disabled:opacity-50"
              style={{ maxHeight: 160 }}
            />
            <Button
              variant="gold"
              onClick={send}
              disabled={pending || !input.trim()}
              className="h-10 px-3"
            >
              <Send className="h-4 w-4" />
              <span className="hidden md:inline">Send</span>
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-navy-400">
            History isn't persisted. Every turn sends the whole conversation
            so far — long chats may hit the context limit.
          </p>
        </div>
      </div>
    </>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
          isUser ? 'bg-navy text-gold' : 'bg-gold-100 text-navy'
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={`max-w-[85%] ${isUser ? 'text-right' : ''}`}>
        <div
          className={`inline-block rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? 'bg-navy text-white'
              : 'bg-navy-50 text-navy'
          }`}
        >
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
        <div className="mt-1 px-1 text-[10px] uppercase tracking-wider text-navy-300">
          {isUser ? 'You' : 'Assistant'} · {formatTime(message.at)}
        </div>
      </div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gold-100 text-navy">
        <Bot className="h-4 w-4" />
      </div>
      <div className="inline-flex items-center gap-1 rounded-2xl bg-navy-50 px-4 py-3">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-navy-300 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-navy-300 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-navy-300" />
      </div>
    </div>
  );
}
