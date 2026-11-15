// Hand-built Markdown -> HTML, byte-identical to marked 18.1.3 with
// its stock settings (GFM on, breaks off, pedantic off, sync).
//
// Where marked and the CommonMark/GFM specs disagree, marked is the
// authority: the point of this file is to match marked, not the spec.
//
// Pipeline:
//   1. `lex` cuts the document into block tokens, line by line, in the
//      same order marked tries its block rules.
//   2. Once every link definition is known, each paragraph / heading /
//      table cell is scanned once (`scanInline`) into a flat node list.
//      Emphasis delimiters stay unresolved until `resolveDelims` walks
//      them opener-first and turns them into em / strong / del.
//   3. `renderBlocks` walks the token tree and emits HTML.
//
// Speed comes from cheap guards, not cleverness: plain paragraphs skip
// the scanner entirely, the hot text loop is a single index scan, and
// nothing is allocated per case that can be reused per parse.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Punctuation a backslash can escape (the CommonMark escapable set).
const ESCAPES = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

// Element names that may open a CommonMark type-6 HTML block.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// ---------- tiny character predicates ----------

function hexDigit(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
function wordChar(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
function digitChar(c) { return c >= 48 && c <= 57; }
function alphaChar(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function spTab(c) { return c === 32 || c === 9; }

// A whole line of nothing but spaces and tabs.
function blankLine(line) {
  for (let i = 0; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

// ---------- escaping, entities, hrefs, labels ----------

// Escape < > " ' and, when `amp` is set, &. With `amp` off, an ampersand
// that starts something shaped like an entity (&name; / &#12; / &#x1f;)
// is left alone.
const ESC_AMP = /[<>"'&]/g;
const ESC_NO_AMP = /[<>"']|&(?!(?:#x[0-9a-fA-F]{1,6};|#\d{1,7};|\w+;))/g;
function esc(s, amp) {
  return s.replace(amp ? ESC_AMP : ESC_NO_AMP, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : '&amp;');
}

// Decode numeric references (&#123; and &#x1F;) only. Named entities are
// deliberately untouched — marked leaves them alone too.
function decodeNums(s) {
  if (s.indexOf('&#') === -1) return s;
  let out = '', start = 0, i = 0;
  for (;;) {
    i = s.indexOf('&#', i);
    if (i === -1) break;
    let j = i + 2, val = -1;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const st = j;
      while (j < s.length && hexDigit(s.charCodeAt(j))) j++;
      if (j > st && j <= st + 6 && s[j] === ';') val = parseInt(s.slice(st, j), 16);
    } else {
      const st = j;
      while (j < s.length && digitChar(s.charCodeAt(j))) j++;
      if (j > st && j <= st + 7 && s[j] === ';') val = parseInt(s.slice(st, j), 10);
    }
    if (val === -1) { i += 2; continue; }
    const ch = (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) ? '\uFFFD'
      : val === 38 ? '&amp;' : String.fromCodePoint(val);
    out += s.slice(start, i) + ch;
    i = j + 1; start = i;
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked's href clean-up: encodeURI, then un-escape %25 back to %.
function cleanHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// Fold a link label for lookup: trim, squeeze whitespace runs to one
// space, then case-fold the way marked does (lower, upper, lower).
function foldLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// ---------- line utilities ----------

// Index of the '\n' that ends the line starting at i, or the string end.
function lineEnd(s, i) {
  const n = s.indexOf('\n', i);
  return n === -1 ? s.length : n;
}

// Is the line starting at i blank (spaces/tabs only)?
function blankAt(s, i) {
  const e = lineEnd(s, i);
  for (let j = i; j < e; j++) if (s[j] !== ' ' && s[j] !== '\t') return false;
  return true;
}

// Expand tabs to spaces starting from column `col`.
function expandTabs(s, col) {
  if (s.indexOf('\t') === -1) return s;
  let out = '', c = col;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\t') { const r = 4 - (c % 4); out += '    '.slice(0, r); c += r; }
    else { out += s[i]; c++; }
  }
  return out;
}

// Drop trailing blank lines the way marked does: when at most two lines
// follow the last non-blank line the text is kept as-is, otherwise the
// blank tail is cut.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && blankLine(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// Cut a trailing run of one character off a string.
function stripRun(s, ch) {
  let n = s.length;
  while (n > 0 && s[n - 1] === ch) n--;
  return s.slice(0, n);
}

// Split a table row on unescaped pipes. A pipe counts as a separator
// only when preceded by an even number of backslashes.
function splitCells(s, ncols) {
  let t = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '|') {
      let b = 0, p = i - 1;
      while (p >= 0 && s[p] === '\\') { b++; p--; }
      t += (b % 2 === 0) ? ' |' : '|';
    } else t += s[i];
  }
  const cells = t.split(' |');
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (ncols !== undefined) {
    if (cells.length > ncols) cells.length = ncols;
    else while (cells.length < ncols) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Walk a string counting paren depth: index of the first unmatched ')',
// -2 when a '(' is left open, -1 when balanced (or paren-free).
// A backslash hides the character after it.
function parenScan(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// ---------- per-parse state ----------

function newState() {
  return {
    defs: Object.create(null), // folded label -> {href, title}
    jobs: [],                  // paragraph/text tokens awaiting inline parsing
    inA: false,                // inside a raw <a ...> (lives across paragraphs)
    inRaw: false,              // inside <pre>/<code>/<kbd>/<script> (reset per job)
    parenOk: true,
    top: true,                 // top level (false while lexing a list item)
  };
}

// ============================ BLOCK LEXER ============================

// --- predicates: does a line start a block construct? ---

// Thematic break: at most 3 spaces, then 3+ of one of -, _ or *,
// with spaces/tabs between them.
function hrLine(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const ch = s[p];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0;
  while (p < s.length) {
    const c = s[p];
    if (c === ch) { count++; p++; }
    else if (c === ' ' || c === '\t') p++;
    else if (c === '\n') break;
    else return false;
  }
  return count >= 3;
}

// ATX heading: at most 3 spaces, 1-6 #, then space, tab or end of line.
function atxLine(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  let n = 0;
  while (s[p] === '#') { p++; n++; }
  if (n === 0 || n > 6) return false;
  const c = s[p];
  return c === undefined || c === '\n' || c === ' ' || c === '\t';
}

// Fenced code opening: at most 3 spaces, 3+ backticks or tildes. A
// backtick fence whose info string contains a backtick is not a fence.
// Returns the fence length, or 0.
function fenceAt(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const ch = s[p];
  if (ch !== '`' && ch !== '~') return 0;
  let n = 0;
  while (s[p] === ch) { p++; n++; }
  if (n < 3) return 0;
  if (ch === '`') {
    const le = lineEnd(s, p);
    if (s.slice(p, le).indexOf('`') !== -1) return 0;
  }
  return n;
}

// Blockquote opening: at most 3 spaces then '>'.
function quoteLine(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  return s[p] === '>';
}

// List item opening: at most 3 spaces, a bullet (* + -) or 1-9 digits
// plus '.' or ')', followed by space, tab, newline or end. Returns the
// marker length including leading spaces, or 0.
function bulletAt(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const c = s[p];
  if (c === '*' || c === '+' || c === '-') {
    const n = s[p + 1];
    if (n === ' ' || n === '\t' || n === '\n' || n === undefined) return p + 1 - i;
    return 0;
  }
  if (c >= '1' && c <= '9') {
    let q = p;
    while (q < s.length && s[q] >= '0' && s[q] <= '9') q++;
    if (q - p > 9) return 0;
    if (s[q] === '.' || s[q] === ')') {
      const n = s[q + 1];
      if (n === ' ' || n === '\t' || n === '\n' || n === undefined) return q + 1 - i;
    }
  }
  return 0;
}

// Indented-code line: 4 spaces, or up to 3 spaces plus a tab, then content.
function codeLine(s, i) {
  let p = i, sp = 0;
  while (sp < 4 && s[p] === ' ') { p++; sp++; }
  if (sp === 4) return s[p] !== '\n' && s[p] !== undefined;
  if (s[p] === '\t') return s[p + 1] !== '\n' && s[p + 1] !== undefined;
  return false;
}

// Setext underline: at most 3 spaces, a run of = or -, then spaces/tabs.
// Returns 1 for '=', 2 for '-', 0 otherwise.
function setextAt(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const ch = s[p];
  if (ch !== '=' && ch !== '-') return 0;
  while (s[p] === ch) p++;
  while (s[p] === ' ' || s[p] === '\t') p++;
  if (s[p] !== '\n' && s[p] !== undefined) return 0;
  return ch === '=' ? 1 : 2;
}

// Can the line at i interrupt a paragraph? Rules, ATX headings, fences,
// blockquotes, lists, HTML blocks and blank lines can. (Setext
// underlines and table delimiter lines do not — the setext/table
// readers run first.)
function interruptsPara(s, i, clamp) {
  if (blankAt(s, i)) return true;
  if (hrLine(s, i)) return true;
  if (atxLine(s, i)) return true;
  if (fenceAt(s, i)) return true;
  if (quoteLine(s, i)) return true;
  if (bulletAt(s, i)) return true;
  if (htmlAt(s, i, clamp, 'block')) return true;
  return false;
}

// ---------- block readers ----------
// Each takes the remaining source `s` (and state) and returns a token or
// null. Token fields: type, raw, plus type-specific fields. Paragraph,
// text and heading tokens carry `text` (inline source); their inline
// parsing is queued and runs later.

function takeBlank(s) {
  let i = 0;
  while (i < s.length) {
    if (!blankAt(s, i)) break;
    const e = lineEnd(s, i);
    i = e < s.length ? e + 1 : e;
  }
  return i > 0 ? { type: 'blank', raw: s.slice(0, i) } : null;
}

function takeIndentCode(s) {
  let i = 0, end = 0;
  while (i < s.length) {
    if (!codeLine(s, i)) break;
    const e = lineEnd(s, i);
    end = e;
    i = e < s.length ? e + 1 : e;
    // Blank lines after a code line belong to the block.
    while (i < s.length && blankAt(s, i)) {
      const be = lineEnd(s, i);
      end = be;
      i = be < s.length ? be + 1 : be;
    }
  }
  if (end === 0) return null;
  let rawEnd = end;
  if (rawEnd < s.length && s[rawEnd] === '\n') rawEnd++;
  const matched = s.slice(0, rawEnd);
  const raw = trimBlankTail(matched);
  // Strip 1-4 leading spaces (or up to 3 spaces plus a tab) per line.
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { type: 'code', raw, text, lang: null };
}

function takeFence(s) {
  let p = 0, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const ch = s[p];
  if (ch !== '`' && ch !== '~') return null;
  let q = p;
  while (s[q] === ch) q++;
  const fenceLen = q - p;
  if (fenceLen < 3) return null;
  const le = lineEnd(s, q);
  const info = s.slice(q, le);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  const cstart = le < s.length ? le + 1 : s.length;
  // Look for the closing fence.
  let k = cstart, contentEnd = s.length, closeEnd = s.length, found = false;
  while (k < s.length) {
    const kle = lineEnd(s, k);
    const line = s.slice(k, kle);
    let r = 0;
    while (r < 3 && line[r] === ' ') r++;
    let m = r;
    while (line[m] === ch) m++;
    if (m - r >= fenceLen) {
      let ok = true;
      for (let t = m; t < line.length; t++) if (line[t] !== ' ') { ok = false; break; }
      if (ok) {
        contentEnd = k > cstart ? k - 1 : cstart;
        closeEnd = kle;
        found = true;
        break;
      }
    }
    k = kle < s.length ? kle + 1 : s.length;
  }
  let content;
  if (found) {
    content = s.slice(cstart, contentEnd);
  } else {
    content = s.slice(cstart);
    if (content.endsWith('\n')) content = content.slice(0, -1);
  }
  // Indent compensation: only backtick fences whose opening line is indented.
  if (ch === '`' && sp > 0) {
    content = content.split('\n').map((line) => {
      let n = 0;
      while (n < line.length && n < sp && (line[n] === ' ' || line[n] === '\t')) n++;
      return line.slice(n);
    }).join('\n');
  }
  const lang = info.trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
  const raw = found ? s.slice(0, closeEnd) : s;
  return { type: 'code', raw, text: content, lang: lang || null };
}

function takeAtx(s) {
  let p = 0, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  let n = 0;
  while (s[p] === '#') { p++; n++; }
  if (n === 0 || n > 6) return null;
  const c = s[p];
  if (c !== undefined && c !== '\n' && c !== ' ' && c !== '\t') return null;
  const le = lineEnd(s, p);
  let text = s.slice(p, le).trim();
  if (text.endsWith('#')) {
    const stripped = stripRun(text, '#');
    if (stripped === '' || stripped.endsWith(' ') || stripped.endsWith('\t')) text = stripped.trim();
  }
  const raw = stripRun(s.slice(0, le), '\n');
  return { type: 'head', raw, depth: n, text };
}

function takeHr(s) {
  let p = 0, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const ch = s[p];
  if (ch !== '-' && ch !== '_' && ch !== '*') return null;
  let count = 0, q = p;
  while (q < s.length) {
    const c = s[q];
    if (c === ch) { count++; q++; }
    else if (c === ' ' || c === '\t') q++;
    else if (c === '\n') break;
    else return null;
  }
  if (count < 3) return null;
  const raw = s.slice(0, q);
  return { type: 'hr', raw };
}

// ---------- HTML tag helpers ----------

function htmlSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'; }
function alnumCode(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }

// Parse `<name attr...>` or `<name attr.../>` starting at s[i] === '<'.
// `block` selects the type-7 attribute rules (spaces only, no newline in
// quoted values); otherwise the inline rules. Returns the end index or -1.
function openTagEnd(s, i, block) {
  let j = i + 1;
  if (!alphaChar(s.charCodeAt(j))) return -1;
  j++;
  while (j < s.length && (alnumCode(s.charCodeAt(j)) || s[j] === '-')) j++;
  for (;;) {
    let k = j;
    if (block) { while (s[k] === ' ') k++; }
    else { while (k < s.length && htmlSpace(s[k])) k++; }
    if (k === j) {
      if (s[j] === '/') return s[j + 1] === '>' ? j + 2 : -1;
      if (s[j] === '>') return j + 1;
      return -1;
    }
    const nc = s.charCodeAt(k);
    if (!alphaChar(nc) && s[k] !== '_' && s[k] !== ':') {
      if (s[k] === '/') return s[k + 1] === '>' ? k + 2 : -1;
      if (s[k] === '>') return k + 1;
      return -1;
    }
    let n = k + 1;
    while (n < s.length && (wordChar(s.charCodeAt(n)) || s[n] === '.' || s[n] === ':' || s[n] === '-')) n++;
    // Look for '=' past optional whitespace, but only consume that
    // whitespace when an '=' follows: a bare attribute name is followed
    // by the whitespace that separates it from the next attribute.
    let v = n;
    if (block) { while (s[v] === ' ') v++; }
    else { while (v < s.length && htmlSpace(s[v])) v++; }
    if (s[v] !== '=') { j = n; continue; }
    v++;
    if (block) { while (s[v] === ' ') v++; }
    else { while (v < s.length && htmlSpace(s[v])) v++; }
    const q = s[v];
    if (q === '"' || q === "'") {
      const e = s.indexOf(q, v + 1);
      if (e === -1) return -1;
      if (block && s.slice(v + 1, e).indexOf('\n') !== -1) return -1;
      v = e + 1;
    } else {
      let w = v;
      while (w < s.length && !htmlSpace(s[w]) && s[w] !== '"' && s[w] !== "'" && s[w] !== '=' && s[w] !== '<' && s[w] !== '>' && s[w] !== '`') w++;
      if (w === v) return -1;
      v = w;
    }
    j = v;
  }
}

// Parse `</name>` (optional whitespace before `>`) starting at s[i] === '<'.
function closeTagEnd(s, i) {
  let j = i + 2;
  if (!alphaChar(s.charCodeAt(j))) return -1;
  j++;
  while (j < s.length && (alnumCode(s.charCodeAt(j)) || s[j] === '-')) j++;
  while (j < s.length && htmlSpace(s[j])) j++;
  return s[j] === '>' ? j + 1 : -1;
}

// Parse an inline HTML tag, comment, processing instruction, declaration
// or CDATA section starting at s[i] === '<'. Returns the end index or -1.
function inlineTagEnd(s, i) {
  if (s.startsWith('<!--', i)) {
    if (s[i + 4] === '-') return s[i + 5] === '>' ? i + 6 : i + 5;
    if (s[i + 4] === '>') return i + 5; // <!--> is a complete empty comment
    const c = s.indexOf('-->', i + 4);
    return c === -1 ? s.length : c + 3;
  }
  const c1 = s[i + 1];
  if (c1 === '/') return closeTagEnd(s, i);
  if (c1 === '?') {
    const c = s.indexOf('?>', i + 2);
    return c === -1 ? -1 : c + 2;
  }
  if (c1 === '!') {
    if (s.startsWith('[CDATA[', i + 2)) {
      const c = s.indexOf(']]>', i + 9);
      return c === -1 ? -1 : c + 3;
    }
    let j = i + 2;
    if (!alphaChar(s.charCodeAt(j))) return -1;
    while (alphaChar(s.charCodeAt(j))) j++;
    if (!htmlSpace(s[j])) return -1;
    const gt = s.indexOf('>', j);
    return gt === -1 ? -1 : gt + 1;
  }
  if (alphaChar(s.charCodeAt(i + 1))) return openTagEnd(s, i, false);
  return -1;
}

// Can a line start an HTML block? `mode` is 'block' (the block reader's
// type-6 test), 'para' (paragraph interruption test) or 'line' (the
// single-line test used inside list items). `maxSp` caps leading spaces.
function htmlAt(s, i, maxSp, mode) {
  let p = i, sp = 0;
  while (sp < maxSp && s[p] === ' ') { p++; sp++; }
  if (s[p] !== '<') return false;
  // <script|pre|style|textarea followed by whitespace, > or end of string
  const m = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(s.slice(p, p + 12));
  if (m) return true;
  if (s.startsWith('<!--', p) || s.startsWith('<?', p)) return true;
  if (/^<![A-Za-z]/.test(s.slice(p, p + 3)) || s.startsWith('<![CDATA[', p)) return true;
  const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s.slice(p));
  if (!tm) return false;
  if (!BLOCK_TAGS.has(tm[1].toLowerCase())) return false;
  const after = s[p + tm[0].length];
  if (mode === 'block') return after === ' ' || after === '\t' || after === '\n' || after === undefined || after === '/' || after === '>';
  if (mode === 'para') return after === ' ' || after === '\n' || after === '/' || after === '>';
  return after === ' ' || after === undefined || after === '/' || after === '>';
}

// End of a type 6/7 HTML block: the index where the content plus the
// blank-line terminator ends, or the string length.
function htmlBlockEnd(s) {
  let i = 0;
  while (i < s.length) {
    const le = lineEnd(s, i);
    if (blankAt(s, i)) {
      if (le >= s.length) return s.length;
      let j = le + 1;
      while (j < s.length) {
        const le2 = lineEnd(s, j);
        if (blankAt(s, j) && le2 < s.length) j = le2 + 1;
        else break;
      }
      return j;
    }
    i = le < s.length ? le + 1 : s.length;
  }
  return s.length;
}

// Skip to the end of the line containing `pos`, then past newlines.
function skipPastLine(s, pos) {
  let q = lineEnd(s, pos);
  if (q < s.length) q++;
  while (q < s.length && s[q] === '\n') q++;
  return q;
}

function closeTagSearch(s, from, tag) {
  const lower = s.toLowerCase();
  const needle = '</' + tag.toLowerCase() + '>';
  const idx = lower.indexOf(needle, from);
  return idx === -1 ? -1 : idx + needle.length;
}

function takeHtml(s) {
  let p = 0, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  if (s[p] !== '<') return null;
  const rest = s.slice(p);
  // type 1: <script|pre|style|textarea ... </same>
  let m = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m) {
    const tag = m[1].toLowerCase();
    const closeEnd = closeTagSearch(s, p, tag);
    const end = closeEnd === -1 ? s.length : skipPastLine(s, closeEnd);
    const raw = trimBlankTail(s.slice(0, end));
    return { type: 'html', raw, text: raw };
  }
  // type 2: comment
  if (rest.startsWith('<!--')) {
    let end;
    if (rest[4] === '-') end = p + (rest[5] === '>' ? 6 : 5);
    else if (rest[4] === '>') end = p + 5;
    else {
      const c = s.indexOf('-->', p + 4);
      end = c === -1 ? s.length : c + 3;
    }
    end = skipPastLine(s, end);
    const raw = trimBlankTail(s.slice(0, end));
    return { type: 'html', raw, text: raw };
  }
  // type 3: <? ... ?>
  if (rest.startsWith('<?')) {
    const c = s.indexOf('?>', p + 2);
    const end = c === -1 ? s.length : skipPastLine(s, c + 2);
    const raw = trimBlankTail(s.slice(0, end));
    return { type: 'html', raw, text: raw };
  }
  // type 4: <!A ... >
  if (/^<![A-Za-z]/.test(rest)) {
    const gt = s.indexOf('>', p + 3);
    const end = gt === -1 ? s.length : skipPastLine(s, gt + 1);
    const raw = trimBlankTail(s.slice(0, end));
    return { type: 'html', raw, text: raw };
  }
  // type 5: <![CDATA[ ... ]]>
  if (rest.startsWith('<![CDATA[')) {
    const c = s.indexOf(']]>', p + 9);
    const end = c === -1 ? s.length : skipPastLine(s, c + 3);
    const raw = trimBlankTail(s.slice(0, end));
    return { type: 'html', raw, text: raw };
  }
  // type 6: a block tag (open or close), then anything up to a blank line
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
    const after = rest[m[0].length];
    if (after === ' ' || after === '\t' || after === '\n' || after === undefined || after === '/' || after === '>') {
      const raw = trimBlankTail(s.slice(0, htmlBlockEnd(s)));
      return { type: 'html', raw, text: raw };
    }
  }
  // type 7: a complete tag alone on its line, then up to a blank line
  if (m) {
    const name = m[1].toLowerCase();
    if (name !== 'script' && name !== 'pre' && name !== 'style' && name !== 'textarea') {
      const tagEnd = openTagEnd(s, p, true);
      if (tagEnd !== -1) {
        let q = tagEnd;
        while (s[q] === ' ' || s[q] === '\t') q++;
        if (s[q] === '\n' || s[q] === undefined) {
          const raw = trimBlankTail(s.slice(0, htmlBlockEnd(s)));
          return { type: 'html', raw, text: raw };
        }
      }
    }
  }
  // type 7 close tag: </name> alone on its line
  if (rest.startsWith('</')) {
    const tagEnd = closeTagEnd(s, p);
    if (tagEnd !== -1) {
      let q = tagEnd;
      while (s[q] === ' ' || s[q] === '\t') q++;
      if (s[q] === '\n' || s[q] === undefined) {
        const raw = trimBlankTail(s.slice(0, htmlBlockEnd(s)));
        return { type: 'html', raw, text: raw };
      }
    }
  }
  return null;
}

// Does the line at s[i] start a list item that may interrupt a paragraph?
// Only a non-empty item, and for ordered lists only one starting with 1.
function listBreaksPara(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const c = s[p];
  if (c === '*' || c === '+' || c === '-') {
    const n = s[p + 1];
    if (n !== ' ' && n !== '\t') return false;
    let q = p + 1;
    while (s[q] === ' ' || s[q] === '\t') q++;
    return s[q] !== '\n' && s[q] !== undefined;
  }
  if (c === '1') {
    const d = s[p + 1];
    if (d !== '.' && d !== ')') return false;
    const n = s[p + 2];
    if (n !== ' ' && n !== '\t') return false;
    let q = p + 2;
    while (s[q] === ' ' || s[q] === '\t') q++;
    return s[q] !== '\n' && s[q] !== undefined;
  }
  return false;
}

// End index of a paragraph starting at `start` (first line plus
// continuation lines that are not blank and do not start a block).
function paraEnd(s, start) {
  let i = lineEnd(s, start);
  while (i < s.length) {
    const ns = i + 1;
    if (ns >= s.length) break;
    // A whitespace-only line ends the paragraph only when it is a
    // complete line (followed by a newline); a trailing run of spaces at
    // the very end of the input belongs to the paragraph.
    if (blankAt(s, ns) && lineEnd(s, ns) < s.length) break;
    if (hrLine(s, ns) || atxLine(s, ns) || fenceAt(s, ns) ||
        quoteLine(s, ns) || listBreaksPara(s, ns) || htmlAt(s, ns, 3, 'para')) break;
    i = lineEnd(s, ns);
  }
  return i;
}

function takeQuote(s, st) {
  // Extent: lines starting with `>` plus lazy paragraph continuation lines.
  let pos = 0;
  while (pos < s.length) {
    let p = pos, sp = 0;
    while (sp < 3 && s[p] === ' ') { p++; sp++; }
    if (s[p] !== '>') break;
    let q = p + 1;
    if (s[q] === ' ' || s[q] === '\t') q++;
    const le = lineEnd(s, q);
    let restBlank = true;
    for (let t = q; t < le; t++) if (s[t] !== ' ' && s[t] !== '\t') { restBlank = false; break; }
    const end = restBlank ? le : paraEnd(s, q);
    pos = end < s.length ? end + 1 : end;
  }
  if (pos === 0) return null;
  const rawAll = s.slice(0, pos - (pos > 0 && s[pos - 1] === '\n' ? 1 : 0));
  let lines = rawAll.split('\n');
  let sAcc = '', rAcc = '';
  const tokens = [];
  while (lines.length > 0) {
    const chunk = [];
    let started = false, p = 0;
    for (; p < lines.length; p++) {
      if (/^ {0,3}>/.test(lines[p])) { chunk.push(lines[p]); started = true; }
      else if (!started) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h
      .replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m) => b + expandTabs(m, b.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    sAcc = sAcc ? sAcc + '\n' + h : h;
    rAcc = rAcc ? rAcc + '\n' + u : u;
    const savedTop = st.top;
    st.top = true;
    lex(u, tokens, st, true);
    st.top = savedTop;
    if (lines.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (k && (k.type === 'code' || k.type === 'head' || k.type === 'hr' || k.type === 'html' || k.type === 'table')) break;
    if (k && k.type === 'quote') {
      const g = k;
      const b = lines.join('\n');
      const m = g.raw + '\n' + b.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = takeQuote(m, st);
      tokens[tokens.length - 1] = f;
      const y = m.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) sAcc = sAcc + '\n' + A.join('\n');
      rAcc = rAcc.substring(0, rAcc.length - g.text.length) + f.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && /^ {0,3}>/.test(lines[0])) continue;
      break;
    } else if (k && k.type === 'list') {
      const g = k;
      const b = g.raw + '\n' + lines.join('\n');
      const mm = takeList(b, st);
      tokens[tokens.length - 1] = mm;
      const f = mm.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        sAcc = sAcc + '\n' + y;
        rAcc = rAcc + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: 'quote', raw: sAcc, tokens, text: rAcc };
}

// Match a list item at the start of `s`: `^( {0,3}BULLET)((?:[ \t][^\n]*)?(?:\n|$))`
// `marker` describes the bullet to accept: null for any bullet, {term}
// for an ordered bullet ending in '.' or ')', {ch} for one unordered
// bullet character.
function listItemAt(s, marker) {
  let p = 0, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  let mlen = 0;
  if (marker === null) {
    const c = s[p];
    if (c === '*' || c === '+' || c === '-') mlen = 1;
    else if (c >= '0' && c <= '9') {
      let q = p;
      while (q < s.length && s[q] >= '0' && s[q] <= '9') q++;
      if (q - p <= 9 && (s[q] === '.' || s[q] === ')')) mlen = q + 1 - p;
    }
  } else if (marker.term) {
    const c = s[p];
    if (c >= '0' && c <= '9') {
      let q = p;
      while (q < s.length && s[q] >= '0' && s[q] <= '9') q++;
      if (q - p <= 9 && s[q] === marker.term) mlen = q + 1 - p;
    }
  } else if (s[p] === marker.ch) {
    mlen = 1;
  }
  if (mlen === 0) return null;
  const bulletEnd = p + mlen;
  // The marker must be followed by a space, tab, newline or end of input.
  const after = s[bulletEnd];
  if (after !== ' ' && after !== '\t' && after !== '\n' && after !== undefined) return null;
  // rest: (?:[ \t][^\n]*)?(?:\n|$)
  let q = bulletEnd;
  if (s[q] === ' ' || s[q] === '\t') {
    const le = lineEnd(s, q);
    q = le;
  }
  const totalLen = q < s.length ? q + 1 : q;
  return { bulletLen: bulletEnd, rest: s.slice(bulletEnd, totalLen), totalLen };
}

// A line starts a list item of any kind (used inside table bodies and the
// list loop's break checks). `clamp` limits leading spaces.
function bulletAtPos(s, i, clamp) {
  let p = i, sp = 0;
  while (sp < clamp && s[p] === ' ') { p++; sp++; }
  const c = s[p];
  if (c === '*' || c === '+' || c === '-') {
    const n = s[p + 1];
    return n === ' ' || n === '\t' || n === '\n' || n === undefined;
  }
  if (c >= '0' && c <= '9') {
    let q = p;
    while (q < s.length && s[q] >= '0' && s[q] <= '9') q++;
    if (q - p > 9 || q - p === 0) return false;
    if (s[q] === '.' || s[q] === ')') {
      const n = s[q + 1];
      return n === ' ' || n === '\t' || n === '\n' || n === undefined;
    }
  }
  return false;
}

function firstNonWs(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') return i;
  return -1;
}

// First line of s (up to the first '\n', or the whole string).
function firstLine(s) {
  return s.slice(0, lineEnd(s, 0));
}

// Expand the leading whitespace run of a line to spaces (tabs to the next
// multiple of 4 from `col`); a run without tabs is returned unchanged.
function expandLead(line, col) {
  let r = 0, hasTab = false;
  while (r < line.length && (line[r] === ' ' || line[r] === '\t')) { if (line[r] === '\t') hasTab = true; r++; }
  if (!hasTab) return line;
  return expandTabs(line.slice(0, r), col) + line.slice(r);
}

// Index of the first non-space character with each tab counted as 4
// spaces; -1 when the string is all spaces and tabs.
function firstNonWsTab(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') n++;
    else if (c === '\t') n += 4;
    else return n;
  }
  return -1;
}

// Does s end with a blank line (newline, spaces/tabs, newline, spaces/tabs)?
function endsBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}

// Does `text` (one or two lines joined by \n) form a setext heading?
function setextText(text) {
  const nl = text.indexOf('\n');
  if (nl === -1) return false;
  const first = text.slice(0, nl);
  if (first === '' || bulletAt(first + '\n', 0)) return false;
  const d = setextAt(text, nl + 1);
  return d !== 0;
}

function takeList(s, st) {
  const first = listItemAt(s, null);
  if (!first) return null;
  const bulletText = s.slice(0, first.bulletLen).trim();
  const ordered = bulletText.length > 1;
  const marker = ordered ? { term: bulletText.slice(-1) } : { ch: bulletText };
  const items = [];
  let loose = false, pFlag = false;
  let e = s, consumed = 0;
  while (e.length > 0) {
    const t = listItemAt(e, marker);
    if (!t || hrLine(e, 0)) break;
    const k = consumed;
    e = e.substring(t.totalLen);
    consumed += t.totalLen;
    const g = firstLine(t.rest);
    const b = t.bulletLen;
    const m = expandLead(g, b);
    const f = firstLine(e);
    const y = !m.trim();
    let R, d;
    if (y) { R = b + 1; d = ''; }
    else {
      R = firstNonWs(m);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    let u = false;
    if (y && /^[ \t]*$/.test(f)) { e = e.substring(f.length + 1); consumed += f.length + 1; u = true; }
    if (!u) {
      let mm = m;
      let yy = y;
      while (e.length > 0) {
        const U = firstLine(e);
        const f2 = U;
        const Z = expandLead(f2, 0);
        const cl = Math.max(0, Math.min(3, R - 1));
        if (fenceLine(f2, cl) || atxLineStart(f2, cl) || htmlAt(f2, 0, cl, 'line') ||
            quoteLineStart(f2, cl) || bulletAtPos(f2, 0, cl) || hrLineStart(f2, cl)) break;
        if (firstNonWs(Z) >= R || !f2.trim()) {
          d += '\n' + Z.slice(R);
        } else {
          if (yy || firstNonWsTab(mm) >= 4 ||
              fenceLine(mm, 0) || atxLineStart(mm, 0) || htmlAt(mm, 0, 0, 'line') || hrLineStart(mm, 0)) break;
          let qe = f2;
          if (/^ {0,3}(?:=+|-+) *$/.test(f2) && setextText(mm + '\n' + f2)) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          d += '\n' + qe;
        }
        yy = !f2.trim();
        e = e.substring(U.length + 1);
        consumed += U.length + 1;
        mm = Z.slice(R);
      }
    }
    const A = s.slice(k, consumed);
    if (!loose) {
      if (pFlag) loose = true;
      else if (endsBlank(A)) pFlag = true;
    }
    items.push({ type: 'item', raw: A, task: false, loose: false, text: d, tokens: [] });
  }
  if (items.length === 0) return null;
  const h = items[items.length - 1];
  h.raw = h.raw.trimEnd();
  h.text = h.text.trimEnd();
  const raw = s.slice(0, consumed).trimEnd();
  // Task detection on the item text as accumulated.
  for (const it of items) it.task = /^\[[ xX]\][ \t]+\S/.test(it.text);
  // Block-tokenize each item's text; detect looseness from blank lines.
  for (const it of items) {
    st.top = false;
    it.tokens = lex(it.text, [], st, false);
    if (!loose) {
      const spaces = it.tokens.filter((t) => t.type === 'blank');
      if (spaces.length > 0 && spaces.some((t) => /\n.*\n/.test(t.raw))) loose = true;
    }
  }
  st.top = true;
  // Task list fix-up: strip the marker, insert a checkbox token.
  for (const it of items) {
    const d0 = it.tokens[0];
    if (it.task && (d0 && (d0.type === 'text' || d0.type === 'para'))) {
      const km = /^\[[ xX]\]/.exec(it.text);
      it.text = it.text.replace(/^\[[ xX]\][ \t]+/, '');
      d0.raw = d0.raw.replace(/^\[[ xX]\][ \t]+/, '');
      d0.text = d0.text.replace(/^\[[ xX]\][ \t]+/, '');
      if (km) {
        const g = { type: 'check', raw: km[0] + ' ', checked: km[0] !== '[ ]' };
        it.checked = g.checked;
        if (loose) {
          // The checkbox becomes the first inline element of the paragraph.
          d0.checkbox = g;
        } else {
          it.tokens.unshift(g);
        }
      }
    } else if (it.task) {
      it.task = false;
    }
  }
  if (loose) {
    for (const it of items) {
      it.loose = true;
      for (const tk of it.tokens) if (tk.type === 'text') tk.type = 'para';
    }
  }
  return { type: 'list', raw, ordered, start: ordered ? parseInt(bulletText.slice(0, -1), 10) : '', loose, items };
}

// Line-based variants of the break checks (input is a single line, no \n).
function fenceLine(line, clamp) {
  let p = 0, sp = 0;
  while (sp < clamp && line[p] === ' ') { p++; sp++; }
  const ch = line[p];
  if (ch !== '`' && ch !== '~') return false;
  let n = 0;
  while (line[p] === ch) { p++; n++; }
  if (n < 3) return false;
  if (ch === '`' && line.slice(p).indexOf('`') !== -1) return false;
  return true;
}
function atxLineStart(line, clamp) {
  let p = 0, sp = 0;
  while (sp < clamp && line[p] === ' ') { p++; sp++; }
  let n = 0;
  while (line[p] === '#') { p++; n++; }
  if (n === 0 || n > 6) return false;
  const c = line[p];
  return c === undefined || c === ' ' || c === '\t';
}
function quoteLineStart(line, clamp) {
  let p = 0, sp = 0;
  while (sp < clamp && line[p] === ' ') { p++; sp++; }
  return line[p] === '>';
}
function hrLineStart(line, clamp) {
  let p = 0, sp = 0;
  while (sp < clamp && line[p] === ' ') { p++; sp++; }
  const ch = line[p];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0, q = p;
  while (q < line.length) {
    const c = line[q];
    if (c === ch) { count++; q++; }
    else if (c === ' ' || c === '\t') q++;
    else return false;
  }
  return count >= 3;
}
// Unescape backslash-escaped ASCII punctuation: \X -> X.
function unesc(s) {
  if (s.indexOf('\\') === -1) return s;
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
}

// Parse a link title starting at s[i] ('"' or "'" or '('). Returns
// {title, end} (title without the quotes) or null.
function titleAt(s, i) {
  const q = s[i];
  if (q === '"') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\') { if (j + 1 < s.length) { j += 2; continue; } return null; }
      if (s[j] === '"') return { title: s.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === "'") {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\') { if (j + 1 < s.length) { j += 2; continue; } return null; }
      if (s[j] === "'") return { title: s.slice(i + 1, j), end: j + 1 };
      if (s[j] === '\n') {
        if (s[j + 1] === '\n') return null;
        j++; continue;
      }
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\') { if (j + 1 < s.length) { j += 2; continue; } return null; }
      if (s[j] === ')') return { title: s.slice(i + 1, j), end: j + 1 };
      if (s[j] === '(') return null;
      j++;
    }
    return null;
  }
  return null;
}

function takeDef(s, st) {
  let p = 0, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  if (s[p] !== '[') return null;
  // Label: characters up to the first unescaped ']' (newlines allowed
  // unless followed by a blank line); the label may not be empty or
  // whitespace-only.
  let k = p + 1;
  while (k < s.length) {
    const c = s[k];
    if (c === '\\') { if (k + 1 >= s.length) break; k += 2; continue; }
    if (c === '[' || c === ']') break;
    if (c === '\n') {
      const ns = k + 1;
      if (ns >= s.length || blankAt(s, ns)) break;
      k++; continue;
    }
    k++;
  }
  if (k >= s.length || s[k] !== ']') return null;
  const label = s.slice(p + 1, k);
  if (label.trim() === '') return null;
  let m = k + 1;
  if (s[m] !== ':') return null;
  m++;
  while (s[m] === ' ') m++;
  if (s[m] === '\n') {
    m++;
    while (s[m] === ' ' || s[m] === '\t') m++;
  }
  // Destination: <...> or a run of non-space characters.
  let dest, angled = false;
  if (s[m] === '<') {
    const le = lineEnd(s, m);
    const gt = s.indexOf('>', m);
    if (gt === -1 || gt > le) return null;
    dest = s.slice(m + 1, gt);
    angled = true;
    m = gt + 1;
  } else {
    if (s[m] === ' ' || s[m] === '\t' || s[m] === '\n' || s[m] === undefined) return null;
    let e = m;
    while (e < s.length && s[e] !== ' ' && s[e] !== '\t' && s[e] !== '\n') e++;
    dest = s.slice(m, e);
    m = e;
  }
  if (!angled && parenScan(dest) !== -1) return null;
  // Optional title, on this line or the next.
  let title;
  let t = m;
  let hasTitle = false;
  {
    let q = t;
    let ok = false;
    if (s[q] === ' ') {
      while (s[q] === ' ') q++;
      if (s[q] === '\n') { q++; while (s[q] === ' ' || s[q] === '\t') q++; }
      ok = true;
    } else if (s[q] === '\n') {
      q++;
      while (s[q] === ' ' || s[q] === '\t') q++;
      ok = true;
    }
    if (ok) {
      const tp = titleAt(s, q);
      if (tp) { title = tp.title; t = tp.end; hasTitle = true; }
    }
  }
  // A title followed by junk on its line is dropped; the definition
  // itself still stands.
  let end = m;
  if (hasTitle) {
    let te = t;
    while (s[te] === ' ') te++;
    if (s[te] === '\n' || s[te] === undefined) end = te;
  }
  while (s[end] === ' ') end++;
  if (s[end] !== '\n' && s[end] !== undefined) return null;
  const raw = s.slice(0, end);
  return {
    type: 'def',
    tag: foldLabel(label),
    raw,
    href: unesc(dest),
    title: hasTitle ? unesc(title) : undefined,
  };
}

// A line looks like a table delimiter row: an optional |, then one or more
// groups of (colons/dashes/spaces + |), then colons/dashes/spaces, then EOL.
function delimLine(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  let j = p;
  if (s[j] === '|') j++;
  let groups = 0;
  while (true) {
    let k = j;
    while (s[k] === ':' || s[k] === '-' || s[k] === ' ') k++;
    if (s[k] === '|') { groups++; j = k + 1; } else break;
  }
  if (groups === 0) return false;
  while (s[j] === ':' || s[j] === '-' || s[j] === ' ') j++;
  return s[j] === '\n';
}

// A line starts a bullet character (no space required after it).
function bulletChar(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const c = s[p];
  if (c === '*' || c === '+' || c === '-') return true;
  if (c >= '0' && c <= '9') {
    let q = p;
    while (q < s.length && s[q] >= '0' && s[q] <= '9') q++;
    return q > p && q - p <= 9 && (s[q] === '.' || s[q] === ')');
  }
  return false;
}

// A line looks like `<...>` alone (the `html` alternative in the setext
// lookahead): <, 1+ characters that are not \n or >, then > at end of line.
function htmlLine(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  if (s[p] !== '<') return false;
  let j = p + 1;
  if (j >= s.length || s[j] === '\n' || s[j] === '>') return false;
  while (j < s.length && s[j] !== '\n' && s[j] !== '>') j++;
  return s[j] === '>' && s[j + 1] === '\n';
}

function takeSetext(s, st) {
  // The first line must not start a block construct.
  if (blankAt(s, 0)) return null;
  if (bulletChar(s, 0) || codeLine(s, 0) || fenceAt(s, 0) ||
      quoteLine(s, 0) || atxLine(s, 0) || hrLine(s, 0) ||
      htmlLine(s, 0) || delimLine(s, 0)) return null;
  let lineStart = 0;
  let depth = 0, underlineEnd = -1;
  for (;;) {
    const le = lineEnd(s, lineStart);
    if (lineStart > 0) {
      const d = setextAt(s, lineStart);
      if (d) { depth = d; underlineEnd = le; break; }
      if (blankAt(s, lineStart)) return null;
      if (bulletChar(s, lineStart) || fenceAt(s, lineStart) ||
          quoteLine(s, lineStart) || atxLine(s, lineStart) ||
          hrLine(s, lineStart) || htmlLine(s, lineStart) ||
          delimLine(s, lineStart)) return null;
    }
    if (le >= s.length) return null;
    lineStart = le + 1;
    if (lineStart >= s.length) return null;
  }
  const raw = s.slice(0, underlineEnd);
  const text = raw.slice(0, raw.lastIndexOf('\n')).trim();
  return { type: 'head', raw, depth, text };
}

function takeTable(s, st) {
  let p = 0;
  while (s[p] === ' ') p++;
  if (s[p] === '\n' || s[p] === undefined) return null;
  const hEnd = lineEnd(s, p);
  const headerLine = s.slice(p, hEnd);
  if (hEnd >= s.length) return null;
  let dStart = hEnd + 1, dsp = 0;
  while (dsp < 3 && s[dStart] === ' ') { dStart++; dsp++; }
  const dEnd = lineEnd(s, dStart);
  const delim = s.slice(dStart, dEnd);
  if (!/^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(delim)) return null;
  if (!/[:|]/.test(delim)) return null;
  const headerCells = splitCells(headerLine);
  const delimCells = delim.replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== delimCells.length) return null;
  const align = delimCells.map((c) =>
    /^ *-+: *$/.test(c) ? 'right' : /^ *:-+: *$/.test(c) ? 'center' : /^ *:-+ *$/.test(c) ? 'left' : null);
  const rows = [];
  let rStart = dEnd < s.length ? dEnd + 1 : s.length;
  let lastEnd = dEnd;
  while (rStart < s.length) {
    // A body row ends at a line of only spaces (or empty); a line
    // containing a tab is a row (its cells come out empty).
    let q = rStart;
    while (s[q] === ' ') q++;
    if (s[q] === '\n' || s[q] === undefined) break;
    if (hrLine(s, rStart) || atxLine(s, rStart) || quoteLine(s, rStart) ||
        codeLine(s, rStart) || fenceAt(s, rStart) || htmlAt(s, rStart, 3, 'para')) break;
    // List: only unordered bullets or ordered lists starting with 1.
    if (tableListStop(s, rStart)) break;
    const rEnd = lineEnd(s, rStart);
    rows.push(s.slice(rStart, rEnd));
    lastEnd = rEnd;
    rStart = rEnd < s.length ? rEnd + 1 : s.length;
  }
  const raw = s.slice(0, lastEnd);
  const header = headerCells.map((c, i) => ({ text: c, align: align[i], header: true }));
  const body = rows.map((row) => splitCells(row, header.length).map((c, i) => ({ text: c, align: align[i], header: false })));
  return { type: 'table', raw, header, align, rows: body };
}

// A table body row stops at a line starting an unordered list item or an
// ordered list item numbered 1 (followed by a space or tab).
function tableListStop(s, i) {
  let p = i, sp = 0;
  while (sp < 3 && s[p] === ' ') { p++; sp++; }
  const c = s[p];
  if (c === '*' || c === '+' || c === '-') {
    const n = s[p + 1];
    return n === ' ' || n === '\t';
  }
  if (c === '1' && (s[p + 1] === '.' || s[p + 1] === ')')) {
    const n = s[p + 2];
    return n === ' ' || n === '\t';
  }
  return false;
}

function takePara(s, st) {
  const end = paraEnd(s, 0);
  if (end === 0) return null;
  const raw = s.slice(0, end);
  const tok = { type: 'para', raw, text: raw };
  st.jobs.push(tok);
  return tok;
}

function takeText(s, st) {
  const le = lineEnd(s, 0);
  if (le === 0) return null;
  const raw = s.slice(0, le);
  const tok = { type: 'text', raw, text: raw };
  st.jobs.push(tok);
  return tok;
}

// Main block loop. `cont` means a leading paragraph merges into a
// previous paragraph token (blockquote lazy continuation).
function lex(src, tokens, st, cont) {
  let s = src;
  let guard = Infinity;
  while (s.length > 0) {
    if (s.length >= guard) throw new Error('Infinite loop on byte: ' + s.charCodeAt(0));
    guard = s.length;
    let r;
    if ((r = takeBlank(s))) {
      s = s.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(r);
      continue;
    }
    if ((r = takeIndentCode(s))) {
      s = s.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'para' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
      } else tokens.push(r);
      continue;
    }
    if ((r = takeFence(s))) { s = s.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = takeAtx(s))) { s = s.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = takeHr(s))) { s = s.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = takeQuote(s, st))) { s = s.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = takeList(s, st))) { s = s.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = takeHtml(s))) { s = s.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = takeDef(s, st))) {
      s = s.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'para' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.raw;
      } else {
        if (!Object.hasOwn(st.defs, r.tag)) st.defs[r.tag] = { href: r.href, title: r.title };
        tokens.push(r);
      }
      continue;
    }
    if ((r = takeTable(s, st))) { s = s.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = takeSetext(s, st))) { s = s.substring(r.raw.length); tokens.push(r); continue; }
    if (st.top && (r = takePara(s, st))) {
      const prev = tokens[tokens.length - 1];
      if (cont && prev && prev.type === 'para') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        st.jobs.pop();
      } else tokens.push(r);
      cont = false;
      s = s.substring(r.raw.length);
      continue;
    }
    if ((r = takeText(s, st))) {
      s = s.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
      } else tokens.push(r);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + s.charCodeAt(0));
  }
  st.top = true;
  return tokens;
}

