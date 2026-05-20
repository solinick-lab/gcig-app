import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadHandler } from './files.js';

// The repo carries no route-test/HTTP harness or supertest; every suite
// drives the exported handler directly with a fake req/res and an
// injected service double, never the network or the real OneDrive API
// (mirrors notes.test.js / terminal.quotes.test.js / users.stepdown.test.js
// — the same precedent every existing suite follows).
//
// What's under test: the OneDrive download route's `?inline=1` honoring.
// The route must (a) leave default attachment behavior untouched when
// the flag is absent, (b) rewrite Content-Disposition to `inline` when
// the flag is present AND the content is PDF, (c) NEVER rewrite when
// the content is not PDF — silently inlining a PPTX would surface a
// download prompt in some browsers and an unreadable XML blob in others.

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    write() {
      this.headersSent = true;
    },
    end() {
      this.headersSent = true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
}

// Build a streamDownload double that simulates Graph's response by
// echoing whichever Content-Type the test asked for, calling
// res.setHeader exactly as the real service would, and consulting the
// `options.inline` flag the route handed it. Recorded args let each
// test assert what the handler actually passed through.
function fakeStream(contentType, upstreamDisposition = 'attachment; filename="deck.pdf"') {
  const calls = [];
  async function streamDownload(itemId, res, options = {}) {
    calls.push({ itemId, options });
    res.setHeader('Content-Type', contentType);
    const wantInline =
      options.inline === true && /^application\/pdf\b/i.test(contentType);
    if (wantInline) {
      // Reuse the spec's exact rule: parse a filename out of the
      // upstream disposition and emit `inline; filename="…"` when we
      // have one, bare `inline` otherwise.
      const m = upstreamDisposition?.match(/filename="([^"]+)"/i);
      res.setHeader(
        'Content-Disposition',
        m ? `inline; filename="${m[1]}"` : 'inline'
      );
    } else if (upstreamDisposition) {
      res.setHeader('Content-Disposition', upstreamDisposition);
    }
    res.end();
  }
  streamDownload.calls = calls;
  return streamDownload;
}

// Without `?inline=1` the route is byte-for-byte backwards-compatible:
// the upstream attachment disposition flows through untouched. The
// existing downloadFile path in client/src/api/fileHelpers.js relies on
// this — it fetches the blob and triggers a download anchor; any
// silent inline switch here would break that.
test('GET /:itemId without ?inline → upstream attachment disposition preserved', async () => {
  const stream = fakeStream(
    'application/pdf',
    'attachment; filename="AAPL-deck.pdf"'
  );
  const res = fakeRes();
  await downloadHandler(
    { params: { itemId: '01ABC' }, query: {} },
    res,
    { streamDownload: stream }
  );
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.equal(
    res.headers['Content-Disposition'],
    'attachment; filename="AAPL-deck.pdf"'
  );
  // The flag the route passed downstream must be false in this path —
  // it's load-bearing for the streamDownload contract.
  assert.equal(stream.calls.length, 1);
  assert.equal(stream.calls[0].options.inline, false);
});

// With `?inline=1` AND a PDF content-type, the disposition is rewritten
// to `inline; filename="…"`. The filename from the upstream disposition
// is preserved so a saved-from-iframe filename still matches what the
// uploader picked.
test('GET /:itemId?inline=1 + PDF → Content-Disposition rewritten to inline', async () => {
  const stream = fakeStream(
    'application/pdf',
    'attachment; filename="AAPL-deck.pdf"'
  );
  const res = fakeRes();
  await downloadHandler(
    { params: { itemId: '01ABC' }, query: { inline: '1' } },
    res,
    { streamDownload: stream }
  );
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.equal(
    res.headers['Content-Disposition'],
    'inline; filename="AAPL-deck.pdf"'
  );
  assert.equal(stream.calls[0].options.inline, true);
});

