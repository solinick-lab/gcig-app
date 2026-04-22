import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Send,
  RotateCcw,
  User,
  AlertTriangle,
  BookOpen,
  LineChart,
  Vote,
  CalendarDays,
} from 'lucide-react';
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
//
// The system prompt is owned server-side (see server/src/ai/clubBrief.js).
// It prepends the IPS, Internal Policies, and live portfolio/voting data
// to every turn and constrains the model to investing + club topics.

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

    // Ship only user/assistant turns — the server owns the system prompt
    // (club IPS + internal policies + live holdings/votes/pitches).
    const payload = nextHistory.map((m) => ({ role: m.role, content: m.content }));

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
        subtitle="Scoped to investing + Griffin Fund topics only. Grounded on the club's IPS, Internal Policies, and live portfolio / voting data."
        actions={
          <Button variant="outline" onClick={reset} disabled={messages.length === 0}>
            <RotateCcw className="h-4 w-4" />
            New chat
          </Button>
        }
      />

      {/* What the AI knows. Read-only — the system prompt is assembled
          server-side from club docs + live data (see ai/clubBrief.js). */}
      <div className="mb-4 rounded-xl border border-navy-100 bg-white px-4 py-4 md:px-5">
        <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700">
          <span className="h-px w-6 bg-gold" />
          What the AI knows
        </div>
        <div className="grid gap-3 text-xs text-navy-500 md:grid-cols-2">
          <div className="flex items-start gap-2">
            <BookOpen className="mt-0.5 h-4 w-4 flex-shrink-0 text-navy-400" />
            <div>
              <div className="font-semibold text-navy">IPS &amp; Internal Policies</div>
              <div>
                Full text of both club documents — roles, voting rules,
                attendance expectations, permitted / prohibited assets.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <LineChart className="mt-0.5 h-4 w-4 flex-shrink-0 text-navy-400" />
            <div>
              <div className="font-semibold text-navy">Current portfolio</div>
              <div>
                Holdings, cash position, sector mix, and per-position
                performance (total return, YTD, daily change) — pulled
                from the Google Sheet and refreshed every 20 minutes.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Vote className="mt-0.5 h-4 w-4 flex-shrink-0 text-navy-400" />
            <div>
              <div className="font-semibold text-navy">Votes &amp; pitches</div>
              <div>
                Open voting sessions, recently closed votes, and pitches
                scheduled for the next two weeks.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CalendarDays className="mt-0.5 h-4 w-4 flex-shrink-0 text-navy-400" />
            <div>
              <div className="font-semibold text-navy">Upcoming events</div>
              <div>
                Regular (audience = all) events in the next two weeks.
                Advisory Board meetings stay private to the board.
              </div>
            </div>
          </div>
        </div>
        <p className="mt-3 border-t border-navy-50 pt-3 text-[11px] text-navy-400">
          Off-topic questions (homework, personal advice, general trivia)
          will be politely declined. This is a research tool, not financial
          advice.
        </p>
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
                Try: "What's our current cash position?" · "Who's voting
                on what right now?" · "Summarize the IPS rules on asset
                allocation." · "Walk me through how a pitch gets approved."
              </p>
              <p className="mt-3 max-w-md text-xs text-navy-300">
                History lives only in this tab — reload to start fresh.
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

// Tailwind classes mapped per markdown element. Kept inline so we don't
// have to fight @tailwindcss/typography's defaults — our bubbles are
// tight, styled, and shouldn't inherit a generic prose theme.
const MD_COMPONENTS = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0 [&_ul]:mt-1 [&_ul]:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0 [&_ol]:mt-1 [&_ol]:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h3 className="mb-2 mt-2 font-serif text-base font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h3 className="mb-2 mt-2 font-serif text-base font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mb-1.5 mt-2 font-serif text-sm font-semibold first:mt-0">
      {children}
    </h4>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-1.5 font-serif text-sm font-semibold first:mt-0">
      {children}
    </h4>
  ),
  code: ({ inline, children }) =>
    inline ? (
      <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[12px]">
        {children}
      </code>
    ) : (
      <code className="font-mono text-[12px]">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-lg bg-black/10 p-2 text-[12px] last:mb-0">
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-gold underline-offset-2 hover:text-gold"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-gold/50 pl-3 italic opacity-90">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-t border-current opacity-20" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1">{children}</td>,
};

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
            isUser ? 'bg-navy text-white' : 'bg-navy-50 text-navy'
          }`}
        >
          {/* User messages we render as plain text (no hidden formatting
              tricks), assistant messages go through markdown so bold,
              lists, headings, etc. render properly. */}
          {isUser ? (
            <div className="whitespace-pre-wrap break-words text-left">
              {message.content}
            </div>
          ) : (
            <div className="break-words text-left">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
        <div className="mt-1 px-1 text-[10px] uppercase tracking-wider text-navy-300">
          {isUser ? 'You' : 'Assistant'} · {formatTime(message.at)}
        </div>
      </div>
    </div>
  );
}

function ThinkingBubble() {
  // Three-dot bouncing indicator. Inline animationDelay because Tailwind's
  // arbitrary-value class can get stripped from the final CSS bundle —
  // plain style props always land in the DOM.
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gold-100 text-navy">
        <Bot className="h-4 w-4" />
      </div>
      <div className="inline-flex items-center gap-2 rounded-2xl bg-navy-50 px-5 py-4">
        <span
          className="h-2.5 w-2.5 rounded-full bg-navy"
          style={{ animation: 'aiBounce 1s infinite ease-in-out', animationDelay: '0s' }}
        />
        <span
          className="h-2.5 w-2.5 rounded-full bg-navy"
          style={{ animation: 'aiBounce 1s infinite ease-in-out', animationDelay: '0.15s' }}
        />
        <span
          className="h-2.5 w-2.5 rounded-full bg-navy"
          style={{ animation: 'aiBounce 1s infinite ease-in-out', animationDelay: '0.3s' }}
        />
      </div>
      {/* Keyframes live inline so this component is fully self-contained —
          no Tailwind plugin / global CSS dependency required. */}
      <style>{`
        @keyframes aiBounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-8px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