// ============================ INLINE PARSER ============================

const PUNCT_RE = /[\p{P}\p{S}]/u;
const EMAIL_START_RE = /[A-Za-z0-9._+-]+@/y;
function punctCh(c) { return c !== '' && PUNCT_RE.test(c); }
function wsCh(c) {
  if (c === '' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') return true;
  if (!c) return false;
  const code = c.charCodeAt(0);
  return code === 0x00a0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f || code === 0x205f || code === 0x3000;
}
function wordCh(c) { return c !== '' && !wsCh(c) && !punctCh(c); }
function mayOpen(prev, next) {
  return !wsCh(next) && (!punctCh(next) || wsCh(prev) || punctCh(prev));
}
function mayClose(prev, next) {
  return !wsCh(prev) && (!punctCh(prev) || wsCh(next) || punctCh(next));
}

// End of a code span starting at src[i] (a run of `n` backticks): the
// index just past the matching run, or -1.
function codeClose(src, i, n) {
  let j = i + n;
  for (;;) {
    const k = src.indexOf('`', j);
    if (k === -1) return -1;
    let m = k;
    while (src[m] === '`') m++;
    if (m - k === n) return m;
    j = m;
  }
}

// Index of the `]` that closes a link label starting at src[i] (i points
// just past the opening `[`). Handles nesting, code spans and backslash
// escapes. Returns -1 when there is none.
function labelEnd(src, i) {
  let depth = 0, j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      let m = j;
      while (src[m] === '`') m++;
      const L = m - j;
      // Two or more backticks immediately before ']' are literal
      // (marked's ``+(?=]) alternative needs >=2 backticks — a single
      // backtick before ']' is a code-span opener that fails to close,
      // so the label cannot match). Check this FIRST: it is the short
      // match the lazy label regex prefers (doc-33).
      if (L >= 2 && src[m] === ']') { j = m; continue; }
      // Otherwise a code span inside a label closes at the FIRST
      // following backtick run, of any length (its content may not
      // contain backticks). But if a ']' followed by '(' or '[' lies
      // between the opening and closing backticks, the span would
      // swallow the label's close, so the label cannot match (doc-16).
      let n = m;
      while (n < src.length && src[n] !== '`') n++;
      if (n >= src.length) return -1;
      for (let q = m; q < n; q++) {
        if (src[q] === ']' && (src[q + 1] === '(' || src[q + 1] === '[')) return -1;
      }
      let e = n;
      while (src[e] === '`') e++;
      j = e;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return j;
      depth--;
    }
    j++;
  }
  return -1;
}

