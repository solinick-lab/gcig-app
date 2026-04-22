import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Send,
  Plus,
  User,
  AlertTriangle,
  BookOpen,
  LineChart,
  Vote,
  CalendarDays,
  Trash2,
  MessageSquare,
  ChevronDown,
} from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Button from '../components/Button.jsx';

// The Griffin Fund AI Assistant — persistent, session-backed chat for
// every club member. Conversations live server-side (see ai_chat_sessions
// + ai_chat_messages tables). The client ships only a sessionId + the
// new user turn; the server reads prior history from the DB before
// calling the model, so "assistant" messages can't be forged client-side.

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

function formatRelative(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const min = Math.round(diffMs / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

export default function AiChat() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]); // [{id, title, updatedAt, messageCount}]
  const [sessionId, setSessionId] = useState(null); // null = unsaved new chat
  const [messages, setMessages] = useState([]); // [{role, content, createdAt}]
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sessionsOpen, setSessionsOpen] = useState(false); // mobile dropdown
  const [infoOpen, setInfoOpen] = useState(false);
  const listRef = useRef(null);
  const textareaRef = useRef(null);

  // Initial session list load.
  useEffect(() => {
    loadSessions();
  }, []);

  // Keep message pane pinned to the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // Auto-grow composer up to ~5 rows.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function loadSessions() {
    try {
      const res = await api.get('/ai-chat/sessions');
      setSessions(res.data || []);
    } catch {
      /* ignore — empty sidebar is fine */
    }
  }

  async function openSession(id) {
    setSessionsOpen(false);
    if (id === sessionId) return;
    try {
      const res = await api.get(`/ai-chat/sessions/${id}`);
      setSessionId(res.data.id);
      setMessages(
        (res.data.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        }))
      );
      setError('');
    } catch {
      setError('Could not load that conversation.');
    }
  }

  function newChat() {
    setSessionId(null);
    setMessages([]);
    setError('');
    setInput('');
    setSessionsOpen(false);
    // focus the composer — feels right after "New chat"
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function deleteSession(id, e) {
    e?.stopPropagation();
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    try {
      await api.delete(`/ai-chat/sessions/${id}`);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === sessionId) newChat();
    } catch {
      setError('Could not delete that conversation.');
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || pending) return;

    // Optimistically append the user turn so the UI feels snappy.
    const pendingAt = new Date().toISOString();
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, createdAt: pendingAt },
    ]);
    setInput('');
    setError('');
    setPending(true);

    try {
      const res = await api.post('/ai-chat', {
        sessionId: sessionId ?? undefined,
        message: text,
      });
      const { sessionId: newId, title, reply } = res.data;
      setSessionId(newId);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: reply, createdAt: new Date().toISOString() },
      ]);
      // Refresh the sidebar ordering / titling. Cheap — a single GET.
      loadSessions();
      // If this was a brand-new session, also upsert it locally so the
      // sidebar highlight lines up before the refresh lands.
      if (newId && !sessions.some((s) => s.id === newId)) {
        setSessions((prev) => [
          {
            id: newId,
            title: title || 'New conversation',
            updatedAt: new Date().toISOString(),
            messageCount: 2,
          },
          ...prev,
        ]);
      }
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        err.message ||
        'Something went wrong — try again.';
      setError(msg);
      // Roll back the optimistic user turn so the composer makes sense.
      setMessages((prev) => prev.slice(0, -1));
      setInput(text);
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === sessionId) || null,
    [sessions, sessionId]
  );

  return (
    <>
      <PageHeader
        kicker="Assistant"
        title="AI Assistant"
        subtitle="Ask about investments or the Griffin Fund. Grounded on the IPS, Internal Policies, and live portfolio + voting data."
        actions={
          <Button onClick={newChat} variant="gold">
            <Plus className="h-4 w-4" />
            New chat
          </Button>
        }
      />

      {/* Two-column layout on desktop: conversations sidebar + chat pane.
          On mobile the sidebar collapses into a dropdown at the top. */}
      <div className="grid gap-4 md:grid-cols-[260px_1fr] md:gap-5">
        {/* Sessions sidebar — desktop */}
        <aside className="hidden md:block">
          <SessionsList
            sessions={sessions}
            activeId={sessionId}
            onOpen={openSession}
            onDelete={deleteSession}
          />
        </aside>

        {/* Sessions dropdown — mobile */}
        <div className="md:hidden">
          <button
            type="button"
            onClick={() => setSessionsOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-xl border border-navy-100 bg-white px-4 py-2.5 text-sm font-semibold text-navy"
          >
            <span className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-navy-400" />
              {activeSession ? activeSession.title : 'New conversation'}
            </span>
            <ChevronDown
              className={`h-4 w-4 text-navy-400 transition ${
                sessionsOpen ? 'rotate-180' : ''
              }`}
            />
          </button>
          {sessionsOpen && (
            <div className="mt-2">
              <SessionsList
                sessions={sessions}
                activeId={sessionId}
                onOpen={openSession}
                onDelete={deleteSession}
              />
            </div>
          )}
        </div>

        {/* Chat pane */}
        <div className="flex min-h-[60vh] flex-col rounded-xl border border-navy-100 bg-white">
          {/* Collapsible "What the AI knows" summary */}
          <div className="border-b border-navy-100 px-4 py-3 md:px-5">
            <button
              type="button"
              onClick={() => setInfoOpen((v) => !v)}
              className="flex w-full items-center justify-between text-left text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700 hover:text-gold"
            >
              <span className="flex items-center gap-2">
                <span className="h-px w-6 bg-gold" />
                What the AI knows
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-navy-300 transition ${
                  infoOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
            {infoOpen && (
              <div className="mt-3 grid gap-3 text-xs text-navy-500 md:grid-cols-2">
                <div className="flex items-start gap-2">
                  <BookOpen className="mt-0.5 h-4 w-4 flex-shrink-0 text-navy-400" />
                  <div>
                    <div className="font-semibold text-navy">
                      IPS &amp; Internal Policies
                    </div>
                    <div>
                      Full text of both club documents — roles, voting rules,
                      attendance, permitted / prohibited assets.
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <LineChart className="mt-0.5 h-4 w-4 flex-shrink-0 text-navy-400" />
                  <div>
                    <div className="font-semibold text-navy">Current portfolio</div>
                    <div>
                      Holdings, cash, sector mix, and per-position performance
                      — refreshed every 20 minutes from the Google Sheet.
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
                      Regular events in the next two weeks. Advisory Board
                      meetings stay private to the board.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Message list */}
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto px-4 py-5 md:px-6"
            style={{ maxHeight: 'calc(100vh - 360px)' }}
          >
            {messages.length === 0 && !pending && (
              <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center">
                <div className="rounded-full bg-gold-100 p-4">
                  <Bot className="h-8 w-8 text-navy" />
                </div>
                <h2 className="mt-4 font-serif text-xl font-semibold text-navy">
                  {`Hi ${
                    user?.honorificName ||
                    user?.firstName ||
                    user?.name?.split(' ')[0] ||
                    'there'
                  } — ask me anything`}
                </h2>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-navy-400">
                  Try: "What's our current cash position?" · "Who's voting on
                  what right now?" · "Tell me about our NOC position." · "Walk
                  me through how a pitch gets approved."
                </p>
                <p className="mt-3 max-w-md text-xs text-navy-300">
                  Conversations are saved to your account. Pick an earlier one
                  from the left, or start a new chat any time.
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
                placeholder="Ask about investments or the Griffin Fund…  (Enter to send, Shift+Enter for newline)"
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
          </div>
        </div>
      </div>
    </>
  );
}

function SessionsList({ sessions, activeId, onOpen, onDelete }) {
  return (
    <div className="overflow-hidden rounded-xl border border-navy-100 bg-white">
      <div className="flex items-center gap-2 border-b border-navy-100 px-3 py-2.5">
        <MessageSquare className="h-3.5 w-3.5 text-navy-400" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-navy-400">
          Conversations
        </span>
        <span className="ml-auto text-[10px] text-navy-300">
          {sessions.length}
        </span>
      </div>
      {sessions.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-navy-400">
          No conversations yet. Ask something to get started.
        </div>
      ) : (
        <ul className="max-h-[60vh] overflow-y-auto">
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className={`group flex w-full items-start gap-2 border-b border-navy-50 px-3 py-2.5 text-left transition last:border-b-0 ${
                    isActive ? 'bg-gold-50' : 'hover:bg-navy-50/50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-xs font-semibold ${
                        isActive ? 'text-navy' : 'text-navy'
                      }`}
                    >
                      {s.title || 'New conversation'}
                    </div>
                    <div className="mt-0.5 text-[10px] text-navy-400">
                      {formatRelative(s.updatedAt)} · {s.messageCount} msg
                    </div>
                  </div>
                  <span
                    onClick={(e) => onDelete(s.id, e)}
                    role="button"
                    tabIndex={0}
                    aria-label="Delete conversation"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') onDelete(s.id, e);
                    }}
                    className="flex-shrink-0 rounded p-1 text-navy-300 opacity-0 transition hover:bg-red-50 hover:text-red-700 focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
          {isUser ? 'You' : 'Assistant'} · {formatTime(message.createdAt)}
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
      <style>{`
        @keyframes aiBounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-8px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
