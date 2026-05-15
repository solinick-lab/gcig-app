import { useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';

// BI — free-form research chat with workspace context.
// Workspace context is passed in via the `workspaceContext` prop (e.g. current
// focused ticker, what panels are open). Chat history lives in-component for
// v0 — persistence to DB lands later alongside saved layouts.

export default function BloombergIntelligence({ ticker, workspaceContext }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const userMsg = { role: 'user', content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setSending(true);
    try {
      const { data } = await api.post('/terminal/chat', {
        messages: next,
        context: workspaceContext || (ticker ? `Focused ticker: ${ticker}` : ''),
      });
      setMessages((m) => [...m, { role: 'assistant', content: data.reply || '(no reply)' }]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: `Error: ${e.response?.data?.error || e.message || 'failed'}`,
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="term-chat">
      <div className="term-chat-log" ref={logRef}>
        {messages.length === 0 ? (
          <div style={{ color: 'var(--term-fg-dim)' }}>
            <div style={{ marginBottom: 6 }}>◢ BLOOMBERG INTELLIGENCE</div>
            Ask anything about the focused ticker or the broader market.
            {ticker ? ` Currently watching ${ticker}.` : ''}
            <br />
            <span style={{ fontSize: 11 }}>
              Examples: "Why is {ticker || 'NVDA'} up today?" · "Compare {ticker || 'AAPL'} margins to peers"
              · "What's the bear case?"
            </span>
          </div>
        ) : (
          messages.map((m, i) => (
            <div className={`term-chat-msg ${m.role}`} key={i}>
              <div className="role">{m.role === 'user' ? '> YOU' : '◢ AI'}</div>
              <div className="body">{m.content}</div>
            </div>
          ))
        )}
        {sending ? (
          <div className="term-chat-msg assistant">
            <div className="role">◢ AI</div>
            <div className="body" style={{ color: 'var(--term-fg-dim)', fontStyle: 'italic' }}>
              Thinking…
            </div>
          </div>
        ) : null}
      </div>

      <div className="term-chat-input-row">
        <textarea
          className="term-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask the terminal…"
          disabled={sending}
        />
        <button className="term-chat-send" onClick={send} disabled={sending || !input.trim()}>
          SEND
        </button>
      </div>
    </div>
  );
}