// Lenient label end: like labelEnd, but a code span that never
// closes does not fail the scan — its backticks are just skipped.
// Used to find the extent of a `[label]` whose label regex failed, so
// emphasis inside it can be suppressed (see scanInline).
function labelEndLoose(src, i) {
  let depth = 0, j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      let m = j;
      while (src[m] === '`') m++;
      // Find the next backtick run and the next ']'. If a ']' comes
      // before the next backtick, the code span does not close before
      // the label ends — treat the backticks as literal so the ']'
      // closes the label here, instead of skipping past it to a far
      // backtick (which would wrongly extend the failed-label
      // suppression past the label, e.g. doc-22's ~~...~~).
      let n = m;
      while (n < src.length && src[n] !== '`') n++;
      let b = m;
      while (b < src.length && src[b] !== ']') b++;
      if (b < src.length && (n >= src.length || b < n)) { j = m; continue; }
      if (n < src.length) {
        let e = n;
        while (src[e] === '`') e++;
        j = e;
      } else {
        j = m;
      }
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return j;
      depth--;
    }
    j++;
  }
  return -1;
}

// Parse the `(...)` part of an inline link, starting just past the `(`.
// Returns {href, title, end} (end is just past the closing `)`) or null.
function linkTarget(src, i) {
  let j = i;
  while (src[j] === ' ' || src[j] === '\t' || src[j] === '\n') j++;
  let href;
  if (src[j] === '<') {
    let k = j + 1, ok = false;
    while (k < src.length) {
      if (src[k] === '\\') { if (src[k + 1] === '\n') break; k += 2; continue; }
      if (src[k] === '\n' || src[k] === '<') break;
      if (src[k] === '>') { ok = true; break; }
      k++;
    }
    if (!ok) return null;
    href = src.slice(j + 1, k);
    j = k + 1;
  } else {
    // Bare destination: a run of non-space characters with balanced
    // parentheses (a `\(` or `\)` does not count as a paren). It ends at
    // the first `)` that would unbalance it (that `)` closes the link),
    // or at whitespace / end of input. An unclosed `(` invalidates it.
    let k = j, depth = 0;
    while (k < src.length) {
      const ch = src[k];
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (ch === '\\' && (src[k + 1] === '(' || src[k + 1] === ')')) { k += 2; continue; }
      if (ch === '(') { depth++; k++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--; k++; continue;
      }
      k++;
    }
    if (depth !== 0) return null;
    href = src.slice(j, k);
    j = k;
  }
  // Optional title, preceded by whitespace (marked allows any run of it).
  let title;
  let t = j;
  {
    let q = t;
    while (src[q] === ' ' || src[q] === '\t' || src[q] === '\n') q++;
    if (q !== t) {
      const tp = titleAt(src, q);
      if (tp) { title = tp.title; t = tp.end; }
    }
  }
  let end = t;
  while (src[end] === ' ' || src[end] === '\t' || src[end] === '\n') end++;
  if (src[end] !== ')') return null;
  return { href, title, end: end + 1 };
}

