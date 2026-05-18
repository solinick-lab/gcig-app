import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractItem1Business } from './secBusinessSummary.js';

// The brittle part of pulling a company description out of a 10-K is the
// HTML itself: the phrase "Item 1. Business" appears first in the table of
// contents (as a page link) and only later as the real section header, the
// section ends at either "Item 1A." or "Item 2." depending on the filer's
// vintage, and the markup is a soup of entities and nested tags. These
// tests pin that behaviour with the shapes real EDGAR filings take.

test('extracts the body section, not the table-of-contents link', () => {
  const html = `
    <html><body>
      <table>
        <tr><td><a href="#i1">Item 1. Business</a></td><td>3</td></tr>
        <tr><td><a href="#i1a">Item 1A. Risk Factors</a></td><td>12</td></tr>
      </table>
      <p><a name="i1"></a></p>
      <h2>Item 1. Business</h2>
      <p>Acme Corp designs and sells widgets to industrial customers worldwide.</p>
      <p>The Company was founded in 1985.</p>
      <h2>Item 1A. Risk Factors</h2>
      <p>Our business is subject to numerous risks and uncertainties.</p>
    </body></html>`;

  const out = extractItem1Business(html);

  assert.ok(out.includes('Acme Corp designs and sells widgets'));
  assert.ok(out.includes('founded in 1985'));
  // Must stop at Item 1A — risk-factor prose must not bleed in.
  assert.ok(!out.includes('subject to numerous risks'));
  // Must not be the TOC row (header + page number jammed together).
  assert.ok(!/Business\s*3\s*Item 1A/.test(out));
});

test('falls back to ending at Item 2 when there is no Item 1A', () => {
  const html = `
    <body>
      <h3>Item 1. Business</h3>
      <p>Beta Inc operates a chain of retail stores in the Midwest.</p>
      <h3>Item 2. Properties</h3>
      <p>We lease our corporate headquarters in Ohio.</p>
    </body>`;

  const out = extractItem1Business(html);

  assert.ok(out.includes('Beta Inc operates a chain of retail stores'));
  assert.ok(!out.includes('lease our corporate headquarters'));
});

test('tolerates &nbsp;, extra whitespace and mixed case in headers', () => {
  const html = `
    <body>
      <p>ITEM&nbsp;1.&nbsp;&nbsp;BUSINESS</p>
      <p>Gamma LLC provides logistics software to carriers.</p>
      <p>Item&nbsp;1A.&nbsp;Risk&nbsp;Factors</p>
      <p>Risks include competition.</p>
    </body>`;

  const out = extractItem1Business(html);

  assert.ok(out.includes('Gamma LLC provides logistics software'));
  assert.ok(!out.includes('Risks include competition'));
});

test('returns null when there is no Item 1 Business section', () => {
  const html = '<body><h2>Item 2. Properties</h2><p>We own a building.</p></body>';
  assert.equal(extractItem1Business(html), null);
});

test('an inline "See Item 1A" cross-reference does not end the section', () => {
  // Amazon's 10-K opens Item 1 with a forward-looking-statements
  // paragraph that says: See Item 1A of Part I — "Risk Factors." The
  // real Risk Factors header comes much later. Ending at the bare
  // cross-reference truncated the whole description to boilerplate.
  const html = `
    <body>
      <h2>Item 1. Business</h2>
      <p>This report contains forward-looking statements. Actual results
         may differ. See Item 1A of Part I — "Risk Factors."</p>
      <p>We design, build and operate a global store and a cloud platform.</p>
      <h2>Item 1A. Risk Factors</h2>
      <p>Please carefully consider these significant risks.</p>
    </body>`;

  const out = extractItem1Business(html);

  assert.ok(out.includes('We design, build and operate a global store'));
  assert.ok(!out.includes('Please carefully consider these significant risks'));
  assert.ok(out.length > 100, `expected real body, got ${out.length} chars`);
});

test('picks the longest section, not a later "Item 1. Business" cross-ref', () => {
  const html = `
    <body>
      <table>
        <tr><td>Item 1. Business</td><td>1</td></tr>
        <tr><td>Item 1A. Risk Factors</td><td>5</td></tr>
      </table>
      <h2>Item 1. Business</h2>
      <p>Helio Inc manufactures solar inverters for utility customers.</p>
      <h2>Item 1A. Risk Factors</h2>
      <p>Commodity prices. As discussed in Item 1. Business above, demand varies.</p>
    </body>`;

  const out = extractItem1Business(html);

  assert.ok(out.includes('Helio Inc manufactures solar inverters'));
  assert.ok(!out.includes('Commodity prices'));
});

test('a mid-sentence "Item 1. Business" cross-ref never wins on length', () => {
  // Coca-Cola's Risk Factors repeatedly say: ...set forth in Part I,
  // "Item 1. Business" of this report. The span from such a cross-ref to
  // the *next* Item 1A header runs longer than the real Business section,
  // so "longest wins" alone picked the cross-ref and the description
  // started mid-sentence on a quote. A real header stands on its own line.
  const filler = 'risk detail '.repeat(60);
  const html = `
    <body>
      <table>
        <tr><td>Item 1. Business</td><td>2</td></tr>
        <tr><td>Item 1A. Risk Factors</td><td>9</td></tr>
      </table>
      <h2>Item 1. Business</h2>
      <p>Vertex Foods produces packaged snacks sold across North America.</p>
      <h2>Item 1A. Risk Factors</h2>
      <p>Competition risk: refer to "Item 1. Business" of this report. ${filler}</p>
      <p>Item 1A. Risk Factors (continued)</p>
      <p>${filler}</p>
    </body>`;

  const out = extractItem1Business(html);

  assert.ok(out.includes('Vertex Foods produces packaged snacks'));
  assert.ok(!out.includes('refer to'));
  assert.ok(!out.includes('risk detail'));
  assert.ok(!out.startsWith('"'), `started mid-sentence: ${out.slice(0, 40)}`);
});

test('strips tags and collapses whitespace into readable prose', () => {
  const html = `
    <body>
      <h2>Item 1. Business</h2>
      <div><b>Delta</b>   makes\n\n <i>things</i> for&nbsp;people.</div>
      <h2>Item 1A. Risk Factors</h2>
    </body>`;

  const out = extractItem1Business(html);

  assert.equal(out, 'Delta makes things for people.');
  assert.ok(!out.includes('<'));
});