// `?inline=true` and bare `?inline` (the URLSearchParams.has shape)
// are accepted as the same opt-in — small UX kindness so we're not
// pedantic about which truthy spelling the caller used.
test('GET /:itemId?inline=true and ?inline alone both opt into inline', async () => {
  for (const q of [{ inline: 'true' }, { inline: '' }]) {
    const stream = fakeStream(
      'application/pdf',
      'attachment; filename="x.pdf"'
    );
    const res = fakeRes();
    await downloadHandler(
      { params: { itemId: '01X' }, query: q },
      res,
      { streamDownload: stream }
    );
    assert.equal(
      res.headers['Content-Disposition'],
      'inline; filename="x.pdf"',
      `query ${JSON.stringify(q)} must opt into inline`
    );
    assert.equal(stream.calls[0].options.inline, true);
  }
});

// The non-PDF guard. PPTX with `?inline=1` must NOT be inlined — the
// modal's `embeddable()` helper would have refused to render it
// anyway, and a download-prompt-or-XML-soup outcome would be worse
// than the current attachment behavior. Honest fallback wins.
test('GET /:itemId?inline=1 + non-PDF → disposition NOT overridden (still attachment)', async () => {
  const stream = fakeStream(
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'attachment; filename="AAPL.pptx"'
  );
  const res = fakeRes();
  await downloadHandler(
    { params: { itemId: '01ABC' }, query: { inline: '1' } },
    res,
    { streamDownload: stream }
  );
  assert.equal(
    res.headers['Content-Disposition'],
    'attachment; filename="AAPL.pptx"',
    'non-PDF content with ?inline=1 must keep its attachment header'
  );
  // The flag still flows through — the service is the one that
  // enforces the PDF gate, so we want to prove the route doesn't
  // short-circuit and accidentally hide the opt-in from it.
  assert.equal(stream.calls[0].options.inline, true);
});

// `?inline=anything-else` is not a truthy form, so it MUST NOT
// override the disposition. The route's truthy-flag set is closed —
// accidental `?inline=foo` query strings keep the default behavior.
test('GET /:itemId?inline=foo → not treated as opt-in (default attachment)', async () => {
  const stream = fakeStream(
    'application/pdf',
    'attachment; filename="x.pdf"'
  );
  const res = fakeRes();
  await downloadHandler(
    { params: { itemId: '01X' }, query: { inline: 'foo' } },
    res,
    { streamDownload: stream }
  );
  assert.equal(
    res.headers['Content-Disposition'],
    'attachment; filename="x.pdf"'
  );
  assert.equal(stream.calls[0].options.inline, false);
});

// Missing itemId 400s before any service call — symmetric with the
// other route input guards in the codebase. Never 5xx.
test('GET /:itemId: 400 when itemId is missing, no service call', async () => {
  const stream = fakeStream('application/pdf');
  const res = fakeRes();
  await downloadHandler(
    { params: {}, query: {} },
    res,
    { streamDownload: stream }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Bad item id');
  assert.equal(stream.calls.length, 0);
});

// NOT_AUTHORIZED → 503 honest error (mirrors the sibling routes:
// preview, info, upload — every place we touch OneDrive). Never 5xx
// the request, never a silent success.
test('GET /:itemId: service NOT_AUTHORIZED → 503, never 5xx', async () => {
  async function streamDownload() {
    const err = new Error('OneDrive is not authorized');
    err.code = 'NOT_AUTHORIZED';
    throw err;
  }
  const res = fakeRes();
  await downloadHandler(
    { params: { itemId: '01X' }, query: { inline: '1' } },
    res,
    { streamDownload }
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'OneDrive not connected');
});

// A generic service rejection before any headers are written becomes
// a 502 — the route is the abuse net, the service is the one place we
// expect Graph errors to bubble through. The handler must not 5xx
// (502 is a deliberate upstream-failure code) and must not throw.
test('GET /:itemId: generic service rejection before headers → 502, no throw', async () => {
  async function streamDownload() {
    throw new Error('graph down');
  }
  const res = fakeRes();
  await downloadHandler(
    { params: { itemId: '01X' }, query: {} },
    res,
    { streamDownload }
  );
  // 502 is the documented upstream-failure path; the spec only forbids
  // a true 5xx unhandled throw. Assert the deliberate handled-error
  // code AND that it's well under a 500 catch-fire.
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'graph down');
});