// Does a link label contain a tag/autolink that starts inside the label
// but ends outside it (which invalidates the link)?
function labelCrossesTag(src, labelStart, label) {
  if (label.indexOf('<') === -1) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const end = codeClose(label, s, (() => { let m = s; while (label[m] === '`') m++; return m - s; })());
      if (end !== -1) { s = end - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(labelStart + s);
    let o = inlineTagEnd(r, 0);
    if (o === -1) { const al = autoLink(r, 0); o = al === -1 ? -1 : al.end; }
    if (o !== -1 && o > label.length - s) return true;
    if (o !== -1) s += o - 1;
  }
  return false;
}

// Match `<scheme:...>` or `<email>` at src[i] === '<'. Returns the end
// index or -1.
function autoLink(src, i) {
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31} : [^\s\x00-\x1f<>]*
  let j = i + 1;
  if (!alphaChar(src.charCodeAt(j))) return -1;
  j++;
  let n = 0;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    if (alnumCode(c) || src[j] === '+' || src[j] === '.' || src[j] === '-') { j++; n++; }
    else break;
  }
  if (n >= 1 && n <= 31 && src[j] === ':') {
    let k = j + 1;
    while (k < src.length) {
      const c = src.charCodeAt(k);
      if (c <= 31 || src[k] === ' ' || src[k] === '<' || src[k] === '>') break;
      k++;
    }
    if (src[k] === '>') return { end: k + 1, text: src.slice(i + 1, k), href: src.slice(i + 1, k), email: false };
  }
  // email: [a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])
  const em = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/.exec(src.slice(i + 1));
  if (em && src[i + 1 + em[0].length] === '>') {
    return { end: i + 1 + em[0].length + 1, text: em[0], href: 'mailto:' + em[0], email: true };
  }
  return -1;
}

// Trim a GFM extended autolink the way marked's _backpedal does: drop
// trailing punctuation and unbalanced closing parens.
function trimTail(u) {
  for (;;) {
    const before = u;
    // Scan the backpedal pattern from the start; take its length.
    let pos = 0;
    const len = u.length;
    while (pos < len) {
      const c = u[pos];
      if (c === '(') {
        const close = u.indexOf(')', pos);
        if (close === -1) break;
        pos = close + 1;
        continue;
      }
      if (c === '&') {
        if (/^&[a-zA-Z0-9]+;$/.test(u.slice(pos))) break;
        pos++;
        continue;
      }
      if ('?!.,:;*_\'"~)'.indexOf(c) !== -1) {
        let q = pos;
        while (q < len && '?!.,:;*_\'"~)'.indexOf(u[q]) !== -1) q++;
        if (q >= len) break; // run reaches the end: stop before it
        pos = q;
        continue;
      }
      // Run of characters that are not in the punctuation set.
      let q = pos;
      while (q < len && '?!.,:;*_\'"~()&'.indexOf(u[q]) === -1) q++;
      pos = q;
    }
    u = u.slice(0, pos);
    if (u === before) return u;
  }
}

// Match a GFM extended autolink at src[i]: www., http(s)://, ftp://,
// mailto:/xmpp: email, or a bare email. Returns {end, text, href} or null.
function extLink(src, i, prevCh) {
  const rest = src.slice(i);
  // mailto: / xmpp: email
  let m = /^(?:mailto|xmpp):[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/.exec(rest);
  if (m) {
    const isXmpp = rest.startsWith('xmpp:');
    if (isXmpp) {
      const xm = /^xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?/.exec(rest);
      if (xm) return { end: i + xm[0].length, text: xm[0], href: xm[0] };
    }
    return { end: i + m[0].length, text: m[0], href: m[0] };
  }
  // scheme:// or www.
  m = /^(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/.exec(rest);
  if (m) {
    let u = trimTail(m[0]);
    if (u.length === 0) return null;
    const href = m[0].startsWith('www.') ? 'http://' + u : u;
    return { end: i + u.length, text: u, href };
  }
  // Bare email.
  m = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/.exec(rest);
  if (m) return { end: i + m[0].length, text: m[0], href: 'mailto:' + m[0] };
  return null;
}

// ============================ INLINE SCANNER ============================
//
// Node kinds from scanInline:
//  {t:'t', s}                  text (already HTML-escaped / entity-decoded)
//  {t:'d', c, n, open, close}  delimiter run ('*', '_' or '~')
//  {t:'c', s}                  code span (raw content; escaped at render)
//  {t:'l', href, title, img, kids, auto}  link or image (href pre-escaped)
//  {t:'h', s}                  raw HTML tag
//  {t:'n'}                     hard break
//  {t:'e'|'s'|'g', kids}       em / strong / del (built by resolveDelims)
//  {t:'p', kids}               plain group (a link whose href cannot be cleaned)

// Is there a non-whitespace character at or after src[i]?
function hasNonWS(src, i) {
  for (; i < src.length; i++) {
    const c = src[i];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\f' && c !== '\v') return true;
  }
  return false;
}

function isAlnumCh(c) {
  if (c === undefined || c === '') return false;
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isEmailLocalCh(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    c === '.' || c === '_' || c === '+' || c === '-';
}

// Case-insensitive ASCII prefix check (for http:// and ftp://).
function startsWithCI(src, j, prefix) {
  for (let k = 0; k < prefix.length; k++) {
    const ch = src.charCodeAt(j + k);
    if (Number.isNaN(ch) || (ch | 32) !== prefix.charCodeAt(k)) return false;
  }
  return true;
}

// Could a GFM extended autolink start at src[j]? The rule for the
// preceding character depends on the kind: scheme URLs (http://, https://,
// ftp://) linkify whatever precedes them; www. needs whitespace / * _ ~ (
// / start; mailto:/xmpp: need a non-alphanumeric before them; a bare
// email's local part must start here (the preceding char must not be an
// email character). extLink does the real validation.
// `mayEmail` is false when the scanned string holds no '@' at all, which
// rules out the bare-email branch without a regex test per word.
function extUrlStartsHere(src, j, mayEmail) {
  const c = src[j];
  const prev = j === 0 ? '' : src[j - 1];
  if ((c === 'h' || c === 'H') && (startsWithCI(src, j, 'http://') || startsWithCI(src, j, 'https://'))) {
    return extLink(src, j, prev) !== null;
  }
  if ((c === 'f' || c === 'F') && startsWithCI(src, j, 'ftp://')) {
    return extLink(src, j, prev) !== null;
  }
  if (c === 'w' && src.startsWith('www.', j) &&
      (j === 0 || prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(')) {
    return extLink(src, j, prev) !== null;
  }
  if (((c === 'm' && src.startsWith('mailto:', j)) || (c === 'x' && src.startsWith('xmpp:', j))) &&
      (j === 0 || !isAlnumCh(prev))) {
    return extLink(src, j, prev) !== null;
  }
  // Otherwise the character may start a bare email's local part.
  // (A sticky native regex replaces the per-char JS loop here.)
  if (mayEmail && isEmailLocalCh(c) && (j === 0 || !isEmailLocalCh(prev))) {
    EMAIL_START_RE.lastIndex = j;
    if (EMAIL_START_RE.test(src)) return extLink(src, j, prev) !== null;
  }
  return false;
}

// End of the plain-text run starting at src[i]: the first position where a
// non-text construct may start. Inside a raw span only `\` and `<` count.
function textStop(src, i, st, mayEmail) {
  const n = src.length;
  let j = i;
  if (st.inRaw) {
    while (j < n) {
      const c = src[j];
      if (c === '\\' || c === '<') break;
      j++;
    }
    return j;
  }
  const noLink = !st.inA;
  while (j < n) {
    const c = src[j];
    if (c === '\\' || c === '<') break;
    if (c === '[' || c === '`' || c === '*' || c === '_' || c === '~') break;
    if (c === '!' && src[j + 1] === '[') break;
    if (c === ' ' && src[j - 1] !== ' ') {
      let k = j;
      while (src[k] === ' ') k++;
      if (k - j >= 2 && src[k] === '\n' && hasNonWS(src, k + 1)) break;
    }
    if (noLink && (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'm' || c === 'x' ||
        (mayEmail && isEmailLocalCh(c) && (j === 0 || !isEmailLocalCh(src[j - 1])))) &&
        extUrlStartsHere(src, j, mayEmail)) break;
    j++;
  }
  return j;
}

// A link label has a "bad tick" when it contains a mismatched code span
// — a backtick run of length >= 2 closed by a run of a DIFFERENT length
// (e.g. [a ``b`](u): `` opens, ` closes) — AND that closing run is the
// LAST backtick run in the label. A further backtick run after the
// closing run breaks the effect ([less `` a ` b ``](w) does not
// suppress, but [a ``b`](u) does). A matched pair ([a ``b``](u)) or an
// unclosed run ([a x``y](u)) does not qualify. Such a link suppresses
// emphasis delimiters that follow it (see suppressBadTick).
function badTicks(label) {
  const runs = [];
  let i = 0;
  while (i < label.length) {
    if (label[i] === '`') {
      let j = i;
      while (label[j] === '`') j++;
      runs.push(j - i);
      i = j;
    } else {
      i++;
    }
  }
  for (let k = 0; k + 1 < runs.length; k++) {
    if (runs[k] >= 2 && runs[k + 1] !== runs[k] && k + 1 === runs.length - 1) return true;
  }
  return false;
}

// Attempt a link or image starting at src[i] ('[' or '![').
// Returns {node, end} or null. The label is parsed inline (with its own
// emphasis resolution); a nested link inside the label invalidates an
// outer link (but not an outer image).
function tryLink(src, i, st, parenOk) {
  const isImage = src[i] === '!';
  const labelStart = i + (isImage ? 2 : 1);
  const labelEndIdx = labelEnd(src, labelStart);
  if (labelEndIdx === -1) return null;
  const label = src.slice(labelStart, labelEndIdx);
  if (labelCrossesTag(src, labelStart, label)) return null;
  let after = labelEndIdx + 1;
  let href, title;
  if (src[after] === '(' && parenOk) {
    const dest = linkTarget(src, after + 1);
    if (dest) {
      href = unesc(dest.href);
      title = dest.title === undefined ? undefined : unesc(dest.title);
      after = dest.end;
    } else {
      // Not a valid inline link: fall back to a shortcut reference.
      const def = st.defs[foldLabel(label)];
      if (!def) return null;
      href = def.href;
      title = def.title;
    }
  } else if (src[after] === '[') {
    const refEnd = labelEnd(src, after + 1);
    if (refEnd === -1) return null;
    const ref = src.slice(after + 1, refEnd);
    const def = st.defs[foldLabel(ref.length === 0 ? label : ref)];
    if (!def) return null;
    href = def.href; // already unescaped by takeDef
    title = def.title;
    after = refEnd + 1;
  } else {
    const def = st.defs[foldLabel(label)];
    if (!def) return null;
    href = def.href;
    title = def.title;
  }
  const savedInA = st.inA, savedInRaw = st.inRaw;
  st.inA = true; // no bare-URL linkification inside a link label
  const kids = scanInline(label, st, parenOk && label.indexOf(')') !== -1);
  const hasLink = kids.some((k) => k.t === 'l' && !k.img && !k.auto);
  st.inA = savedInA;
  st.inRaw = savedInRaw;
  if (!isImage && hasLink) return null;
  resolveDelims(kids);
  unlinkEmail(kids);
  const clean = cleanHref(href);
  if (clean === null) return { node: { t: 'p', kids }, end: after };
  return {
    node: {
      t: 'l',
      href: esc(clean, false),
      title,
      img: isImage,
      kids,
      auto: false,
      badTick: badTicks(label),
    },
    end: after,
  };
}
// Fast path for inline strings with no inline constructs at all: no
// backslash, tag, code span, link bracket, delimiter run, image start,
// two-space hard break, or anything that could linkify (www., a scheme
// URL, mailto:/xmpp:, or a word with '@' in it). Such text renders as
// plain escaped text — or verbatim inside a raw span — without the
// scanner. The guards are supersets of the real constructs, so a false
// positive only costs speed, never correctness.
const PLAIN_GUARD = /[\\<`\[*_~]|!\[|  +\n|www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:|\S+@\S/i;
function plainHtml(text, st) {
  if (PLAIN_GUARD.test(text)) return null;
  if (st.inRaw) return text;
  return /[&<>"']/.test(text) ? esc(decodeNums(text), false) : text;
}

// Phase A: scan inline content into a flat node list (delimiter runs left
// unresolved for resolveDelims). `st` carries inA / inRaw.
function scanInline(src, st, parenOk) {
  const plain = plainHtml(src, st);
  if (plain !== null) return [{ t: 't', s: plain }];
  const nodes = [];
  const n = src.length;
  let i = 0;
  const mayEmail = src.indexOf('@') !== -1; // no '@' anywhere: no bare email can start
  let suppressUntil = -1; // end of a failed-link label: emphasis delimiters
  // inside it are literal text (marked swallows the label into a text
  // token when its label regex fails), though code spans still resolve.
  let buf = '';
  let r = ''; // last char of the previous text token ('' when it was not text)
  const flush = () => {
    if (buf.length === 0) return;
    nodes.push({ t: 't', s: buf });
    if (buf.charCodeAt(buf.length - 1) !== 95) r = buf[buf.length - 1]; // 95 = '_'
    buf = '';
  };
  const emit = (node) => { flush(); nodes.push(node); r = ''; };
  // Append a raw source run as finished text (entity-decoded, HTML-escaped),
  // or verbatim inside a raw span.
  const pushRaw = (run) => {
    if (run.length === 0) return;
    if (st.inRaw) { buf += run; return; }
    if (/[&<>"']/.test(run)) buf += esc(decodeNums(run), false);
    else buf += run;
  };
  // Append one backslash-escaped character as finished text.
  const pushEsc = (ch) => {
    if (st.inRaw) { buf += ch; return; }
    buf += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch;
  };
  while (i < n) {
    const c = src[i];
    // backslash escape (also inside raw spans)
    if (c === '\\' && i + 1 < n && ESCAPES.has(src[i + 1])) {
      pushEsc(src[i + 1]);
      i += 2;
      continue;
    }
    // hard break: backslash + newline, when content follows it
    if (!st.inRaw && c === '\\' && src[i + 1] === '\n' && hasNonWS(src, i + 2)) {
      emit({ t: 'n' });
      i += 2;
      while (src[i] === ' ' || src[i] === '\t') i++; // leading indent is dropped
      continue;
    }
    // a backslash that is neither an escape nor a hard break is literal
    if (c === '\\') { buf += '\\'; i++; continue; }
    // hard break: 2+ spaces + newline, when content follows it
    if (!st.inRaw && c === ' ') {
      let k = i;
      while (src[k] === ' ') k++;
      if (k - i >= 2 && src[k] === '\n' && hasNonWS(src, k + 1)) {
        emit({ t: 'n' });
        i = k + 1;
        while (src[i] === ' ' || src[i] === '\t') i++; // leading indent is dropped
        continue;
      }
    }
    // tag (also inside raw spans) / autolink
    if (c === '<') {
      const tagEnd = inlineTagEnd(src, i);
      if (tagEnd !== -1) {
        const tag = src.slice(i, tagEnd);
        if (!st.inA && /^<a /i.test(tag)) st.inA = true;
        else if (st.inA && /^<\/a\s*>/i.test(tag)) st.inA = false;
        if (!st.inRaw && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRaw = true;
        else if (st.inRaw && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRaw = false;
        emit({ t: 'h', s: tag });
        i = tagEnd;
        continue;
      }
      if (!st.inRaw) {
        const al = autoLink(src, i);
        if (al !== -1) {
          const href = cleanHref(al.href);
          if (href !== null) {
            emit({ t: 'l', href: esc(href, true), title: undefined, img: false, kids: [{ t: 't', s: esc(al.text, false) }], auto: true });
          } else {
            pushRaw(al.text);
          }
          i = al.end;
          continue;
        }
      }
      if (st.inRaw) buf += '<'; else buf += '&lt;';
      i++;
      continue;
    }
    if (st.inRaw) {
      const j = textStop(src, i, st, mayEmail);
      pushRaw(src.slice(i, j));
      i = j;
      continue;
    }
    // link / image
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const link = tryLink(src, i, st, parenOk);
      if (link) {
        emit(link.node);
        i = link.end;
        continue;
      }
      if (c === '!') { buf += '!'; i++; continue; }
      // The link did not form. If the LABEL itself is invalid (its
      // code span breaks the label regex) and a link was attempted
      // ('(' or '[' follows the label), the label's emphasis
      // delimiters are literal text — but only then; a bare '[label]'
      // with no dest still resolves its emphasis.
      if (labelEnd(src, i + 1) === -1) {
        const le = labelEndLoose(src, i + 1);
        if (le !== -1 && (src[le + 1] === '(' || src[le + 1] === '[')) {
          if (le > suppressUntil) suppressUntil = le;
        }
      }
      buf += '[';
      i++;
      continue;
    }
    // code span
    if (c === '`') {
      let m = i;
      while (src[m] === '`') m++;
      const runLen = m - i;
      const end = codeClose(src, i, runLen);
      if (end !== -1) {
        let content = src.slice(i + runLen, end - runLen).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) content = content.slice(1, -1);
        emit({ t: 'c', s: content });
        i = end;
        continue;
      }
      pushRaw(src.slice(i, m));
      i = m;
      continue;
    }
    // emphasis / strikethrough delimiter run
    if (c === '*' || c === '_' || c === '~') {
      let m = i;
      while (src[m] === c) m++;
      const runLen = m - i;
      if (i <= suppressUntil) {
        pushRaw(src.slice(i, m)); // inside a failed-link label: literal
        i = m;
        continue;
      }
      if (c === '~' && runLen >= 3) {
        pushRaw(src.slice(i, m)); // runs of 3+ tildes are literal text
        i = m;
        continue;
      }
      const next = src[m] || '';
      // The previous character for can-open is the last char of the
      // preceding text token, which may still be sitting in `buf`
      // (not yet flushed). A text token ending in '_' does not update it.
      const prevOpen = buf.length === 0 ? r : (buf.charCodeAt(buf.length - 1) === 95 ? r : buf[buf.length - 1]);
      const prevClose = i > 0 ? src[i - 1] : '';
      let open, close;
      if (c === '_') {
        open = mayOpen(prevOpen, next) && !(wordCh(next) && wordCh(prevOpen));
        close = mayClose(prevClose, next) && !(wordCh(prevClose) && wordCh(next));
      } else {
        open = mayOpen(prevOpen, next);
        close = mayClose(prevClose, next);
      }
      emit({ t: 'd', c, n: runLen, open, close, prev: i > 0 ? src[i - 1] : '', next: src[m] || '' });
      i = m;
      continue;
    }
    // GFM extended autolink (www. / http(s):// / ftp:// / email)
    if (!st.inA && extUrlStartsHere(src, i, mayEmail)) {
      const u = extLink(src, i, src[i - 1]);
      if (u) {
        const href = cleanHref(u.href);
        if (href !== null) {
          emit({ t: 'l', href: esc(href, true), title: undefined, img: false, kids: [{ t: 't', s: esc(u.text, false) }], auto: true });
        } else {
          pushRaw(u.text);
        }
        i = u.end;
        continue;
      }
    }
    // plain text run
    const j = textStop(src, i, st, mayEmail);
    if (j === i) { pushRaw(src[i]); i++; continue; } // safety: never stall
    pushRaw(src.slice(i, j));
    i = j;
  }
  flush();
  return nodes;
}

// Phase B: resolve delimiter runs in `nodes` (flat, from scanInline)
// into <em>/<strong>/<del> nodes, mutating `nodes` in place. Opener-driven
// forward scan: each opener looks forward for its closer, absorbing
// opener-only runs of the same character into the length it needs and
// skipping closers that fail the rule of 3 (if either delimiter can both
// open and close, the sum of the run lengths must not be a multiple of 3,
// unless both lengths are multiples of 3). If an opener of length n cannot
// be satisfied, it is retried with length n-1 (and so on), the dropped
// delimiters becoming literal text before the emphasis — this is how runs
// of unequal length are handled. The content between opener and closer —
// including leftover delimiters from either run — is resolved recursively.
// A closer's delimiters not consumed by the match stay behind as a fresh
// delimiter run to be resolved in turn.
function resolveDelims(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.t !== 'd' || node.n === 0 || !node.open) {
      if (node.t === 'd') nodes[i] = { t: 't', s: node.c.repeat(node.n) };
      i++;
      continue;
    }
    // Try effective opener lengths from node.n down to 1 (only for * and _;
    // a ~ closer must have exactly the opener's length).
    let matched = null, effLen = node.n;
    const minLen = node.c === '~' ? node.n : 1;
    while (effLen >= minLen) {
      const m = findCloser(nodes, i, effLen);
      if (m) { matched = m; break; }
      effLen--;
    }
    if (!matched) {
      nodes[i] = { t: 't', s: node.c.repeat(node.n) };
      i++;
      continue;
    }
    const closerIdx = matched.closerIdx;
    const closer = nodes[closerIdx];
    const use = matched.use;
    const closerUsed = matched.closerUsed;
    const kind = node.c === '~' ? 'g' : use === 2 ? 's' : 'e';
    const litBefore = node.n - effLen;
    // Content: leftover opener delimiters, the middle nodes, leftover
    // closer delimiters (from the consumed part of the closer run).
    const content = [];
    if (effLen > use) content.push({ t: 'd', c: node.c, n: effLen - use, open: node.open, close: node.close, prev: node.prev, next: node.next });
    for (let k = i + 1; k < closerIdx; k++) content.push(nodes[k]);
    if (closerUsed > use) content.push({ t: 'd', c: closer.c, n: closerUsed - use, open: closer.open, close: closer.close, prev: closer.prev, next: closer.next });
    resolveDelims(content);
    const seg = [];
    if (litBefore > 0) seg.push({ t: 't', s: node.c.repeat(litBefore) });
    seg.push({ t: kind, kids: content });
    const closerLeft = closer.n - closerUsed;
    if (closerLeft > 0) seg.push({ t: 'd', c: closer.c, n: closerLeft, open: closer.open, close: closer.close, prev: closer.prev, next: closer.next });
    nodes.splice(i, closerIdx - i + 1, ...seg);
    // If the closer left delimiters behind, resolve that run next;
    // otherwise move past the emphasis node.
    i = closerLeft > 0 ? i + seg.length - 1 : i + seg.length;
  }
}

// Whether a delimiter run can both open and close, by marked's RDelim
// classification (not bare flanking): (prev is punctuation and next is
// punctuation) or (prev is not-punctuation-not-space and next is
// not-punctuation-not-space). Falls back to the flanking flags when the
// adjacent characters were not recorded.
function delimBoth(d) {
  if (d.prev === undefined || d.next === undefined) return !!(d.open && d.close);
  const prev = d.prev, next = d.next;
  const prevP = prev !== '' && prev !== d.c && punctCh(prev);
  const nextP = next !== '' && next !== d.c && punctCh(next);
  const prevN = prev !== '' && prev !== d.c && !punctCh(prev) && !wsCh(prev);
  const nextN = next !== '' && next !== d.c && !punctCh(next) && !wsCh(next);
  return (prevP && nextP) || (prevN && nextN);
}

// Find the closer for the opener delimiter at nodes[oi], whose effective
// length is effLen, scanning forward. Returns {closerIdx, use, closerUsed}
// or null. `closerUsed` is how many of the closer run's delimiters the
// match consumes (the rest stay behind as a fresh run).
function findCloser(nodes, oi, effLen) {
  const op = nodes[oi];
  const c = op.c;
  if (c === '~') {
    // Strikethrough: the closer must have exactly the opener's length.
    // An opener-only run is absorbed only when its length equals the
    // opener's (a same-strength nested opener, e.g. ~~a ~~b~~ c~~).
    // A shorter opener-only run (the single ~ in ~~a ~b~ c~~) is a
    // separate nested opener resolved recursively in the content — it
    // must not be absorbed, or the outer ~~ would never find its closer.
    let need = effLen;
    for (let j = oi + 1; j < nodes.length; j++) {
      const d = nodes[j];
      if (d.t !== 'd' || d.c !== '~' || d.n === 0) continue;
      if (d.open && !d.close) { if (d.n === effLen) need += d.n; continue; }
      if (!d.close || d.n !== effLen) continue;
      need -= d.n;
      if (need <= 0) return { closerIdx: j, use: effLen, closerUsed: d.n };
    }
    return null;
  }
  let need = effLen;
  let free = 0;
  const other = c === '*' ? '_' : '*';
  let skipUntil = -1;
  for (let j = oi + 1; j < nodes.length; j++) {
    if (j <= skipUntil) continue;
    const d = nodes[j];
    if (d.t !== 'd' || d.n === 0) continue;
    // A run of >=2 of the OTHER character opens a strong: delimiters of
    // this character inside it are invisible to this opener (marked's
    // RDelim first alternative skips __...*...__ / **..._...**).
    if (d.c === other && d.n >= 2 && d.open) {
      for (let k = j + 1; k < nodes.length; k++) {
        const e = nodes[k];
        if (e.t === 'd' && e.c === other && e.n >= 2 && e.close) { skipUntil = k; break; }
      }
      continue;
    }
    if (d.c !== c) continue;
    if (d.open && !d.close) { need += d.n; continue; }
    if (!d.close) continue;
    const eitherBoth = delimBoth(op) || delimBoth(d);
    if (eitherBoth && (effLen + d.n) % 3 === 0 && !(effLen % 3 === 0 && d.n % 3 === 0)) {
      free += d.n;
      continue;
    }
    need -= d.n;
    if (need <= 0) {
      const closerUsed = Math.min(d.n, d.n + need + free);
      const m = Math.min(effLen, closerUsed);
      const use = m % 2 === 1 ? 1 : 2;
      return { closerIdx: j, use, closerUsed };
    }
  }
  return null;
}

// After emphasis is resolved, an email autolink immediately followed by
// a literal '_' or '-' must not have linked (GFM: the trailing _ / -
// makes the address ambiguous, so the whole address stays literal).
// But an email inside emphasis DOES link, because marked parses it
// inside the strong/em content where the delimiters are already
// consumed — so only unlink when the following '_' / '-' survived
// emphasis resolution as literal text. Unlinking renders the link's
// text with no <a> tag (a plain group).
function unlinkEmail(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.t === 'l' && n.auto && typeof n.href === 'string' && n.href.startsWith('mailto:')) {
      const next = nodes[i + 1];
      if (next && next.t === 't' && (next.s.charCodeAt(0) === 95 || next.s.charCodeAt(0) === 45)) {
        nodes[i] = { t: 'p', kids: n.kids };
      }
    } else if ((n.t === 'e' || n.t === 's' || n.t === 'g' || n.t === 'l' || n.t === 'p') && n.kids) {
      unlinkEmail(n.kids);
    }
  }
}

// Plain-text rendering of a node list (for image alt text): links and
// emphasis contribute their inner text, code spans their content.
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 't') out += node.s;
    else if (node.t === 'c') out += esc(node.s, true);
    else if (node.t === 'h') out += node.s;
    else if (node.t === 'n') out += '\n';
    else if (node.t === 'd') out += node.c.repeat(node.n);
    else if (node.t === 'e' || node.t === 's' || node.t === 'g' || node.t === 'p') out += plainText(node.kids);
    else if (node.t === 'l') out += plainText(node.kids);
  }
  return out;
}

// Render a resolved inline node list to HTML.
function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 't') out += node.s;
    else if (node.t === 'c') out += '<code>' + esc(node.s, true) + '</code>';
    else if (node.t === 'h') out += node.s;
    else if (node.t === 'n') out += '<br>';
    else if (node.t === 'd') out += node.c.repeat(node.n);
    else if (node.t === 'e') out += '<em>' + renderInline(node.kids) + '</em>';
    else if (node.t === 's') out += '<strong>' + renderInline(node.kids) + '</strong>';
    else if (node.t === 'g') out += '<del>' + renderInline(node.kids) + '</del>';
    else if (node.t === 'p') out += renderInline(node.kids);
    else if (node.t === 'l') {
      if (node.img) {
        let tag = '<img src="' + node.href + '" alt="' + plainText(node.kids) + '"';
        if (node.title !== undefined) tag += ' title="' + esc(node.title, false) + '"';
        out += tag + '>';
      } else {
        let tag = '<a href="' + node.href + '"';
        if (node.title !== undefined) tag += ' title="' + esc(node.title, false) + '"';
        out += tag + '>' + renderInline(node.kids) + '</a>';
      }
    }
  }
  return out;
}

// Parse one inline string (a paragraph / heading / table cell) to HTML.
// A link whose label has a mismatched double-backtick (badTick) suppresses
// emphasis delimiters (*, _, ~) that appear after the link and before a
// code span in the same inline content. (In marked the stray backticks
// confuse the delimiter scan, so such emphasis stays literal; emphasis
// after the code span, or with no code span after it, still forms.)
// Whether a node is, or contains (in a link label's kids), a code span.
function hasCode(node) {
  if (node.t === 'c') return true;
  if (node.kids) {
    for (const k of node.kids) if (hasCode(k)) return true;
  }
  return false;
}

function suppressBadTick(nodes) {
  let badIdx = -1;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].t === 'l' && nodes[i].badTick) { badIdx = i; break; }
  }
  if (badIdx === -1) return;
  let hasCodeAfter = false;
  for (let i = nodes.length - 1; i > badIdx; i--) {
    const n = nodes[i];
    if (hasCode(n)) hasCodeAfter = true;
    else if (n.t === 'd' && hasCodeAfter) { n.open = false; n.close = false; }
  }
}

function renderInlineStr(text, st) {
  const plain = plainHtml(text, st);
  if (plain !== null) return plain;
  const nodes = scanInline(text, st, text.indexOf(')') !== -1);
  suppressBadTick(nodes);
  resolveDelims(nodes);
  unlinkEmail(nodes);
  return renderInline(nodes);
}

// Walk the block token tree in document order, parsing every inline
// string. inA persists across the whole document; inRaw is reset
// before each inline string.
function resolveInline(tokens, st) {
  for (const tok of tokens) {
    if (tok.type === 'para' || tok.type === 'text') {
      st.inRaw = false;
      tok.html = renderInlineStr(tok.text, st);
      if (tok.checkbox) {
        tok.html = (tok.checkbox.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ') + tok.html;
      }
    } else if (tok.type === 'head') {
      st.inRaw = false;
      tok.html = renderInlineStr(tok.text, st);
    } else if (tok.type === 'table') {
      for (const cell of tok.header) { st.inRaw = false; cell.html = renderInlineStr(cell.text, st); }
      for (const row of tok.rows) for (const cell of row) { st.inRaw = false; cell.html = renderInlineStr(cell.text, st); }
    } else if (tok.type === 'quote' || tok.type === 'item') {
      resolveInline(tok.tokens, st);
    } else if (tok.type === 'list') {
      for (const item of tok.items) resolveInline(item.tokens, st);
    }
  }
}

// Render the block token tree to HTML.
function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    if (tok.type === 'blank') continue;
    if (tok.type === 'code') {
      const lang = tok.lang ? tok.lang.split(/\s+/)[0] : '';
      let text = tok.text;
      if (text.length > 0 && !text.endsWith('\n')) text += '\n';
      out += '<pre><code' + (lang ? ' class="language-' + esc(lang, false) + '"' : '') + '>' + esc(text, true) + '</code></pre>\n';
      continue;
    }
    if (tok.type === 'head') { out += '<h' + tok.depth + '>' + tok.html + '</h' + tok.depth + '>\n'; continue; }
    if (tok.type === 'hr') { out += '<hr>\n'; continue; }
    if (tok.type === 'quote') { out += '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n'; continue; }
    if (tok.type === 'list') {
      const tag = tok.ordered ? 'ol' : 'ul';
      out += '<' + tag + (tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '') + '>\n';
      for (const item of tok.items) out += renderBlocks([item]);
      out += '</' + tag + '>\n';
      continue;
    }
    if (tok.type === 'item') { out += '<li>' + renderBlocks(tok.tokens) + '</li>\n'; continue; }
    if (tok.type === 'check') {
      out += tok.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
      continue;
    }
    if (tok.type === 'html') { out += tok.text; continue; }
    if (tok.type === 'def') continue;
    if (tok.type === 'para') { out += '<p>' + tok.html + '</p>\n'; continue; }
    if (tok.type === 'text') { out += tok.html; continue; }
    if (tok.type === 'table') {
      out += '<table>\n<thead>\n<tr>\n';
      for (const cell of tok.header) out += '<th' + (cell.align ? ' align="' + cell.align + '"' : '') + '>' + cell.html + '</th>\n';
      out += '</tr>\n</thead>\n';
      if (tok.rows.length > 0) {
        out += '<tbody>';
        for (const row of tok.rows) {
          out += '<tr>\n';
          for (const cell of row) out += '<td' + (cell.align ? ' align="' + cell.align + '"' : '') + '>' + cell.html + '</td>\n';
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      continue;
    }
  }
  return out;
}

// Entry point: render a Markdown document to HTML, exactly as marked
// 18.1.3 does with its default options (GFM on, breaks off).
export function parse(markdown) {
  const src = markdown.indexOf('\r') === -1 ? markdown : markdown.replace(/\r\n?/g, '\n');
  const st = newState();
  const tokens = lex(src, [], st, false);
  resolveInline(tokens, st);
  return renderBlocks(tokens);
}
